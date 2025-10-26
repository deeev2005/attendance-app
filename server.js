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
  // Convert UTC to IST by adding 5 hours 30 minutes (19800000 milliseconds)
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
async function checkAndMarkAttendance(userId, subjectId, monthYear, subjectData, day) {
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
      return;
    }

    // Get recent location from locations collection (within last 10 minutes)
    const istNow = getISTDate();
    const tenMinutesAgo = new Date(istNow.getTime() - 10 * 60 * 1000);
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
      return;
    }

    const locationData = locationsSnapshot.docs[0].data();
    const userLat = locationData.latitude;
    const userLon = locationData.longitude;

    // Get subject location
    const classLat = subjectData.location?.latitude;
    const classLon = subjectData.location?.longitude;
    const accuracyThreshold = subjectData.location?.accuracy || 50;

    if (!classLat || !classLon) {
      console.log(`⚠️ No class location set for subject ${subjectId}`);
      return;
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
    } else {
      // Mark absent - too far
      await attendanceRef.set({
        absent: admin.firestore.FieldValue.arrayUnion(day)
      }, { merge: true });
      console.log(`❌ User ${userId}, Subject ${subjectId} marked ABSENT - too far (${distance.toFixed(2)}m)`);
    }
  } catch (error) {
    console.error(`❌ Error marking attendance for user ${userId}, subject ${subjectId}:`, error);
  }
}

// Queue a location request for the middle of class
function queueLocationRequest(userId, subjectId, fcmToken, subjectData, startMinutes, endMinutes, currentDate) {
  const middleMinutes = Math.floor((startMinutes + endMinutes) / 2);
  const istNow = getISTDate();
  const currentMinutes = istNow.getHours() * 60 + istNow.getMinutes();
  
  // Calculate delay until middle of class
  let delayMinutes = middleMinutes - currentMinutes;
  
  // If middle time already passed, send immediately if class is still ongoing
  if (delayMinutes < 0) {
    if (currentMinutes <= endMinutes) {
      console.log(`⚡ Class in progress for user ${userId}, subject ${subjectId} - sending location request immediately`);
      delayMinutes = 0; // Send immediately
    } else {
      console.log(`⏭️ Class already ended for user ${userId}, subject ${subjectId}`);
      return;
    }
  }

  const delayMs = delayMinutes * 60 * 1000;
  const middleTime = minutesToTime(middleMinutes);
  
  const queueKey = `${userId}_${subjectId}_${currentDate}`;
  
  // Check if already queued
  if (locationRequestQueue.has(queueKey)) {
    console.log(`⏭️ Already queued: user ${userId}, subject ${subjectId}`);
    return;
  }

  console.log(`📋 QUEUED: User ${userId}, Subject ${subjectId}`);
  console.log(`   ⏰ Will send location request at ${middleTime} (in ${delayMinutes} minutes)`);

  // Schedule the location request
  const timeoutId = setTimeout(async () => {
    console.log(`\n📍 Sending scheduled location request for user ${userId}, subject ${subjectId}`);
    
    const istDate = getISTDate();
    const monthYear = `${istDate.toLocaleString('en-US', { month: 'long', timeZone: 'Asia/Kolkata' }).toLowerCase()} ${istDate.getFullYear()}`;
    
    // Send FCM location request
    const sent = await sendLocationRequest(fcmToken, userId, subjectId, monthYear);
    
    if (sent) {
      // Wait 5 minutes, then check and mark attendance
      setTimeout(async () => {
        console.log(`\n🔍 Checking attendance for user ${userId}, subject ${subjectId}`);
        await checkAndMarkAttendance(userId, subjectId, monthYear, subjectData, istDate.getDate());
        
        // Remove from queue
        locationRequestQueue.delete(queueKey);
      }, 5 * 60 * 1000); // 5 minutes wait
    } else {
      locationRequestQueue.delete(queueKey);
    }
  }, delayMs);

  // Store in queue
  locationRequestQueue.set(queueKey, {
    timeoutId,
    userId,
    subjectId,
    middleTime,
    scheduledFor: new Date(istNow.getTime() + delayMs)
  });
}

// Main function: Scan all users and queue classes for today
async function scanAndQueueClasses() {
  const currentDay = getCurrentDay();
  const istNow = getISTDate();
  const currentDate = istNow.toISOString().split('T')[0];
  const currentMinutes = istNow.getHours() * 60 + istNow.getMinutes();

  console.log(`\n🔍 Scanning for classes on ${currentDay} - ${istNow.toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' })} IST`);

  try {
    // Get all users
    const usersSnapshot = await db.collection('users').get();

    let classesFound = 0;
    let classesQueued = 0;

    for (const userDoc of usersSnapshot.docs) {
      const userId = userDoc.id;
      const userData = userDoc.data();
      const fcmToken = userData.fcmToken;

      if (!fcmToken) {
        console.log(`⚠️ User ${userId} (${userData.name || 'No name'}) has no FCM token`);
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

        const daySchedule = schedule[currentDay];
        
        // Handle array format (new structure)
        if (Array.isArray(daySchedule)) {
          for (const classTime of daySchedule) {
            if (!classTime.start || !classTime.end) continue;
            
            classesFound++;
            
            const startMinutes = timeToMinutes(classTime.start);
            const endMinutes = timeToMinutes(classTime.end);

            // Skip if class already finished
            if (endMinutes < currentMinutes) {
              console.log(`⏭️ Class finished: ${subjectData.course || subjectId} for user ${userId}`);
              continue;
            }

            // Check if attendance already marked
            const monthYear = `${istNow.toLocaleString('en-US', { month: 'long', timeZone: 'Asia/Kolkata' }).toLowerCase()} ${istNow.getFullYear()}`;
            const attendanceRef = db
              .collection('users')
              .doc(userId)
              .collection('subjects')
              .doc(subjectId)
              .collection('attendance')
              .doc(monthYear);

            const attendanceDoc = await attendanceRef.get();
            const attendanceData = attendanceDoc.data() || {};
            
            if (attendanceData.present?.includes(istNow.getDate()) || 
                attendanceData.absent?.includes(istNow.getDate())) {
              console.log(`✅ Attendance already marked: ${subjectData.course || subjectId} for user ${userId}`);
              continue;
            }

            // Queue the location request
            queueLocationRequest(
              userId, 
              subjectId, 
              fcmToken, 
              subjectData, 
              startMinutes, 
              endMinutes, 
              currentDate
            );
            classesQueued++;
          }
        } else {
          // Handle string format (old structure) - "10:57-11:57"
          classesFound++;

          const [startTime, endTime] = daySchedule.split('-');
          
          const startMinutes = timeToMinutes(startTime.trim());
          const endMinutes = timeToMinutes(endTime.trim());

          // Skip if class already finished
          if (endMinutes < currentMinutes) {
            console.log(`⏭️ Class finished: ${subjectData.course || subjectId} for user ${userId}`);
            continue;
          }

          // Check if attendance already marked
          const monthYear = `${istNow.toLocaleString('en-US', { month: 'long', timeZone: 'Asia/Kolkata' }).toLowerCase()} ${istNow.getFullYear()}`;
          const attendanceRef = db
            .collection('users')
            .doc(userId)
            .collection('subjects')
            .doc(subjectId)
            .collection('attendance')
            .doc(monthYear);

          const attendanceDoc = await attendanceRef.get();
          const attendanceData = attendanceDoc.data() || {};
          
          if (attendanceData.present?.includes(istNow.getDate()) || 
              attendanceData.absent?.includes(istNow.getDate())) {
            console.log(`✅ Attendance already marked: ${subjectData.course || subjectId} for user ${userId}`);
            continue;
          }

          // Queue the location request
          queueLocationRequest(
            userId, 
            subjectId, 
            fcmToken, 
            subjectData, 
            startMinutes, 
            endMinutes, 
            currentDate
          );
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

// API endpoint to receive location from mobile app
app.post('/api/location', async (req, res) => {
  try {
    const { userId, latitude, longitude, subjectId, attendanceDocId } = req.body;

    if (!userId || !latitude || !longitude || !subjectId) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Store location in /locations collection
    const locationRef = await db.collection('locations').add({
      userId,
      latitude,
      longitude,
      timestamp: new Date(),
      subjectId
    });

    console.log(`📍 Location received and stored: ${locationRef.id}`);
    console.log(`   User: ${userId}, Subject: ${subjectId}`);

    // Get subject data to fetch class location
    const subjectDoc = await db
      .collection('users')
      .doc(userId)
      .collection('subjects')
      .doc(subjectId)
      .get();

    if (!subjectDoc.exists) {
      console.log(`⚠️ Subject ${subjectId} not found for user ${userId}`);
      return res.json({ success: true, message: 'Location stored but subject not found' });
    }

    const subjectData = subjectDoc.data();
    const classLat = subjectData.location?.latitude;
    const classLon = subjectData.location?.longitude;
    const accuracyThreshold = subjectData.location?.accuracy || 50;

    if (!classLat || !classLon) {
      console.log(`⚠️ No class location set for subject ${subjectId}`);
      return res.json({ success: true, message: 'Location stored but class location not set' });
    }

    // Calculate distance
    const distance = calculateDistance(latitude, longitude, classLat, classLon);
    console.log(`📏 Distance: ${distance.toFixed(2)}m, Threshold: ${accuracyThreshold}m`);

    // Get current date for attendance
    const istDate = getISTDate();
    const day = istDate.getDate();
    const monthYear = `${istDate.toLocaleString('en-US', { month: 'long', timeZone: 'Asia/Kolkata' }).toLowerCase()} ${istDate.getFullYear()}`;

    const attendanceRef = db
      .collection('users')
      .doc(userId)
      .collection('subjects')
      .doc(subjectId)
      .collection('attendance')
      .doc(monthYear);

    // Mark attendance based on distance
    if (distance <= accuracyThreshold) {
      // Mark present
      await attendanceRef.set({
        present: admin.firestore.FieldValue.arrayUnion(day)
      }, { merge: true });
      console.log(`✅ User ${userId} marked PRESENT for subject ${subjectId} on day ${day}`);
      res.json({ success: true, message: 'Marked present', distance: distance.toFixed(2) });
    } else {
      // Mark absent - too far
      await attendanceRef.set({
        absent: admin.firestore.FieldValue.arrayUnion(day)
      }, { merge: true });
      console.log(`❌ User ${userId} marked ABSENT for subject ${subjectId} on day ${day} - too far (${distance.toFixed(2)}m)`);
      res.json({ success: true, message: 'Marked absent - too far', distance: distance.toFixed(2) });
    }

  } catch (error) {
    console.error('❌ Error receiving location:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// API endpoint to get queue status
app.get('/api/queue-status', (req, res) => {
  const queueItems = Array.from(locationRequestQueue.entries()).map(([key, value]) => ({
    key,
    userId: value.userId,
    subjectId: value.subjectId,
    middleTime: value.middleTime,
    scheduledFor: value.scheduledFor
  }));

  res.json({
    queueSize: locationRequestQueue.size,
    items: queueItems,
    currentTimeIST: getISTDate().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })
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

// Manual trigger endpoint (for testing)
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

// Schedule scan every minute (IST)
cron.schedule('* * * * *', () => {
  console.log('\n⏰ Scheduled scan triggered');
  scanAndQueueClasses();
}, {
  timezone: "Asia/Kolkata"
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`⏰ Queue-based scheduler active (IST timezone)`);
  console.log(`📋 Queue size: ${locationRequestQueue.size}`);
  console.log(`🕐 Current IST: ${getISTDate().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}`);
});
