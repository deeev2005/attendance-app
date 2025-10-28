// ==================================================================
// 🧭 CLASS SCANNING & QUEUE LOGIC - FIXED
// ==================================================================
const locationRequestQueue = new Map();
const sentNotifications = new Set(); // Track already sent notifications
const processedClasses = new Set(); // ✅ NEW: Track classes already processed today

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

      // Case-insensitive match for day name
      const matchingDayKey = Object.keys(schedule).find(
        key => key.toLowerCase() === currentDay
      );

      if (matchingDayKey) {
        let startTime, endTime;

        // Handle array or object schedule format
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

        // Calculate middle of the class
        const [startHours, startMinutes] = startTime.split(':').map(Number);
        const [endHours, endMinutes] = endTime.split(':').map(Number);
        
        const classStart = new Date(istDate);
        classStart.setHours(startHours, startMinutes, 0, 0);
        
        const classEnd = new Date(istDate);
        classEnd.setHours(endHours, endMinutes, 0, 0);
        
        const middleTime = new Date((classStart.getTime() + classEnd.getTime()) / 2);

        const now = getISTDate();
        
        // ✅ FIXED: Create daily unique key to prevent duplicate processing
        const dailyProcessKey = `${userId}_${subjectId}_${istDate.toDateString()}`;
        
        // ✅ MAIN FIX: Skip if already processed today (queued or sent)
        if (processedClasses.has(dailyProcessKey)) {
          continue;
        }
        
        // Skip if middle time has already passed
        if (now >= middleTime) {
          console.log(`⏭️ Skipping ${subjectId} - middle time already passed`);
          continue;
        }
        
        const timeDiff = middleTime.getTime() - now.getTime();

        console.log(`🕒 Queuing class ${subjectId} for ${userId} (middle time in ${Math.round(timeDiff / 60000)} mins)`);

        // ✅ Mark as processed immediately when queuing
        processedClasses.add(dailyProcessKey);

        const timeoutId = setTimeout(async () => {
          console.log(`\n📋 Triggering FCM for user ${userId}, subject ${subjectId}`);
          await sendLocationRequest(userId, subjectId);
          sentNotifications.add(dailyProcessKey); // Mark as sent
          locationRequestQueue.delete(`${userId}_${subjectId}`);
        }, timeDiff);

        locationRequestQueue.set(`${userId}_${subjectId}`, timeoutId);
        totalQueued++;
      }
    }
  }

  console.log(`📊 Summary: ${totalQueued} classes queued for today`);
}

// ✅ Clear all tracking sets at midnight IST
function scheduleMidnightReset() {
  const now = getISTDate();
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(0, 0, 0, 0);
  
  const timeUntilMidnight = tomorrow.getTime() - now.getTime();
  
  setTimeout(() => {
    console.log('🌙 Midnight reset: Clearing all tracking sets');
    sentNotifications.clear();
    processedClasses.clear(); // ✅ Clear processed classes too
    scheduleMidnightReset(); // Schedule next reset
  }, timeUntilMidnight);
}
