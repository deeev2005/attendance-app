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
// 🔁 LISTENER FOR LOCATIONS (attendance marking)
// ==================================================================
db.collection('locations').onSnapshot(async (snapshot) => {
  snapshot.docChanges().forEach(async (change) => {
    if (change.type === 'added') {
      const data = change.doc.data();
      const { userId, subjectId, latitude, longitude } = data;
      if (!userId || !subjectId || !latitude || !longitude) return;

      console.log(`📍 New location received for ${userId}, subject ${subjectId}`);

      const subjectDoc = await db
        .collection('users').doc(userId)
        .collection('subjects').doc(subjectId).get();

      if (!subjectDoc.exists) return;

      const subjectData = subjectDoc.data();
      const classLat = subjectData.location?.latitude;
      const classLon = subjectData.location?.longitude;
      const accuracyThreshold = subjectData.location?.accuracy || 50;

      if (!classLat || !classLon) return;

      const distance = calculateDistance(latitude, longitude, classLat, classLon);
      const istDate = getISTDate();
      const dayNumber = istDate.getDate();
      const monthName = istDate.toLocaleString('en-US', { month: 'long', timeZone: 'Asia/Kolkata' }).toLowerCase();
      const year = istDate.getFullYear();
      const monthYear = `${monthName} ${year}`;

      const attendanceRef = db.collection('users')
        .doc(userId)
        .collection('subjects')
        .doc(subjectId)
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
          console.log(`✅ Marked PRESENT for ${userId}, subject ${subjectId}`);
        } else {
          await attendanceRef.set({
            absent: admin.firestore.FieldValue.arrayUnion(dayNumber)
          }, { merge: true });
          console.log(`❌ Marked ABSENT for ${userId}, subject ${subjectId}`);
        }
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
// 👂 OBSERVE SCHEDULE COLLECTION & SEND FCM AT END TIME
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

      console.log(`🕒 Queuing 2 FCMs for END of class ${subjectId} for ${userId} (in ${Math.round(diff / 60000)} mins)`);

      setTimeout(async () => {
        console.log(`\n📋 Triggering 2 FCMs for user ${userId}, subject ${subjectId} at END of class`);
        await sendLocationRequest(userId, subjectId);
        await new Promise(res => setTimeout(res, 3000)); // small 3s gap
        await sendLocationRequest(userId, subjectId);
      }, diff);
    }
  });
});

// ==================================================================
// 🚀 Send FCM (SILENT PUSH ONLY)
// ==================================================================
async function sendLocationRequest(userId, subjectId) {
  try {
    const userDoc = await db.collection('users').doc(userId).get();
    if (!userDoc.exists) return;

    const fcmToken = userDoc.data().fcmToken;
    if (!fcmToken) return;

    const message = {
      token: fcmToken,
      data: {
        type: 'LOCATION_REQUEST',
        userId,
        subjectId,
        timestamp: Date.now().toString()
      },
      android: {
        priority: 'high',
        notification: undefined // ✅ prevents visible notification
      },
      apns: {
        headers: {
          'apns-priority': '5'
        },
        payload: {
          aps: {
            'content-available': 1
          }
        }
      }
    };

    await admin.messaging().send(message);
    console.log(`✅ Silent FCM sent successfully to ${userId} for subject ${subjectId}`);
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
