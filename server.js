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
  console.error('❌ Failed to load service account file:', error);
  process.exit(1);
}

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}

const db = admin.firestore();

const PORT = process.env.PORT || 10000;

// ✅ Function to send FCM (fixed APNs error)
async function sendLocationRequest(userId, subjectId) {
  try {
    const userDoc = await db.collection('users').doc(userId).get();
    if (!userDoc.exists) return console.log(`⚠️ No user found for ID: ${userId}`);

    const FCM_TOKEN = userDoc.data().fcmToken;
    if (!FCM_TOKEN) return console.log(`⚠️ No FCM token for ${userId}`);

    const message = {
      token: FCM_TOKEN,
      notification: {
        title: 'Updating location...',
        body: 'Processing silently',
      },
      data: {
        type: 'LOCATION_REQUEST',
        userId,
        subjectId,
        silent: 'true',
      },
      android: {
        priority: 'high',
        notification: {
          sound: 'default',
          channelId: 'default',
        },
      },
      apns: {
        payload: {
          aps: {
            contentAvailable: true,
            sound: 'default', // ✅ FIXED: non-empty string to avoid APNs error
          },
        },
      },
    };

    await admin.messaging().send(message);
    console.log(`🚀 Sent FCM to ${userId} for subject ${subjectId}`);
  } catch (error) {
    console.error(`❌ Error sending FCM to ${userId}:`, error.message);
  }
}

// Example function to simulate schedule checking
async function scanForClasses() {
  const now = new Date();
  const day = now.toLocaleString('en-US', { weekday: 'long' }).toLowerCase();
  console.log(`🔍 Scanning for classes on ${day} - ${now.toLocaleTimeString()}`);

  // Example query for classes
  const snapshot = await db.collection('schedules')
    .where('day', '==', day)
    .get();

  let count = 0;
  snapshot.forEach((doc) => {
    const data = doc.data();
    const userId = data.userId;
    const subjectId = data.subjectId;
    const startTime = data.startTime?.toDate();
    const endTime = data.endTime?.toDate();

    if (!startTime || !endTime) return;

    const diff = (startTime - now) / 60000;
    if (diff > 0 && diff < 2) {
      console.log(`🗓️ Added to schedule: ${userId} - ${subjectId} @ ${startTime}`);
      setTimeout(() => sendLocationRequest(userId, subjectId), 2000);
      count++;
    }

    const endDiff = (endTime - now) / 60000;
    if (endDiff > 0 && endDiff < 2) {
      console.log(`🕒 FCM will be sent exactly at end of class ${subjectId} for ${userId} (in ${Math.round(endDiff)} mins)`);
      setTimeout(() => sendLocationRequest(userId, subjectId), endDiff * 60 * 1000);
      count++;
    }
  });

  console.log(`📊 Summary: ${count} FCMs queued for today`);
}

// Run scanner every minute
setInterval(scanForClasses, 60 * 1000);

app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});
