const express = require('express');
const admin = require('firebase-admin');
const cron = require('node-cron');

const app = express();
app.use(express.json());

// Initialize Firebase Admin
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '{}');
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

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

// Utility: Get current day name
function getCurrentDay() {
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  return days[new Date().getDay()];
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
      android: {
        priority: 'high'
      },
      apns: {
        headers: {
          'apns-priority': '10'
        }
      }
    };

    await admin.messaging().send(message);
    console.log(`✅ Location request sent to user: ${userId} for subject: ${subjectId}`);
    return true;
  } catch (error) {
    console.error(`❌ Failed to send FCM to user ${userId}:`, error.message);
    return false;
  }
}

// Check and mark attendance based on location
async function checkAndMarkAttendance(userId, subjectId, monthYear, classLat, classLon, accuracyThreshold, day) {
  try {
    const attendanceRef = db
      .collection('users')
      .doc(userId)
      .collection('subjects')
      .doc(subjectId)
      .collection('attendance')
      .doc(monthYear);

    const attendanceDoc = await attendanceRef.get();
    const attendanceData = attendanceDoc.data() || { present: [], absent: [] };

    // Check if already marked
    if (attendanceData.present?.includes(day) || attendanceData.absent?.includes(day)) {
      console.log(`✅ Attendance already processed for user ${userId}, subject ${subjectId}`);
      return 'already_marked';
    }

    // Get recent location from locations collection (within last 10 minutes)
    const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);
    const locationsSnapshot = await db
      .collection('locations')
      .where('userId', '==', userId)
      .where('subjectId', '==', subjectId)
      .where('timestamp', '>=', tenMinutesAgo)
      .orderBy('timestamp', 'desc')
      .limit(1)
      .get();

    if (locationsSnapshot.empty) {
      // No location received, mark absent
      await attendanceRef.set({
        absent: admin.firestore.FieldValue.arrayUnion(day)
      }, { merge: true });
      console.log(`❌ User ${userId}, Subject ${subjectId} marked ABSENT - no location received`);
      return 'absent_no_location';
    }

    const locationData = locationsSnapshot.docs[0].data();
    const userLat = locationData.latitude;
    const userLon = locationData.longitude;

    if (!classLat || !classLon) {
      console.log(`⚠️ No class location set for subject ${subjectId}`);
      return 'no_class_location';
    }

    // Calculate distance
    const distance = calculateDistance(userLat, userLon, classLat, classLon);

    console.log(`📏 User ${userId}, Subject ${subjectId} - Distance: ${distance.toFixed(2)}m, Threshold: ${accuracyThreshold}m`);

    if (distance <= accuracyThreshold) {
      // Mark present
      await attendanceRef.set({
        present: admin.firestore.FieldValue.arrayUnion(day)
      }, { merge: true });
      console.log(`✅ User ${userId}, Subject ${subjectId} marked PRESENT`);
      return 'present';
    } else {
      // Mark absent - too far
      await attendanceRef.set({
        absent: admin.firestore.FieldValue.arrayUnion(day)
      }, { merge: true });
      console.log(`❌ User ${userId}, Subject ${subjectId} marked ABSENT - too far (${distance.toFixed(2)}m)`);
      return 'absent_too_far';
    }
  } catch (error) {
    console.error(`❌ Error marking attendance for user ${userId}, subject ${subjectId}:`, error);
    return 'error';
  }
}

// Create queue entry in Firestore
async function createQueueEntry(userId, subjectId, fcmToken, subjectData, middleTimeMs, currentDate) {
  const queueId = `${userId}_${subjectId}_${currentDate}`;
  
  try {
    await db.collection('attendance_queue').doc(queueId).set({
      userId,
      subjectId,
      fcmToken,
      classLocation: {
        latitude: subjectData.location?.latitude || null,
        longitude: subjectData.location?.longitude || null,
        accuracy: subjectData.location?.accuracy || 50
      },
      middleTime: new Date(middleTimeMs),
      date: currentDate,
      status: 'pending', // pending, location_sent, completed
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
    
    console.log(`📋 Queue entry created: ${queueId}`);
    return true;
  } catch (error) {
    console.error(`❌ Error creating queue entry ${queueId}:`, error);
    return false;
  }
}

// Process queue entries that are due
async function processQueue() {
  const now = new Date();
  console.log(`\n⚙️ Processing queue at ${now.toLocaleTimeString()}`);

  try {
    // Get pending entries where middleTime has passed
    const queueSnapshot = await db
      .collection('attendance_queue')
      .where('status', '==', 'pending')
      .where('middleTime', '<=', now)
      .get();

    if (queueSnapshot.empty) {
      console.log('📭 No queue items to process');
      return;
    }

    console.log(`📬 Found ${queueSnapshot.size} items to process`);

    for (const queueDoc of queueSnapshot.docs) {
      const queueData = queueDoc.data();
      const queueId = queueDoc.id;

      console.log(`\n📍 Processing: ${queueId}`);

      // Send FCM location request
      const sent = await sendLocationRequest(
        queueData.fcmToken,
        queueData.userId,
        queueData.subjectId,
        now.toLocaleString('default', { month: 'long' }).toLowerCase() + ' ' + now.getFullYear()
      );

      if (sent) {
        // Update status to location_sent
        await db.collection('attendance_queue').doc(queueId).update({
          status: 'location_sent',
          locationRequestSentAt: admin.firestore.FieldValue.serverTimestamp()
        });
      } else {
        // Failed to send, mark as completed with error
        await db.collection('attendance_queue').doc(queueId).update({
          status: 'completed',
          result: 'fcm_failed'
        });
      }
    }

    // Process entries where location was sent 5+ minutes ago
    const fiveMinutesAgo = new Date(now.getTime() - 5 * 60 * 1000);
    const locationSentSnapshot = await db
      .collection('attendance_queue')
      .where('status', '==', 'location_sent')
      .where('locationRequestSentAt', '<=', fiveMinutesAgo)
      .get();

    console.log(`\n🔍 Checking attendance for ${locationSentSnapshot.size} items`);

    for (const queueDoc of locationSentSnapshot.docs) {
      const queueData = queueDoc.data();
      const queueId = queueDoc.id;

      const monthYear = now.toLocaleString('default', { month: 'long' }).toLowerCase() + ' ' + now.getFullYear();

      const result = await checkAndMarkAttendance(
        queueData.userId,
        queueData.subjectId,
        monthYear,
        queueData.classLocation.latitude,
        queueData.classLocation.longitude,
        queueData.classLocation.accuracy,
        now.getDate()
      );

      // Mark as completed
      await db.collection('attendance_queue').doc(queueId).update({
        status: 'completed',
        result: result,
        completedAt: admin.firestore.FieldValue.serverTimestamp()
      });
    }

  } catch (error) {
    console.error('❌ Error processing queue:', error);
  }
}

// Scan and create queue entries for today's classes
async function scanAndQueueClasses() {
  const currentDay = getCurrentDay();
  const now = new Date();
  const currentDate = now.toISOString().split('T')[0];
  const currentMinutes = now.getHours() * 60 + now.getMinutes();

  console.log(`\n🔍 Scanning for classes on ${currentDay} - ${now.toLocaleTimeString()}`);

  try {
    // Clean up old completed queue entries (older than 2 days)
    const twoDaysAgo = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000);
    const oldEntriesSnapshot = await db
      .collection('attendance_queue')
      .where('createdAt', '<=', twoDaysAgo)
      .get();

    if (!oldEntriesSnapshot.empty) {
      console.log(`🗑️ Cleaning up ${oldEntriesSnapshot.size} old queue entries`);
      const batch = db.batch();
      oldEntriesSnapshot.docs.forEach(doc => batch.delete(doc.ref));
      await batch.commit();
    }

    // Get all users
    const usersSnapshot = await db.collection('users').get();

    let classesFound = 0;
    let classesQueued = 0;

    for (const userDoc of usersSnapshot.docs) {
      const userId = userDoc.id;
      const userData = userDoc.data();
      const fcmToken = userData.fcmToken;

      if (!fcmToken) {
        continue;
      }

      // Get user's subjects
      const subjectsSnapshot = await db
        .collection('users')
        .doc(userId)
        .collection('subjects')
        .get();

      for (const subjectDoc of subjectsSnapshot.docs) {
        const subjectId = subjectDoc.id;
        const subjectData = subjectDoc.data();
        const schedule = subjectData.schedule;

        if (!schedule || !schedule[currentDay]) continue;

        classesFound++;

        const classTime = schedule[currentDay];
        const [startTime, endTime] = classTime.split('-');
        
        const startMinutes = timeToMinutes(startTime.trim());
        const endMinutes = timeToMinutes(endTime.trim());
        const middleMinutes = Math.floor((startMinutes + endMinutes) / 2);

        // Skip if class already finished
        if (endMinutes < currentMinutes) {
          continue;
        }

        // Check if already queued
        const queueId = `${userId}_${subjectId}_${currentDate}`;
        const existingQueue = await db.collection('attendance_queue').doc(queueId).get();
        
        if (existingQueue.exists) {
          continue;
        }

        // Check if attendance already marked
        const monthYear = now.toLocaleString('default', { month: 'long' }).toLowerCase() + ' ' + now.getFullYear();
        const attendanceRef = db
          .collection('users')
          .doc(userId)
          .collection('subjects')
          .doc(subjectId)
          .collection('attendance')
          .doc(monthYear);

        const attendanceDoc = await attendanceRef.get();
        const attendanceData = attendanceDoc.data() || {};
        
        if (attendanceData.present?.includes(now.getDate()) || 
            attendanceData.absent?.includes(now.getDate())) {
          continue;
        }

        // Create queue entry
        const middleTimeDate = new Date(now);
        middleTimeDate.setHours(Math.floor(middleMinutes / 60));
        middleTimeDate.setMinutes(middleMinutes % 60);
        middleTimeDate.setSeconds(0);

        await createQueueEntry(
          userId,
          subjectId,
          fcmToken,
          subjectData,
          middleTimeDate.getTime(),
          currentDate
        );
        
        classesQueued++;
      }
    }

    console.log(`\n📊 Summary: ${classesFound} classes found, ${classesQueued} new entries queued`);

  } catch (error) {
    console.error('❌ Error in scanAndQueueClasses:', error);
  }
}

// Listen to location collection changes
async function setupLocationListener() {
  console.log('👂 Setting up location collection listener...');
  
  db.collection('locations').onSnapshot(async (snapshot) => {
    snapshot.docChanges().forEach(async (change) => {
      if (change.type === 'added') {
        const locationData = change.doc.data();
        const { userId, subjectId, latitude, longitude, accuracy, timestamp } = locationData;
        
        if (!userId || !subjectId || !latitude || !longitude) {
          return;
        }

        console.log(`\n📍 New location detected: User ${userId}, Subject ${subjectId}`);

        try {
          // Get subject data to get class location
          const subjectDoc = await db
            .collection('users')
            .doc(userId)
            .collection('subjects')
            .doc(subjectId)
            .get();

          if (!subjectDoc.exists) {
            console.log(`⚠️ Subject ${subjectId} not found for user ${userId}`);
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

          // Calculate distance
          const distance = calculateDistance(latitude, longitude, classLat, classLon);
          console.log(`📏 Distance: ${distance.toFixed(2)}m, Threshold: ${accuracyThreshold}m`);

          // Get current date
          const now = timestamp?.toDate() || new Date();
          const day = now.getDate();
          const monthYear = now.toLocaleString('default', { month: 'long' }).toLowerCase() + ' ' + now.getFullYear();

          // Get attendance document
          const attendanceRef = db
            .collection('users')
            .doc(userId)
            .collection('subjects')
            .doc(subjectId)
            .collection('attendance')
            .doc(monthYear);

          const attendanceDoc = await attendanceRef.get();
          const attendanceData = attendanceDoc.data() || { present: [], absent: [] };

          // Check if already marked
          if (attendanceData.present?.includes(day) || attendanceData.absent?.includes(day)) {
            console.log(`✅ Attendance already marked for user ${userId}, subject ${subjectId} on day ${day}`);
            return;
          }

          // Mark attendance based on distance
          if (distance <= accuracyThreshold) {
            await attendanceRef.set({
              present: admin.firestore.FieldValue.arrayUnion(day)
            }, { merge: true });
            console.log(`✅ User ${userId}, Subject ${subjectId} marked PRESENT for day ${day}`);
          } else {
            await attendanceRef.set({
              absent: admin.firestore.FieldValue.arrayUnion(day)
            }, { merge: true });
            console.log(`❌ User ${userId}, Subject ${subjectId} marked ABSENT for day ${day} - too far (${distance.toFixed(2)}m)`);
          }

        } catch (error) {
          console.error(`❌ Error processing location for user ${userId}:`, error);
        }
      }
    });
  });
}

// API endpoint to receive location from mobile app (kept for backward compatibility)
app.post('/api/location', async (req, res) => {
  try {
    const { userId, latitude, longitude, subjectId, attendanceDocId } = req.body;

    if (!userId || !latitude || !longitude) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Store location
    await db.collection('locations').add({
      userId,
      latitude,
      longitude,
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
      subjectId: subjectId || null,
      accuracy: req.body.accuracy || null
    });

    console.log(`📍 Location received from user ${userId} for subject ${subjectId || 'unknown'}`);

    res.json({ success: true, message: 'Location received and stored' });
  } catch (error) {
    console.error('❌ Error receiving location:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// API endpoint to get queue status
app.get('/api/queue-status', async (req, res) => {
  try {
    const queueSnapshot = await db.collection('attendance_queue').get();
    
    const stats = {
      total: 0,
      pending: 0,
      location_sent: 0,
      completed: 0
    };

    const items = [];

    queueSnapshot.docs.forEach(doc => {
      const data = doc.data();
      stats.total++;
      stats[data.status] = (stats[data.status] || 0) + 1;
      
      items.push({
        id: doc.id,
        userId: data.userId,
        subjectId: data.subjectId,
        middleTime: data.middleTime?.toDate(),
        status: data.status,
        result: data.result
      });
    });

    res.json({ stats, items });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString()
  });
});

// Manual trigger endpoints
app.post('/api/trigger-scan', async (req, res) => {
  await scanAndQueueClasses();
  res.json({ message: 'Class scan triggered' });
});

app.post('/api/trigger-process', async (req, res) => {
  await processQueue();
  res.json({ message: 'Queue processing triggered' });
});

// Run on server start
console.log('🚀 Starting server...');
scanAndQueueClasses().then(() => {
  processQueue();
});

// Schedule scans every 6 hours
cron.schedule('0 */6 * * *', () => {
  console.log('\n⏰ Scheduled scan triggered');
  scanAndQueueClasses();
});

// Process queue every 2 minutes
cron.schedule('*/2 * * * *', () => {
  processQueue();
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`⏰ Persistent queue-based scheduler active`);
  console.log(`📋 Queue stored in Firestore`);
});
