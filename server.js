// ==================================================================
// 🧭 CLASS SCANNING & QUEUE LOGIC - FIXED
// ==================================================================
const locationRequestQueue = new Map();
const sentNotifications = new Set(); // ✅ Track already sent notifications

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

      const matchingDayKey = Object.keys(schedule).find(
        key => key.toLowerCase() === currentDay
      );

      if (matchingDayKey) {
        let startTime, endTime;

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

        const [startHours, startMinutes] = startTime.split(':').map(Number);
        const [endHours, endMinutes] = endTime.split(':').map(Number);
        
        const classStart = new Date(istDate);
        classStart.setHours(startHours, startMinutes, 0, 0);
        
        const classEnd = new Date(istDate);
        classEnd.setHours(endHours, endMinutes, 0, 0);
        
        const middleTime = new Date((classStart.getTime() + classEnd.getTime()) / 2);

        const now = getISTDate();
        const queueKey = `${userId}_${subjectId}`;
        
        // ✅ Create daily unique key to prevent duplicate notifications
        const dailyKey = `${userId}_${subjectId}_${istDate.toDateString()}`;
        
        // ✅ FIXED: Skip if already sent today OR already queued OR middle time has passed
        if (sentNotifications.has(dailyKey) || locationRequestQueue.has(queueKey) || now >= middleTime) {
          continue;
        }
        
        const timeDiff = middleTime.getTime() - now.getTime();

        console.log(`🕒 Queuing class ${subjectId} for ${userId} (middle time in ${Math.round(timeDiff / 60000)} mins)`);

        const timeoutId = setTimeout(async () => {
          console.log(`\n📋 Triggering FCM for user ${userId}, subject ${subjectId}`);
          await sendLocationRequest(userId, subjectId);
          sentNotifications.add(dailyKey); // ✅ Mark as sent
          locationRequestQueue.delete(queueKey);
        }, timeDiff);

        locationRequestQueue.set(queueKey, timeoutId);
        totalQueued++;
      }
    }
  }

  console.log(`📊 Summary: ${totalQueued} classes queued for today`);
}

// ✅ Clear sent notifications at midnight IST
function scheduleMidnightReset() {
  const now = getISTDate();
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(0, 0, 0, 0);
  
  const timeUntilMidnight = tomorrow.getTime() - now.getTime();
  
  setTimeout(() => {
    console.log('🌙 Midnight reset: Clearing sent notifications');
    sentNotifications.clear();
    scheduleMidnightReset(); // Schedule next reset
  }, timeUntilMidnight);
}

// ==================================================================
// 🚀 SERVER STARTUP - UPDATED
// ==================================================================
const PORT = process.env.PORT || 10000;
app.listen(PORT, async () => {
  console.log('🚀 Starting server...');
  console.log('🇮🇳 Using Indian Standard Time (IST)');
  await scanAndQueueClasses();
  scheduleMidnightReset(); // ✅ Start midnight reset scheduler
  console.log(`🚀 Server running on port ${PORT}`);
  console.log('👂 Listening to Firestore "locations" collection for new entries...');
});

setInterval(scanAndQueueClasses, 60 * 1000);
