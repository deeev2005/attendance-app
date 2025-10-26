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

// 🟢 REALTIME LISTENER for location updates
db.collection('locations').onSnapshot(async (snapshot) => {
  snapshot.docChanges().forEach(async (change) => {
    if (change.type === 'added') {
      const data = change.doc.data();
      const { userId, latitude, longitude, subjectId, accuracy } = data;

      if (!userId || !latitude || !longitude || !subjectId) {
        console.log('⚠️ Missing required fields in location doc');
        return;
      }

      console.log(`📍 New location detected for user: ${userId}, subject: ${subjectId}`);

      // Fetch subject details
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
        console.log(`⚠️ Class location not set for subject ${subjectId}`);
        return;
      }

      // Calculate distance
      const distance = calculateDistance(latitude, longitude, classLat, classLon);
      console.log(`📏 Distance: ${distance.toFixed(2)}m (Threshold: ${accuracyThreshold}m)`);

      // Get current IST date
      const istDate = getISTDate();
      const dayNumber = istDate.getDate();
      const monthName = istDate.toLocaleString('en-US', { month: 'long', timeZone: 'Asia/Kolkata' }).toLowerCase();
      const year = istDate.getFullYear();
      const monthYear = `${monthName} ${year}`;

      // Reference to attendance document
      const attendanceRef = db
        .collection('users')
        .doc(userId)
        .collection('subjects')
        .doc(subjectId)
        .collection('attendance')
        .doc(monthYear);

      // Mark attendance
      if (distance <= accuracyThreshold) {
        await attendanceRef.set({
          present: admin.firestore.FieldValue.arrayUnion(dayNumber)
        }, { merge: true });
        console.log(`✅ Marked PRESENT for user ${userId}, subject ${subjectId} (Day ${dayNumber})`);
      } else {
        await attendanceRef.set({
          absent: admin.firestore.FieldValue.arrayUnion(dayNumber)
        }, { merge: true });
        console.log(`❌ Marked ABSENT for user ${userId}, subject ${subjectId} (Day ${dayNumber})`);
      }
    }
  });
});

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timeIST: getISTDate().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`👂 Listening to Firestore 'locations' collection for changes...`);
});
