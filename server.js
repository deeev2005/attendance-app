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
      const accuracyThreshold = matchedSubjectData.location?.accuracy || 50;

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
          
          // Create record for present
          await db.collection('records').add({
            userId: uid,
            subjectId: matchedSubjectId,
            date: istDate.toDateString(),
            status: 'present',
            dayNumber: dayNumber,
            monthYear: monthYear,
            timestamp: admin.firestore.FieldValue.serverTimestamp()
          });
        } else {
          await attendanceRef.set({
            absent: admin.firestore.FieldValue.arrayUnion(dayNumber)
          }, { merge: true });
          console.log(`❌ Marked ABSENT for ${uid}, subject ${matchedSubjectId} (distance: ${Math.round(distance)}m)`);
          
          // Create record for absent
          await db.collection('records').add({
            userId: uid,
            subjectId: matchedSubjectId,
            date: istDate.toDateString(),
            status: 'absent',
            dayNumber: dayNumber,
            monthYear: monthYear,
            timestamp: admin.firestore.FieldValue.serverTimestamp()
          });
        }
      } else {
        console.log(`⚠️ Attendance already marked for ${uid} on day ${dayNumber}`);
      }
    }
  });
});

// ==================================================================
// 👂 LISTENER FOR RECORDS COLLECTION - SEND NOTIFICATIONS
// ==================================================================
db.collection('records').onSnapshot(async (snapshot) => {
  snapshot.docChanges().forEach(async (change) => {
    if (change.type === 'added') {
      const recordData = change.doc.data();
      const { userId, subjectId, date, status, dayNumber, monthYear } = recordData;
      
      if (!userId || !subjectId || !date || !status) return;

      console.log(`📝 New record: ${status} for ${userId} - ${subjectId}`);

      try {
        // Get user data for FCM token and ad data
        const userDoc = await db.collection('users').doc(userId).get();
        if (!userDoc.exists) return;

        const userData = userDoc.data();
        const fcmToken = userData.fcmToken;
        const image3 = userData.image_3 || '';
        const link3 = userData.link_3 || '';

        if (!fcmToken) {
          console.log(`❌ No FCM token for user ${userId}`);
          return;
        }

        // Get subject name
        const subjectDoc = await db.collection('users').doc(userId).collection('subjects').doc(subjectId).get();
        if (!subjectDoc.exists) return;

        const subjectName = subjectDoc.data().subjectName || 'Subject';

        // Send notification based on status
        if (status === 'present') {
          await sendPresentNotification(fcmToken, subjectName, date, image3, link3, userId, subjectId, dayNumber, monthYear);
        } else if (status === 'absent') {
          await sendAbsentNotification(fcmToken, subjectName, date, image3, link3, userId, subjectId, dayNumber, monthYear);
        }

      } catch (err) {
        console.error(`❌ Error processing record:`, err.message);
      }
    }
  });
});

// ==================================================================
// 🚀 Send Present Notification
// ==================================================================
async function sendPresentNotification(fcmToken, subjectName, date, image3, link3, userId, subjectId, dayNumber, monthYear) {
  try {
    console.log('🔄 Getting access token for present notification...');
    
    const jwtClient = new google.auth.JWT({
      email: serviceAccount.client_email,
      key: serviceAccount.private_key,
      scopes: ['https://www.googleapis.com/auth/firebase.messaging']
    });
    
    const tokens = await jwtClient.authorize();

    // Build message object with only valid fields
    const message = {
      message: {
        token: fcmToken,
        notification: {
          title: 'Marked Present ✅',
          body: `Attendance marked present for ${subjectName} on ${date}`
        },
        data: {
          type: 'attendance_marked',
          status: 'present',
          subjectId: subjectId,
          userId: userId,
          dayNumber: dayNumber.toString(),
          monthYear: monthYear
        },
        android: {
          priority: 'high'
        }
      }
    };

    // Add image only if it exists and is valid
    if (image3 && image3.trim() !== '') {
      message.message.notification.image = image3;
      message.message.apns = {
        payload: {
          aps: {
            'mutable-content': 1,
            category: 'ATTENDANCE_PRESENT'
          }
        },
        fcm_options: {
          image: image3
        }
      };
    }

    // Add clickAction only if it exists and is valid
    if (link3 && link3.trim() !== '') {
      message.message.data.clickAction = link3;
    }

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
          console.log(`✅ Present notification sent to ${userId}`);
        } else {
          console.log(`❌ Notification Error Status: ${res.statusCode}, Response: ${responseData}`);
        }
      });
    });

    req.on('error', (error) => {
      console.error(`❌ Notification Request failed:`, error.message);
    });

    req.write(data);
    req.end();

  } catch (err) {
    console.error(`❌ Error sending present notification:`, err.message);
  }
}

// ==================================================================
// 🚀 Send Absent Notification
// ==================================================================
async function sendAbsentNotification(fcmToken, subjectName, date, image3, link3, userId, subjectId, dayNumber, monthYear) {
  try {
    console.log('🔄 Getting access token for absent notification...');
    
    const jwtClient = new google.auth.JWT({
      email: serviceAccount.client_email,
      key: serviceAccount.private_key,
      scopes: ['https://www.googleapis.com/auth/firebase.messaging']
    });
    
    const tokens = await jwtClient.authorize();

    // Build message object with only valid fields
    const message = {
      message: {
        token: fcmToken,
        notification: {
          title: 'Marked Absent ❌',
          body: `Attendance marked absent for ${subjectName} on ${date}`
        },
        data: {
          type: 'attendance_marked',
          status: 'absent',
          subjectId: subjectId,
          userId: userId,
          dayNumber: dayNumber.toString(),
          monthYear: monthYear
        },
        android: {
          priority: 'high'
        }
      }
    };

    // Add image only if it exists and is valid
    if (image3 && image3.trim() !== '') {
      message.message.notification.image = image3;
      message.message.apns = {
        payload: {
          aps: {
            'mutable-content': 1,
            category: 'ATTENDANCE_ABSENT'
          }
        },
        fcm_options: {
          image: image3
        }
      };
    }

    // Add clickAction only if it exists and is valid
    if (link3 && link3.trim() !== '') {
      message.message.data.clickAction = link3;
    }

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
          console.log(`✅ Absent notification sent to ${userId}`);
        } else {
          console.log(`❌ Notification Error Status: ${res.statusCode}, Response: ${responseData}`);
        }
      });
    });

    req.on('error', (error) => {
      console.error(`❌ Notification Request failed:`, error.message);
    });

    req.write(data);
    req.end();

  } catch (err) {
    console.error(`❌ Error sending absent notification:`, err.message);
  }
}

// ==================================================================
// 📲 API ENDPOINTS FOR NOTIFICATION ACTIONS
// ==================================================================

// Remove Present (from present notification action button)
app.post('/remove-present', async (req, res) => {
  try {
    const { userId, subjectId, dayNumber, monthYear } = req.body;
    
    if (!userId || !subjectId || !dayNumber || !monthYear) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const attendanceRef = db.collection('users')
      .doc(userId)
      .collection('subjects')
      .doc(subjectId)
      .collection('attendance')
      .doc(monthYear);

    await attendanceRef.update({
      present: admin.firestore.FieldValue.arrayRemove(parseInt(dayNumber))
    });

    console.log(`✅ Removed present for ${userId}, subject ${subjectId}, day ${dayNumber}`);
    res.json({ success: true, message: 'Present removed successfully' });

  } catch (err) {
    console.error('❌ Error removing present:', err);
    res.status(500).json({ error: 'Failed to remove present' });
  }
});

// Proxy Done (from absent notification - remove from absent, add to present)
app.post('/proxy-done', async (req, res) => {
  try {
    const { userId, subjectId, dayNumber, monthYear } = req.body;
    
    if (!userId || !subjectId || !dayNumber || !monthYear) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const attendanceRef = db.collection('users')
      .doc(userId)
      .collection('subjects')
      .doc(subjectId)
      .collection('attendance')
      .doc(monthYear);

    await attendanceRef.update({
      absent: admin.firestore.FieldValue.arrayRemove(parseInt(dayNumber)),
      present: admin.firestore.FieldValue.arrayUnion(parseInt(dayNumber))
    });

    console.log(`✅ Proxy done for ${userId}, subject ${subjectId}, day ${dayNumber}`);
    res.json({ success: true, message: 'Marked as present (proxy)' });

  } catch (err) {
    console.error('❌ Error processing proxy:', err);
    res.status(500).json({ error: 'Failed to process proxy' });
  }
});

// Class Cancelled (from absent notification - just remove from absent)
app.post('/class-cancelled', async (req, res) => {
  try {
    const { userId, subjectId, dayNumber, monthYear } = req.body;
    
    if (!userId || !subjectId || !dayNumber || !monthYear) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const attendanceRef = db.collection('users')
      .doc(userId)
      .collection('subjects')
      .doc(subjectId)
      .collection('attendance')
      .doc(monthYear);

    await attendanceRef.update({
      absent: admin.firestore.FieldValue.arrayRemove(parseInt(dayNumber))
    });

    console.log(`✅ Class cancelled for ${userId}, subject ${subjectId}, day ${dayNumber}`);
    res.json({ success: true, message: 'Absence removed (class cancelled)' });

  } catch (err) {
    console.error('❌ Error removing absence:', err);
    res.status(500).json({ error: 'Failed to remove absence' });
  }
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

      const [endH, endM] = endTime.split(':').map(Number);

      const classEnd = new Date(istDate);
      classEnd.setHours(endH, endM, 0, 0);

      const endTimeISTString = classEnd.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });

      const existingSchedule = await db.collection('schedule')
        .where('userId', '==', userId)
        .where('subjectId', '==', subjectId)
        .where('date', '==', istDate.toDateString())
        .get();

      if (!existingSchedule.empty) continue;

      await db.collection('schedule').add({
        userId,
        subjectId,
        timestamp: `timestamp${endTimeISTString}`,
        endTime: admin.firestore.Timestamp.fromDate(classEnd),
        date: istDate.toDateString()
      });

      console.log(`🗓️ Added to schedule: ${userId} - ${subjectId} @ ${endTimeISTString}`);
    }
  }
}

// ==================================================================
// 👂 OBSERVE SCHEDULE COLLECTION & SEND FCM AT END TIME (ONLY ONCE)
// ==================================================================
db.collection('schedule').onSnapshot(async (snapshot) => {
  const now = getISTDate();
  snapshot.docChanges().forEach(async (change) => {
    if (change.type === 'added') {
      const data = change.doc.data();
      const { userId, subjectId, endTime } = data;
      if (!userId || !subjectId || !endTime) return;

      const endDate = endTime.toDate();
      const diff = endDate.getTime() - now.getTime();
      if (diff <= 0) return;

      console.log(`🕒 FCM will be sent exactly at end of class ${subjectId} for ${userId} (in ${Math.round(diff / 60000)} mins)`);

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
