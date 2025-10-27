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
// 🧭 CLASS SCANNING & QUEUE LOGIC
// ==================================================================
const locationRequestQueue = new Map();

async function scanAndQueueClasses() {
  const istDate = getISTDate();
  const dayNames = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const currentDay = dayNames[istDate.getDay()];
  const timeString = istDate.toTimeString().split(' ')[0];
  console.log(`\n🔍 Scanning for classes on ${currentDay} - ${timeString}`);

  const usersSnapshot = await db.collection('users').get();
  let totalQueued = 0;

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
        let startTime;

        // ✅ Handle array or object schedule format
        const scheduleEntry = schedule[matchingDayKey];
        if (Array.isArray(scheduleEntry) && scheduleEntry.length > 0) {
          startTime = scheduleEntry[0].start;
        } else if (scheduleEntry && scheduleEntry.start) {
          startTime = scheduleEntry.start;
        }

        if (!startTime) {
          console.log(`⚠️ No valid start time found for ${subjectId} on ${matchingDayKey}`);
          continue;
        }

        const [hours, minutes] = startTime.split(':').map(Number);
        const classStart = new Date(istDate);
        classStart.setHours(hours, minutes, 0, 0);

        const now = getISTDate();
        if (now < classStart) {
          const queueKey = `${userId}_${subjectId}`;
          const timeDiff = classStart.getTime() - now.getTime();

          console.log(`🕒 Queuing class ${subjectId} for ${userId} (starts in ${Math.round(timeDiff / 60000)} mins)`);

          const timeoutId = setTimeout(async () => {
            console.log(`\n📋 Triggering FCM for user ${userId}, subject ${subjectId}`);
            await sendLocationRequest(userId, subjectId);
            locationRequestQueue.delete(queueKey);
          }, timeDiff);

          locationRequestQueue.set(queueKey, timeoutId);
          totalQueued++;
        }
      }
    }
  }

  console.log(`📊 Summary: ${totalQueued} classes queued for today`);
}

// Function for sending FCM
async function sendLocationRequest(userId, subjectId) {
  console.log(`🚀 Sending FCM to request location for ${userId}, subject ${subjectId}`);
  
  // TODO: Implement actual FCM push notification here
  // For now, this is a placeholder for the FCM logic
  
  // After FCM is sent, the mobile app should respond by writing to 'locations' collection
  // with structure: { userId, subjectId, latitude, longitude, timestamp }
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
  await scanAndQueueClasses();
  console.log(`🚀 Server running on port ${PORT}`);
  console.log('👂 Listening to Firestore "locations" collection for new entries...');
});

// 🕒 Added: check for scheduled classes every 1 minute
setInterval(scanAndQueueClasses, 60 * 1000);
