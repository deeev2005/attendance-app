const express = require('express');
const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const https = require('https');

const app = express();
app.use(express.json());

// Initialize Firebase Admin using secret file
let serviceAccount;
try {
  const secretPath = path.join(__dirname, 'serviceAccountKey.json');
  serviceAccount = JSON.parse(fs.readFileSync(secretPath, 'utf8'));
  console.log('✅ Firebase service account loaded from file');
} catch (error) {
  console.error('❌ Error loading serviceAccountKey.json:', error.message);
  process.exit(1);
}

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

// ✅ Get current IST date properly
function getISTDate() {
  const now = new Date();
  const istOffset = 5.5 * 60 * 60 * 1000; // +5:30 hrs
  const utcTime = now.getTime() + (now.getTimezoneOffset() * 60 * 1000);
  return new Date(utcTime + istOffset);
}

// ✅ Utility: Calculate distance between coordinates (in meters)
function calculateDistance(lat1, lon1, lat2, lon2) {
  const R = 6371e3;
  const φ1 = lat1 * Math.PI / 180;
  const φ2 = lat2 * Math.PI / 180;
  const Δφ = (lat2 - lat1) * Math.PI / 180;
  const Δλ = (lon2 - lon1) * Math.PI / 180;
  const a =
    Math.sin(Δφ / 2) ** 2 +
    Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

// ==================================================================
// 🔁 LISTENER FOR LOCATIONS (attendance marking with auto subject detection)
// ==================================================================
db.collection('locations').onSnapshot(async (snapshot) => {
  snapshot.docChanges().forEach(async (change) => {
    if (change.type === 'added') {
      const data = change.doc.data();
      const { uid, latitude, longitude, dataType } = data;
      
      // Check if it's a location_request type
      if (!uid || !latitude || !longitude || dataType !== 'location_request') return;

      console.log(`📍 New location received for ${uid}`);

      // Get current IST time
      const istDate = getISTDate();
      const currentDay = istDate.toLocaleString('en-US', { weekday: 'long' }).toLowerCase();
      const currentTime = istDate.toTimeString().split(' ')[0]; // HH:MM:SS
      const [currentHour, currentMinute] = currentTime.split(':').map(Number);

      // Find which subject just ended for this user
      const subjectsSnapshot = await db.collection('users').doc(uid).collection('subjects').get();
      
      let matchedSubjectId = null;
      let matchedSubjectData = null;

      for (const subjectDoc of subjectsSnapshot.docs) {
        const subjectData = subjectDoc.data();
        const schedule = subjectData.schedule || {};

        const matchingDayKey = Object.keys(schedule).find(
          key => key.toLowerCase() === currentDay
        );
        if (!matchingDayKey) continue;

        let endTime;
        const scheduleEntry = schedule[matchingDayKey];
        if (Array.isArray(scheduleEntry) && scheduleEntry.length > 0) {
          endTime = scheduleEntry[0].end;
        } else if (scheduleEntry && scheduleEntry.end) {
          endTime = scheduleEntry.end;
        }

        if (!endTime) continue;

        const [endH, endM] = endTime.split(':').map(Number);

        // Check if this class just ended (within 10 minutes window)
        const timeDiffMinutes = (currentHour * 60 + currentMinute) - (endH * 60 + endM);
        
        if (timeDiffMinutes >= 0 && timeDiffMinutes <= 10) {
          matchedSubjectId = subjectDoc.id;
          matchedSubjectData = subjectData;
          break;
        }
      }

      if (!matchedSubjectId || !matchedSubjectData) {
        console.log(`❌ No matching subject found for ${uid} at current time`);
        return;
      }

      console.log(`✅ Matched subject: ${matchedSubjectId} for ${uid}`);

      const classLat = matchedSubjectData.location?.latitude;
      const classLon = matchedSubjectData.location?.longitude;
      const accuracyThreshold = 30;

      if (!classLat || !classLon) {
        console.log(`❌ No location set for subject ${matchedSubjectId}`);
        return;
      }

      const distance = calculateDistance(latitude, longitude, classLat, classLon);
      const dayNumber = istDate.getDate();
      const monthName = istDate.toLocaleString('en-US', { month: 'long', timeZone: 'Asia/Kolkata' }).toLowerCase();
      const year = istDate.getFullYear();
      const monthYear = `${monthName} ${year}`;

      const attendanceRef = db.collection('users')
        .doc(uid)
        .collection('subjects')
        .doc(matchedSubjectId)
        .collection('attendance')
        .doc(monthYear);

      const attendanceDoc = await attendanceRef.get();
      const attendanceData = attendanceDoc.exists ? attendanceDoc.data() : {};
      const presentDays = attendanceData.present || [];
      const absentDays = attendanceData.absent || [];

      if (!presentDays.includes(dayNumber) && !absentDays.includes(dayNumber)) {
        if (distance <= accuracyThreshold) {
          await attendanceRef.set({
            present: admin.firestore.FieldValue.arrayUnion(dayNumber)
          }, { merge: true });
          console.log(`✅ Marked PRESENT for ${uid}, subject ${matchedSubjectId} (distance: ${Math.round(distance)}m)`);
          
          // Save to notification collection
          await db.collection('notification').add({
            uid: uid,
            subjectId: matchedSubjectId,
            dateTime: admin.firestore.FieldValue.serverTimestamp(),
            status: 'present'
          });
          
        } else {
          await attendanceRef.set({
            absent: admin.firestore.FieldValue.arrayUnion(dayNumber)
          }, { merge: true });
          console.log(`❌ Marked ABSENT for ${uid}, subject ${matchedSubjectId} (distance: ${Math.round(distance)}m)`);
          
          // Save to notification collection
          await db.collection('notification').add({
            uid: uid,
            subjectId: matchedSubjectId,
            dateTime: admin.firestore.FieldValue.serverTimestamp(),
            status: 'absent'
          });
          
        }
      } else {
        console.log(`⚠️ Attendance already marked for ${uid} on day ${dayNumber}`);
      }
    }
  });
});

// ==================================================================
// 🧭 CLASS SCANNING & SCHEDULE CREATION
// ==================================================================
async function scanAndQueueClasses() {
  const istDate = getISTDate();
  const currentDay = istDate.toLocaleString('en-US', { weekday: 'long' }).toLowerCase();
  const timeString = istDate.toTimeString().split(' ')[0];
  console.log(`\n🔍 Scanning for classes on ${currentDay} - ${timeString}`);

  const usersSnapshot = await db.collection('users').get();

  for (const userDoc of usersSnapshot.docs) {
    const userId = userDoc.id;
    const subjectsSnapshot = await db.collection('users').doc(userId).collection('subjects').get();

    for (const subjectDoc of subjectsSnapshot.docs) {
      const subjectId = subjectDoc.id;
      const subjectData = subjectDoc.data();
      
      // ✅ Check if automatic field is 'yes'
      const automatic = subjectData.automatic;
      if (automatic !== 'yes') {
        console.log(`⏭️ Skipping ${userId} - ${subjectId} (automatic: ${automatic})`);
        continue;
      }
      
      // ✅ Check if location field exists and is not empty
      const location = subjectData.location;
      if (!location || !location.latitude || !location.longitude) {
        continue;
      }
      
      const schedule = subjectData.schedule || {};

      const matchingDayKey = Object.keys(schedule).find(
        key => key.toLowerCase() === currentDay
      );
      if (!matchingDayKey) continue;

      let startTime, endTime;
      const scheduleEntry = schedule[matchingDayKey];
      if (Array.isArray(scheduleEntry) && scheduleEntry.length > 0) {
        startTime = scheduleEntry[0].start;
        endTime = scheduleEntry[0].end;
      } else if (scheduleEntry && scheduleEntry.start) {
        startTime = scheduleEntry.start;
        endTime = scheduleEntry.end;
      }

      if (!startTime || !endTime) continue;

      const [startH, startM] = startTime.split(':').map(Number);
      const [endH, endM] = endTime.split(':').map(Number);

      // ✅ CHANGED: Calculate middle time of the class
      const classStart = new Date(istDate);
      classStart.setHours(startH, startM, 0, 0);
      
      const classEnd = new Date(istDate);
      classEnd.setHours(endH, endM, 0, 0);
      
      const middleTime = new Date((classStart.getTime() + classEnd.getTime()) / 2);

      const existingSchedule = await db.collection('schedule')
        .where('userId', '==', userId)
        .where('subjectId', '==', subjectId)
        .where('date', '==', istDate.toDateString())
        .get();

      if (!existingSchedule.empty) continue;

      await db.collection('schedule').add({
        userId,
        subjectId,
        timestamp: `timestamp${middleTime.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}`,
        endTime: admin.firestore.Timestamp.fromDate(middleTime),
        date: istDate.toDateString()
      });

      console.log(`🗓️ Added to schedule: ${userId} - ${subjectId} @ ${middleTime.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}`);
    }
  }
}

// ==================================================================
// 👂 OBSERVE SCHEDULE COLLECTION & SEND FCM AT END TIME (ONLY ONCE)
// ==================================================================
db.collection('schedule').onSnapshot(async (snapshot) => {
  snapshot.docChanges().forEach(async (change) => {
    if (change.type === 'added') {
      const data = change.doc.data();
      const { userId, subjectId, endTime } = data;
      if (!userId || !subjectId || !endTime) return;

      // ✅ FIX: Get current IST time for comparison
      const now = getISTDate();
      const endDate = endTime.toDate();
      const diff = endDate.getTime() - now.getTime();
      
      if (diff <= 0) {
        console.log(`⏭️ Skipping past class ${subjectId} for ${userId} (already ended)`);
        return;
      }

      console.log(`🕒 FCM will be sent exactly at middle of class ${subjectId} for ${userId} (in ${Math.round(diff / 60000)} mins)`);

      // Send FCM exactly at end time (only one FCM)
      setTimeout(async () => {
        await sendLocationRequest(userId);
      }, diff);
    }
  });
});

// ==================================================================
// 🚀 Send FCM (NEW METHOD using googleapis)
// ==================================================================
async function sendLocationRequest(userId) {
  try {
    const userDoc = await db.collection('users').doc(userId).get();
    if (!userDoc.exists) return;

    const fcmToken = userDoc.data().fcmToken;
    if (!fcmToken) {
      console.log(`❌ No FCM token for user ${userId}`);
      return;
    }

    console.log('🔄 Getting access token...');
    
    // Get access token using googleapis
    const jwtClient = new google.auth.JWT({
      email: serviceAccount.client_email,
      key: serviceAccount.private_key,
      scopes: ['https://www.googleapis.com/auth/firebase.messaging']
    });
    
    const tokens = await jwtClient.authorize();
    console.log('✅ Access token obtained');

    // Prepare FCM message
    const message = {
      message: {
        token: fcmToken,
        data: {
          type: 'location_request'
        },
        android: {
          priority: 'high'
        }
      }
    };

    console.log('📤 Sending notification...');

    // Send request
    const data = JSON.stringify(message);
    const options = {
      hostname: 'fcm.googleapis.com',
      port: 443,
      path: `/v1/projects/${serviceAccount.project_id}/messages:send`,
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${tokens.access_token}`,
        'Content-Type': 'application/json',
        'Content-Length': data.length
      }
    };

    const req = https.request(options, (res) => {
      let responseData = '';
      
      res.on('data', (chunk) => {
        responseData += chunk;
      });
      
      res.on('end', () => {
        if (res.statusCode === 200) {
          console.log(`✅ FCM sent successfully to ${userId}`);
        } else {
          console.log(`❌ FCM Error Status: ${res.statusCode}, Response: ${responseData}`);
        }
      });
    });

    req.on('error', (error) => {
      console.error(`❌ FCM Request failed for ${userId}:`, error.message);
    });

    req.write(data);
    req.end();

  } catch (err) {
    console.error(`❌ Error sending FCM to ${userId}:`, err.message);
  }
}

// ==================================================================
// 🩺 Health Check & Ping
// ==================================================================
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timeIST: getISTDate().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }) });
});
app.get('/ping', (req, res) => res.status(200).send('OK'));

// ==================================================================
// 📍 Submit Location API
// ==================================================================
app.post('/submit-location', async (req, res) => {
  try {
    const { userId, subjectId, latitude, longitude } = req.body;
    if (!userId || !subjectId || !latitude || !longitude)
      return res.status(400).json({ error: 'Missing required fields' });

    await db.collection('locations').add({
      userId,
      subjectId,
      latitude,
      longitude,
      timestamp: admin.firestore.FieldValue.serverTimestamp()
    });

    console.log(`✅ Location stored for ${userId}, ${subjectId}`);
    res.json({ success: true });
  } catch (e) {
    console.error('❌ Error storing location:', e);
    res.status(500).json({ error: 'Failed to store location' });
  }
});

// ==================================================================
// 🚀 SERVER START
// ==================================================================
const PORT = process.env.PORT || 10000;
app.listen(PORT, async () => {
  console.log('🚀 Starting server...');
  console.log('🇮🇳 Using Indian Standard Time (IST)');
  await scanAndQueueClasses(); // initial scan
  console.log(`✅ Server running on port ${PORT}`);
});

setInterval(scanAndQueueClasses, 60 * 1000);
