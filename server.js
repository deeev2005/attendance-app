const express = require('express');
const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');

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

// ✅ FIXED: Get current IST date properly
function getISTDate() {
  const now = new Date();
  // Convert to IST by adding 5 hours 30 minutes offset
  const istOffset = 5.5 * 60 * 60 * 1000; // IST is UTC+5:30
  const utcTime = now.getTime() + (now.getTimezoneOffset() * 60 * 1000);
  return new Date(utcTime + istOffset);
}

// Utility: Calculate distance between coordinates (in meters)
function calculateDistance(lat1, lon1, lat2, lon2) {
  const R = 6371e3;
  const φ1 = lat1 * Math.PI / 180;
  const φ2 = lat2 * Math.PI / 180;
  const Δφ = (lat2 - lat1) * Math.PI / 180;
  const Δλ = (lon2 - lon1) * Math.PI / 180;

  const a =
    Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
    Math.cos(φ1) * Math.cos(φ2) *
    Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

// ==================================================================
// 🟢 REALTIME LISTENER FOR LOCATIONS COLLECTION
// ==================================================================
db.collection('locations').onSnapshot(async (snapshot) => {
  snapshot.docChanges().forEach(async (change) => {
    if (change.type === 'added') {
      const data = change.doc.data();
      const { userId, subjectId, latitude, longitude } = data;

      if (!userId || !subjectId || !latitude || !longitude) {
        console.log('⚠️ Missing required fields in new location entry');
        return;
      }

      console.log(`📍 New location received for ${userId}, subject ${subjectId}`);

      // Fetch subject info
      const subjectDoc = await db
        .collection('users')
        .doc(userId)
        .collection('subjects')
        .doc(subjectId)
        .get();

      if (!subjectDoc.exists) {
        console.log(`⚠️ Subject not found for user ${userId}`);
        return;
      }

      const subjectData = subjectDoc.data();
      const classLat = subjectData.location?.latitude;
      const classLon = subjectData.location?.longitude;
      const accuracyThreshold = subjectData.location?.accuracy || 50;

      if (!classLat || !classLon) {
        console.log(`⚠️ No class location set for subject ${subjectId}`);
        return;
      }

      const distance = calculateDistance(latitude, longitude, classLat, classLon);
      const istDate = getISTDate();
      const dayNumber = istDate.getDate();
      const monthName = istDate.toLocaleString('en-US', { month: 'long', timeZone: 'Asia/Kolkata' }).toLowerCase();
      const year = istDate.getFullYear();
      const monthYear = `${monthName} ${year}`;

      const attendanceRef = db
        .collection('users')
        .doc(userId)
        .collection('subjects')
        .doc(subjectId)
        .collection('attendance')
        .doc(monthYear);

      // Fetch current attendance first
      const attendanceDoc = await attendanceRef.get();
      const attendanceData = attendanceDoc.exists ? attendanceDoc.data() : {};
      const presentDays = attendanceData.present || [];
      const absentDays = attendanceData.absent || [];

      // Only mark if day not already marked
      if (!presentDays.includes(dayNumber) && !absentDays.includes(dayNumber)) {
        if (distance <= accuracyThreshold) {
          await attendanceRef.set({
            present: admin.firestore.FieldValue.arrayUnion(dayNumber)
          }, { merge: true });
          console.log(`✅ Marked PRESENT for ${userId}, subject ${subjectId} (Day ${dayNumber})`);
        } else {
          await attendanceRef.set({
            absent: admin.firestore.FieldValue.arrayUnion(dayNumber)
          }, { merge: true });
          console.log(`❌ Marked ABSENT for ${userId}, subject ${subjectId} (Day ${dayNumber})`);
        }
      } else {
        console.log(`ℹ️ Attendance already marked for ${userId}, subject ${subjectId} (Day ${dayNumber})`);
      }
    }
  });
});

// ==================================================================
// 🧭 SCAN CLASSES & STORE IN SCHEDULE COLLECTION
// ==================================================================
async function scanAndStoreSchedule() {
  const istDate = getISTDate();
  const dayNames = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const currentDay = dayNames[istDate.getDay()];
  const timeString = istDate.toTimeString().split(' ')[0];
  console.log(`\n🔍 Scanning for classes on ${currentDay} - ${timeString}`);

  const usersSnapshot = await db.collection('users').get();
  let totalStored = 0;

  for (const userDoc of usersSnapshot.docs) {
    const userId = userDoc.id;
    const subjectsRef = db.collection('users').doc(userId).collection('subjects');
    const subjectsSnapshot = await subjectsRef.get();

    for (const subjectDoc of subjectsSnapshot.docs) {
      const subjectId = subjectDoc.id;
      const subjectData = subjectDoc.data();
      const schedule = subjectData.schedule || {};

      // ✅ Case-insensitive match for day name
      const matchingDayKey = Object.keys(schedule).find(
        key => key.toLowerCase() === currentDay
      );

      if (matchingDayKey) {
        let startTime, endTime;

        // ✅ Handle array or object schedule format
        const scheduleEntry = schedule[matchingDayKey];
        if (Array.isArray(scheduleEntry) && scheduleEntry.length > 0) {
          startTime = scheduleEntry[0].start;
          endTime = scheduleEntry[0].end;
        } else if (scheduleEntry && scheduleEntry.start) {
          startTime = scheduleEntry.start;
          endTime = scheduleEntry.end;
        }

        if (!startTime || !endTime) {
          console.log(`⚠️ No valid start/end time found for ${subjectId} on ${matchingDayKey}`);
          continue;
        }

        // ✅ Calculate middle of the class
        const [startHours, startMinutes] = startTime.split(':').map(Number);
        const [endHours, endMinutes] = endTime.split(':').map(Number);
        
        const classStart = new Date(istDate);
        classStart.setHours(startHours, startMinutes, 0, 0);
        
        const classEnd = new Date(istDate);
        classEnd.setHours(endHours, endMinutes, 0, 0);
        
        const middleTime = new Date((classStart.getTime() + classEnd.getTime()) / 2);

        // ✅ Create unique document ID to prevent duplicates
        const scheduleDocId = `${userId}_${subjectId}_${istDate.toDateString()}`;

        // ✅ Check if already exists in schedule collection
        const existingSchedule = await db.collection('schedule').doc(scheduleDocId).get();

        if (!existingSchedule.exists) {
          // ✅ Store in schedule collection
          await db.collection('schedule').doc(scheduleDocId).set({
            userId: userId,
            subjectId: subjectId,
            timestamp: admin.firestore.Timestamp.now(),
            middleTime: admin.firestore.Timestamp.fromDate(middleTime)
          });

          console.log(`📅 Stored schedule for ${userId}, subject ${subjectId}, middle time: ${middleTime.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}`);
          totalStored++;
        }
      }
    }
  }

  console.log(`📊 Summary: ${totalStored} new schedules stored`);
}

// ==================================================================
// 🟢 REALTIME LISTENER FOR SCHEDULE COLLECTION
// ==================================================================
db.collection('schedule').onSnapshot(async (snapshot) => {
  snapshot.docChanges().forEach(async (change) => {
    if (change.type === 'added') {
      const data = change.doc.data();
      const { userId, subjectId, middleTime } = data;

      if (!userId || !subjectId || !middleTime) {
        console.log('⚠️ Missing required fields in schedule entry');
        return;
      }

      const middleTimeDate = middleTime.toDate();
      const now = getISTDate();
      const timeDiff = middleTimeDate.getTime() - now.getTime();

      // ✅ Only schedule if middle time is in the future
      if (timeDiff > 0) {
        console.log(`🕒 Scheduling FCM for ${userId}, subject ${subjectId} in ${Math.round(timeDiff / 60000)} mins`);

        setTimeout(async () => {
          console.log(`\n📋 Triggering FCM for user ${userId}, subject ${subjectId}`);
          await sendLocationRequest(userId, subjectId);
        }, timeDiff);
      } else {
        console.log(`⏭️ Middle time already passed for ${userId}, subject ${subjectId}`);
      }
    }
  });
});

// Function for sending FCM (Silent/Invisible notification)
async function sendLocationRequest(userId, subjectId) {
  console.log(`🚀 Sending FCM to request location for ${userId}, subject ${subjectId}`);
  
  try {
    // Get user's FCM token from Firestore
    const userDoc = await db.collection('users').doc(userId).get();
    
    if (!userDoc.exists) {
      console.log(`❌ User ${userId} not found`);
      return;
    }

    const userData = userDoc.data();
    const fcmToken = userData.fcmToken;

    if (!fcmToken) {
      console.log(`❌ No FCM token found for user ${userId}`);
      return;
    }

    // ✅ Send SILENT FCM notification (no notification field, only data)
    const message = {
      token: fcmToken,
      data: {
        type: 'LOCATION_REQUEST',
        userId: userId,
        subjectId: subjectId,
        timestamp: Date.now().toString()
      },
      android: {
        priority: 'high'
      },
      apns: {
        headers: {
          'apns-priority': '10'
        },
        payload: {
          aps: {
            contentAvailable: true
          }
        }
      }
    };

    const response = await admin.messaging().send(message);
    console.log(`✅ FCM sent successfully to ${userId}:`, response);
  } catch (error) {
    console.error(`❌ Error sending FCM to ${userId}:`, error.message);
  }
}

// ==================================================================
// 🩺 HEALTH CHECK & CRON JOB ENDPOINTS
// ==================================================================
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timeIST: getISTDate().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })
  });
});

// 🟢 Added ping route for cron job
app.get('/ping', (req, res) => {
  res.status(200).send('OK');
});

// ==================================================================
// 📍 NEW ENDPOINT: Submit Location from Mobile App
// ==================================================================
app.post('/submit-location', async (req, res) => {
  try {
    const { userId, subjectId, latitude, longitude } = req.body;

    if (!userId || !subjectId || !latitude || !longitude) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Store location in Firestore
    await db.collection('locations').add({
      userId,
      subjectId,
      latitude,
      longitude,
      timestamp: admin.firestore.FieldValue.serverTimestamp()
    });

    console.log(`✅ Location stored for user ${userId}, subject ${subjectId}`);
    res.json({ success: true, message: 'Location submitted successfully' });
  } catch (error) {
    console.error('❌ Error storing location:', error);
    res.status(500).json({ error: 'Failed to store location' });
  }
});

// ==================================================================
// 🚀 SERVER STARTUP
// ==================================================================
const PORT = process.env.PORT || 10000;
app.listen(PORT, async () => {
  console.log('🚀 Starting server...');
  console.log('🇮🇳 Using Indian Standard Time (IST)');
  await scanAndStoreSchedule();
  console.log(`🚀 Server running on port ${PORT}`);
  console.log('👂 Listening to Firestore "locations" collection for new entries...');
  console.log('👂 Listening to Firestore "schedule" collection for FCM triggers...');
});

// 🕒 Scan for scheduled classes every 1 minute
setInterval(scanAndStoreSchedule, 60 * 1000);
