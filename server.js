const express = require('express');
const admin = require('firebase-admin');
const cron = require('node-cron');
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

// In-memory queue for scheduled location requests
const locationRequestQueue = new Map();

// Utility: Get current time in IST
function getISTDate() {
  const utcDate = new Date();
  return new Date(utcDate.getTime() + (5.5 * 60 * 60 * 1000));
}

// Utility: Calculate distance between two coordinates (in meters)
function calculateDistance(lat1, lon1, lat2, lon2) {
  const R = 6371e3;
  const φ1 = lat1 * Math.PI / 180;
  const φ2 = lat2 * Math.PI / 180;
  const Δφ = (lat2 - lat1) * Math.PI / 180;
  const Δλ = (lon2 - lon1) * Math.PI / 180;

  const a = Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
    Math.cos(φ1) * Math.cos(φ2) *
    Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return R * c;
}

// Utility: Get current day name in IST
function getCurrentDay() {
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const istDate = getISTDate();
  return days[istDate.getDay()];
}

// Utility: Parse time string (e.g., "10:57") to minutes since midnight
function timeToMinutes(timeStr) {
  const [hours, minutes] = timeStr.split(':').map(Number);
  return hours * 60 + minutes;
}

// Utility: Get time string from minutes
function minutesToTime(minutes) {
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return `${hours.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}`;
}

// Send FCM notification to request location
async function sendLocationRequest(fcmToken, userId, subjectId, attendanceDocId) {
  try {
    const message = {
      token: fcmToken,
      data: {
        type: 'location_request',
        userId: userId,
        subjectId: subjectId,
        attendanceDocId: attendanceDocId,
        timestamp: Date.now().toString()
      },
      android: { priority: 'high' },
      apns: { headers: { 'apns-priority': '10' } }
    };

    await admin.messaging().send(message);
    console.log(`✅ Location request sent to user: ${userId} for subject: ${subjectId}`);
    return true;
  } catch (error) {
    console.error(`❌ Failed to send FCM to user ${userId}:`, error.message);
    return false;
  }
}

// Queue a location request for the middle of class
function queueLocationRequest(userId, subjectId, fcmToken, subjectData, startMinutes, endMinutes, currentDate) {
  const middleMinutes = Math.floor((startMinutes + endMinutes) / 2);
  const istNow = getISTDate();
  const currentMinutes = istNow.getHours() * 60 + istNow.getMinutes();
  let delayMinutes = middleMinutes - currentMinutes;

  if (delayMinutes < 0) {
    if (currentMinutes <= endMinutes) {
      console.log(`⚡ Class in progress for user ${userId}, subject ${subjectId} - sending now`);
      delayMinutes = 0;
    } else {
      console.log(`⏭️ Class already ended for user ${userId}, subject ${subjectId}`);
      return;
    }
  }

  const delayMs = delayMinutes * 60 * 1000;
  const middleTime = minutesToTime(middleMinutes);
  const queueKey = `${userId}_${subjectId}_${currentDate}`;

  if (locationRequestQueue.has(queueKey)) {
    console.log(`⏭️ Already queued: user ${userId}, subject ${subjectId}`);
    return;
  }

  console.log(`📋 QUEUED: User ${userId}, Subject ${subjectId}`);
  console.log(`   ⏰ Will send at ${middleTime} (in ${delayMinutes} minutes)`);

  const timeoutId = setTimeout(async () => {
    console.log(`\n📍 Sending scheduled location request for user ${userId}, subject ${subjectId}`);
    const istDate = getISTDate();
    const monthYear = `${istDate.toLocaleString('en-US', { month: 'long', timeZone: 'Asia/Kolkata' }).toLowerCase()} ${istDate.getFullYear()}`;
    const sent = await sendLocationRequest(fcmToken, userId, subjectId, monthYear);
    if (sent) {
      setTimeout(async () => {
        console.log(`\n🔍 Checking attendance for user ${userId}, subject ${subjectId}`);
        await checkAndMarkAttendance(userId, subjectId, monthYear, subjectData, istDate.getDate());
        locationRequestQueue.delete(queueKey);
      }, 5 * 60 * 1000);
    } else {
      locationRequestQueue.delete(queueKey);
    }
  }, delayMs);

  locationRequestQueue.set(queueKey, {
    timeoutId,
    userId,
    subjectId,
    middleTime,
    scheduledFor: new Date(istNow.getTime() + delayMs)
  });
}

// Scan all users and queue classes for today
async function scanAndQueueClasses() {
  const currentDay = getCurrentDay();
  const istNow = getISTDate();
  const currentDate = istNow.toISOString().split('T')[0];
  const currentMinutes = istNow.getHours() * 60 + istNow.getMinutes();

  console.log(`\n🔍 Scanning for classes on ${currentDay} - ${istNow.toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' })} IST`);

  try {
    const usersSnapshot = await db.collection('users').get();
    let classesFound = 0;
    let classesQueued = 0;

    for (const userDoc of usersSnapshot.docs) {
      const userId = userDoc.id;
      const userData = userDoc.data();
      const fcmToken = userData.fcmToken;
      if (!fcmToken) {
        console.log(`⚠️ User ${userId} has no FCM token`);
        continue;
      }

      const subjectsSnapshot = await db.collection('users').doc(userId).collection('subjects').get();
      for (const subjectDoc of subjectsSnapshot.docs) {
        const subjectId = subjectDoc.id;
        const subjectData = subjectDoc.data();
        const schedule = subjectData.schedule;
        if (!schedule || !schedule[currentDay]) continue;

        const daySchedule = schedule[currentDay];
        const monthYear = `${istNow.toLocaleString('en-US', { month: 'long', timeZone: 'Asia/Kolkata' }).toLowerCase()} ${istNow.getFullYear()}`;
        const attendanceRef = db.collection('users').doc(userId).collection('subjects').doc(subjectId).collection('attendance').doc(monthYear);
        const attendanceDoc = await attendanceRef.get();
        const attendanceData = attendanceDoc.data() || {};

        const today = istNow.getDate();

        if (attendanceData.present?.includes(today) || attendanceData.absent?.includes(today)) {
          console.log(`✅ Attendance already marked: ${subjectData.course || subjectId} for user ${userId}`);
          continue;
        }

        if (Array.isArray(daySchedule)) {
          for (const classTime of daySchedule) {
            if (!classTime.start || !classTime.end) continue;
            classesFound++;
            const startMinutes = timeToMinutes(classTime.start);
            const endMinutes = timeToMinutes(classTime.end);
            if (endMinutes < currentMinutes) continue;
            queueLocationRequest(userId, subjectId, fcmToken, subjectData, startMinutes, endMinutes, currentDate);
            classesQueued++;
          }
        } else {
          classesFound++;
          const [startTime, endTime] = daySchedule.split('-');
          const startMinutes = timeToMinutes(startTime.trim());
          const endMinutes = timeToMinutes(endTime.trim());
          if (endMinutes < currentMinutes) continue;
          queueLocationRequest(userId, subjectId, fcmToken, subjectData, startMinutes, endMinutes, currentDate);
          classesQueued++;
        }
      }
    }

    console.log(`\n📊 Summary: ${classesFound} classes found, ${classesQueued} queued for today`);
    console.log(`📋 Total items in queue: ${locationRequestQueue.size}`);
  } catch (error) {
    console.error('❌ Error in scanAndQueueClasses:', error);
  }
}

// 🟢 NEW FUNCTION: Listen for new location documents and mark attendance immediately
db.collection('locations').onSnapshot(async (snapshot) => {
  snapshot.docChanges().forEach(async (change) => {
    if (change.type === 'added') {
      const data = change.doc.data();
      const { userId, latitude, longitude, subjectId, accuracy } = data;
      if (!userId || !latitude || !longitude || !subjectId) return;

      console.log(`📍 New location received for ${userId}, subject ${subjectId}`);

      const subjectDoc = await db.collection('users').doc(userId).collection('subjects').doc(subjectId).get();
      if (!subjectDoc.exists) {
        console.log(`⚠️ Subject not found for ${userId}`);
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
      const attendanceRef = db.collection('users').doc(userId).collection('subjects').doc(subjectId).collection('attendance').doc(monthYear);

      if (distance <= accuracyThreshold) {
        await attendanceRef.set({ present: admin.firestore.FieldValue.arrayUnion(dayNumber) }, { merge: true });
        console.log(`✅ Marked PRESENT for ${userId}, subject ${subjectId} (Day ${dayNumber})`);
      } else {
        await attendanceRef.set({ absent: admin.firestore.FieldValue.arrayUnion(dayNumber) }, { merge: true });
        console.log(`❌ Marked ABSENT for ${userId}, subject ${subjectId} (Day ${dayNumber})`);
      }
    }
  });
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    istTime: getISTDate().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }),
    queueSize: locationRequestQueue.size
  });
});

// Manual trigger endpoint
app.post('/api/trigger-scan', async (req, res) => {
  await scanAndQueueClasses();
  res.json({
    message: 'Class scan triggered',
    queueSize: locationRequestQueue.size,
    istTime: getISTDate().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })
  });
});

// Run scan at server start
console.log('🚀 Starting server...');
console.log('🇮🇳 Using Indian Standard Time (IST)');
scanAndQueueClasses();

// Schedule scan every minute
cron.schedule('* * * * *', () => {
  console.log('\n⏰ Scheduled scan triggered');
  scanAndQueueClasses();
}, { timezone: "Asia/Kolkata" });

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📋 Queue size: ${locationRequestQueue.size}`);
  console.log(`🕐 Current IST: ${getISTDate().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}`);
});
