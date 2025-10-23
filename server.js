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
      console.log(`✅ Attendance already processed for user ${userId}, subject ${subjectId}, day ${day}`);
      return;
    }

    console.log(`🔍 Checking for location data for user ${userId}, subject ${subjectId}...`);

    // Get recent location from locations collection (within last 10 minutes)
    const istNow = getISTDate();
    const tenMinutesAgo = new Date(istNow.getTime() - 10 * 60 * 1000);
    
    const locationsSnapshot = await db
      .collection('locations')
      .where('userId', '==', userId)
      .where('subjectId', '==', subjectId)
      .orderBy('timestamp', 'desc')
      .limit(1)
      .get();

    if (locationsSnapshot.empty) {
      // No location received, mark absent
      await attendanceRef.set({
        absent: admin.firestore.FieldValue.arrayUnion(day)
      }, { merge: true });
      console.log(`❌ User ${userId}, Subject ${subjectId}, Day ${day} marked ABSENT - no location received`);
      return;
    }

    const locationDoc = locationsSnapshot.docs[0];
    const locationData = locationDoc.data();
    
    // Check if location is recent (within 10 minutes)
    const locationTimestamp = locationData.timestamp?.toDate();
    if (locationTimestamp && locationTimestamp < tenMinutesAgo) {
      console.log(`⚠️ Location too old for user ${userId}, marking absent`);
      await attendanceRef.set({
        absent: admin.firestore.FieldValue.arrayUnion(day)
      }, { merge: true });
      console.log(`❌ User ${userId}, Subject ${subjectId}, Day ${day} marked ABSENT - location too old`);
      return;
    }

    const userLat = locationData.latitude;
    const userLon = locationData.longitude;

    console.log(`📍 User location found: lat=${userLat}, lon=${userLon}`);

    // Get subject location
    const classLat = subjectData.location?.latitude;
    const classLon = subjectData.location?.longitude;
    const accuracyThreshold = subjectData.location?.accuracy || 50;

    console.log(`🏫 Class location: lat=${classLat}, lon=${classLon}, threshold=${accuracyThreshold}m`);

    if (!classLat || !classLon) {
      console.log(`⚠️ No class location set for subject ${subjectId}`);
      return;
    }

    // Calculate distance
    const distance = calculateDistance(userLat, userLon, classLat, classLon);

    console.log(`📏 User ${userId}, Subject ${subjectId}, Day ${day} - Distance: ${distance.toFixed(2)}m, Threshold: ${accuracyThreshold}m`);

    if (distance <= accuracyThreshold) {
      // Mark present
      await attendanceRef.set({
        present: admin.firestore.FieldValue.arrayUnion(day)
      }, { merge: true });
      console.log(`✅✅✅ User ${userId}, Subject ${subjectId}, Day ${day} marked PRESENT ✅✅✅`);
    } else {
      // Mark absent - too far
      await attendanceRef.set({
        absent: admin.firestore.FieldValue.arrayUnion(day)
      }, { merge: true });
      console.log(`❌ User ${userId}, Subject ${subjectId}, Day ${day} marked ABSENT - too far (${distance.toFixed(2)}m)`);
    }
  } catch (error) {
    console.error(`❌ Error marking attendance for user ${userId}, subject ${subjectId}:`, error);
    console.error('Error details:', error.stack);
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
      console.log(`⚡ Class in progress for user ${userId}, subject ${subjectId} - sending location request immediately`);
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
  console.log(`   ⏰ Will send location request at ${middleTime} (in ${delayMinutes} minutes)`);

  const timeoutId = setTimeout(async () => {
    console.log(`\n📍 Sending scheduled location request for user ${userId}, subject ${subjectId}`);
    
    const istDate = getISTDate();
    const monthYear = `${istDate.toLocaleString('en-US', { month: 'long', timeZone: 'Asia/Kolkata' }).toLowerCase()} ${istDate.getFullYear()}`;
    
    const sent = await sendLocationRequest(fcmToken, userId, subjectId, monthYear);
    
    if (sent) {
      // Wait 5 minutes, then check and mark attendance
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

// Main function: Scan all users and queue classes for today
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
        console.log(`⚠️ User ${userId} (${userData.name || 'No name'}) has no FCM token`);
        continue;
      }

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
        
        if (Array.isArray(daySchedule)) {
          for (const classTime of daySchedule) {
            if (!classTime.start || !classTime.end) continue;
            
            classesFound++;
            
            const startMinutes = timeToMinutes(classTime.start);
            const endMinutes = timeToMinutes(classTime.end);

            if (endMinutes < currentMinutes) {
              console.log(`⏭️ Class finished: ${subjectData.course || subjectId} for user ${userId}`);
              continue;
            }

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
          classesFound++;

          const [startTime, endTime] = daySchedule.split('-');
          
          const startMinutes = timeToMinutes(startTime.trim());
          const endMinutes = timeToMinutes(endTime.trim());

          if (endMinutes < currentMinutes) {
            console.log(`⏭️ Class finished: ${subjectData.course || subjectId} for user ${userId}`);
            continue;
          }

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

    console.log(`\n📱📱📱 LOCATION RECEIVED FROM MOBILE APP 📱📱📱`);
    console.log(`User: ${userId}`);
    console.log(`Subject: ${subjectId}`);
    console.log(`Latitude: ${latitude}`);
    console.log(`Longitude: ${longitude}`);

    if (!userId || !latitude || !longitude || !subjectId) {
      console.log(`❌ Missing required fields`);
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // STEP 1: Store location in /locations collection (for record keeping)
    const locationRef = await db.collection('locations').add({
      userId,
      latitude,
      longitude,
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
      subjectId
    });

    console.log(`✅ Location stored in /locations/${locationRef.id}`);

    // STEP 2: Get subject data to fetch class location
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

    console.log(`\n🏫 CLASS LOCATION DATA:`);
    console.log(`   Latitude: ${classLat}`);
    console.log(`   Longitude: ${classLon}`);
    console.log(`   Accuracy Threshold: ${accuracyThreshold}m`);

    if (!classLat || !classLon) {
      console.log(`⚠️ No class location set for subject ${subjectId}`);
      return res.json({ success: true, message: 'Location stored but class location not set' });
    }

    // STEP 3: Calculate distance
    const distance = calculateDistance(latitude, longitude, classLat, classLon);
    console.log(`\n📏 DISTANCE CALCULATION:`);
    console.log(`   Distance: ${distance.toFixed(2)}m`);
    console.log(`   Threshold: ${accuracyThreshold}m`);
    console.log(`   Within range: ${distance <= accuracyThreshold ? 'YES ✅' : 'NO ❌'}`);

    // STEP 4: Get current date for attendance
    const istDate = getISTDate();
    const day = istDate.getDate();
    const monthYear = `${istDate.toLocaleString('en-US', { month: 'long', timeZone: 'Asia/Kolkata' }).toLowerCase()} ${istDate.getFullYear()}`;

    console.log(`\n📅 ATTENDANCE DOCUMENT INFO:`);
    console.log(`   Document: ${monthYear}`);
    console.log(`   Day: ${day}`);
    console.log(`   Path: /users/${userId}/subjects/${subjectId}/attendance/${monthYear}`);

    const attendanceRef = db
      .collection('users')
      .doc(userId)
      .collection('subjects')
      .doc(subjectId)
      .collection('attendance')
      .doc(monthYear);

    // STEP 5: Check if already marked
    const attendanceDoc = await attendanceRef.get();
    const attendanceData = attendanceDoc.data() || { present: [], absent: [] };

    console.log(`\n📝 CURRENT ATTENDANCE:`);
    console.log(`   Present days: [${attendanceData.present?.join(', ') || 'none'}]`);
    console.log(`   Absent days: [${attendanceData.absent?.join(', ') || 'none'}]`);
    console.log(`   Already marked for day ${day}: ${attendanceData.present?.includes(day) || attendanceData.absent?.includes(day) ? 'YES' : 'NO'}`);

    if (attendanceData.present?.includes(day) || attendanceData.absent?.includes(day)) {
      console.log(`⚠️ Attendance already marked for day ${day}, skipping...`);
      return res.json({ 
        success: true, 
        message: 'Attendance already marked',
        alreadyMarked: true,
        day: day
      });
    }

    // STEP 6: Mark attendance based on distance
    console.log(`\n🎯 MARKING ATTENDANCE...`);
    
    if (distance <= accuracyThreshold) {
      // Mark present
      await attendanceRef.set({
        present: admin.firestore.FieldValue.arrayUnion(day)
      }, { merge: true });
      
      console.log(`\n✅✅✅ SUCCESS: MARKED PRESENT ✅✅✅`);
      console.log(`   User: ${userId}`);
      console.log(`   Subject: ${subjectId}`);
      console.log(`   Day: ${day}`);
      console.log(`   Distance: ${distance.toFixed(2)}m`);
      
      res.json({ 
        success: true, 
        message: 'Marked present', 
        distance: distance.toFixed(2), 
        day: day,
        monthYear: monthYear 
      });
    } else {
      // Mark absent - too far
      await attendanceRef.set({
        absent: admin.firestore.FieldValue.arrayUnion(day)
      }, { merge: true });
      
      console.log(`\n❌ MARKED ABSENT - TOO FAR ❌`);
      console.log(`   User: ${userId}`);
      console.log(`   Subject: ${subjectId}`);
      console.log(`   Day: ${day}`);
      console.log(`   Distance: ${distance.toFixed(2)}m (required: ${accuracyThreshold}m)`);
      
      res.json({ 
        success: true, 
        message: 'Marked absent - too far', 
        distance: distance.toFixed(2), 
        day: day,
        monthYear: monthYear 
      });
    }

  } catch (error) {
    console.error('\n❌❌❌ ERROR IN /api/location ❌❌❌');
    console.error('Error message:', error.message);
    console.error('Error stack:', error.stack);
    res.status(500).json({ error: 'Internal server error', details: error.message });
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

// Manual attendance check endpoint (for testing without FCM)
app.post('/api/test-attendance', async (req, res) => {
  try {
    const { userId, subjectId } = req.body;
    
    if (!userId || !subjectId) {
      return res.status(400).json({ error: 'Missing userId or subjectId' });
    }

    console.log(`\n🧪 MANUAL TEST: Checking attendance for user ${userId}, subject ${subjectId}`);

    // Get subject data
    const subjectDoc = await db
      .collection('users')
      .doc(userId)
      .collection('subjects')
      .doc(subjectId)
      .get();

    if (!subjectDoc.exists) {
      return res.status(404).json({ error: 'Subject not found' });
    }

    const subjectData = subjectDoc.data();
    const istDate = getISTDate();
    const day = istDate.getDate();
    const monthYear = `${istDate.toLocaleString('en-US', { month: 'long', timeZone: 'Asia/Kolkata' }).toLowerCase()} ${istDate.getFullYear()}`;

    console.log(`📅 Testing for: ${monthYear}, Day: ${day}`);
    console.log(`🏫 Subject data:`, JSON.stringify(subjectData.location, null, 2));

    await checkAndMarkAttendance(userId, subjectId, monthYear, subjectData, day);

    res.json({ 
      success: true, 
      message: 'Attendance check completed',
      day: day,
      monthYear: monthYear
    });
  } catch (error) {
    console.error('❌ Error in test-attendance:', error);
    res.status(500).json({ error: error.message });
  }
});

// Debug endpoint to check location data
app.get('/api/debug-locations/:userId/:subjectId', async (req, res) => {
  try {
    const { userId, subjectId } = req.params;
    
    console.log(`\n🔍 DEBUG: Fetching locations for user ${userId}, subject ${subjectId}`);

    const locationsSnapshot = await db
      .collection('locations')
      .where('userId', '==', userId)
      .where('subjectId', '==', subjectId)
      .orderBy('timestamp', 'desc')
      .limit(5)
      .get();

    const locations = [];
    locationsSnapshot.forEach(doc => {
      const data = doc.data();
      locations.push({
        id: doc.id,
        ...data,
        timestamp: data.timestamp?.toDate().toISOString()
      });
    });

    console.log(`📍 Found ${locations.length} locations`);

    res.json({
      count: locations.length,
      locations: locations
    });
  } catch (error) {
    console.error('❌ Error fetching locations:', error);
    res.status(500).json({ error: error.message });
  }
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
