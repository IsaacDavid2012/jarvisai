const { Client, LocalAuth, MessageMedia } = require("whatsapp-web.js");
const qrcode = require("qrcode-terminal");
const fs = require("fs");
const path = require("path");
require("dotenv").config();

const { queryOllama, chatOllama, warmModel } = require("./ollama");
const db = require("./db");
const { parseIntent, extractEntityAndDate, parseDateTimeString, extractSearchQuery } = require("./intents");
const {
  handleExecCommand,
  checkContainerStatus,
  getContainerErrorLogs,
  requestRestart,
  requestSensitiveAction,
  handlePendingConfirmation,
  findContainer
} = require("./cmd_runner");
const { searchWeb, summarizeResults } = require("./search");
const { checkServers } = require("./server_health");
const { startSystemMonitor } = require("./system_monitor");
const memory = require("./memory");
const { transcribeAudio, synthesizeSpeechToMedia } = require("./voice_engine");

process.env.TZ = process.env.TZ || "Asia/Kuala_Lumpur";

const SESSION_ID = process.env.SESSION_ID || "isaac_ai_session";
const PRIMARY_PHONE = process.env.PRIMARY_PHONE || "60176001484";
const PRIMARY_USER_JID = process.env.PRIMARY_USER_JID || `${PRIMARY_PHONE}@c.us`;

let client;
let targetReminderJid = PRIMARY_USER_JID;
let lastWalkthroughDate = "";
const botSentMessages = new Set();
const conversationHistory = new Map(); // chatId -> Array<{role: "user"|"assistant", content: string}>

function appendToHistory(chatId, role, content) {
  if (!chatId || !content) return;
  if (!conversationHistory.has(chatId)) {
    conversationHistory.set(chatId, []);
  }
  const history = conversationHistory.get(chatId);
  history.push({ role, content });
  if (history.length > 10) {
    history.splice(0, history.length - 10);
  }
}

function recordBotResponse(text) {
  if (!text) return;
  botSentMessages.add(text.trim());
  if (botSentMessages.size > 100) {
    const first = botSentMessages.values().next().value;
    botSentMessages.delete(first);
  }
}

/**
 * Daily Executive 8:00 AM Walkthrough / Morning Briefing
 */
async function generateMorningWalkthrough() {
  try {
    const now = db.getKLDate();
    const todayStr = db.getKLDateStr(now);
    const events = await db.getEventsForDate(todayStr);
    const tasks = await db.getTasks(true);
    const servers = await checkServers();

    const daysOfWeek = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    const dayName = daysOfWeek[now.getDay()];

    let eventSection = "";
    if (events.length === 0) {
      eventSection = "• _No events scheduled today (Free schedule)._";
    } else {
      eventSection = events.map((e, idx) => {
        const time = e.start_time ? ` at \`${e.start_time}\`` : " (All day)";
        return `${idx + 1}. *${e.title}*${time}`;
      }).join("\n");
    }

    let taskSection = "";
    if (tasks.length === 0) {
      taskSection = "• _All tasks completed!_";
    } else {
      taskSection = tasks.slice(0, 5).map((t, idx) => `${idx + 1}. [ ] ${t.text}`).join("\n");
      if (tasks.length > 5) {
        taskSection += `\n_...and ${tasks.length - 5} more task(s)._`;
      }
    }

    const serverSection = servers.map(s => `• *${s.name.split(" ")[0]}:* ${s.status}`).join("\n");

    return `☀️ *DAILY 8:00 AM WALKTHROUGH*\n───────────────\n📅 *${dayName}, ${todayStr}*\n\n📌 *TODAY'S SCHEDULE:*\n${eventSection}\n\n📋 *ACTIVE TASKS:*\n${taskSection}\n\n🖥️ *INFRASTRUCTURE:*\n${serverSection}\n───────────────\n_JARVIS operational. Ready for today's tasks._`;
  } catch (err) {
    console.error("Error generating morning walkthrough:", err);
    return `❌ *Error generating morning walkthrough:* ${err.message}`;
  }
}

/**
 * Spoken 8:00 AM Morning Executive Walkthrough for live voice call
 */
async function generateSpokenMorningBrief() {
  try {
    const now = db.getKLDate();
    const todayStr = db.getKLDateStr(now);
    const events = await db.getEventsForDate(todayStr);
    const tasks = await db.getTasks(true);

    let speech = "Good morning Sir. This is your eight AM daily executive briefing. ";
    if (events.length === 0) {
      speech += "Your schedule is completely free today. ";
    } else {
      const eventDetails = events.map(e => e.start_time ? `${e.title} at ${e.start_time}` : `${e.title}`).join(", ");
      speech += `You have ${events.length} event${events.length > 1 ? "s" : ""} scheduled today: ${eventDetails}. `;
    }

    if (tasks.length > 0) {
      speech += `You have ${tasks.length} pending task${tasks.length > 1 ? "s" : ""}, notably ${tasks[0].text}. `;
    } else {
      speech += "All tasks are up to date. ";
    }

    speech += "All core server systems are running smoothly. How may I assist you today, Sir?";
    return speech;
  } catch (err) {
    return "Good morning Sir. This is your eight AM briefing. JARVIS systems operational. How may I be of assistance today?";
  }
}

/**
 * 3-Stage Event Reminders & Timed Reminders Cron Loop (Runs every 15s)
 */
function startCronScheduler(whatsappClient) {
  console.log("⏰ Starting Real-time Dispatcher & Cron Scheduler (15s interval, UTC+8)...");

  setInterval(async () => {
    try {
      if (!whatsappClient) return;

      const now = db.getKLDate();
      const todayStr = db.getKLDateStr(now);
      const currentTimeStr = db.getKLTimeStr(now); // "HH:MM"
      const [currH, currM] = currentTimeStr.split(":").map(Number);
      const currentTotalMins = currH * 60 + currM;

      // ─────────────────────────────────────────────
      // 1. SIMPLE REMINDERS & CALL DISPATCH NOTES
      // ─────────────────────────────────────────────
      const dueReminders = await db.getDueReminders(`${todayStr} ${currentTimeStr}:59`);
      if (dueReminders.length > 0) {
        console.log(`📋 Found ${dueReminders.length} due reminder(s)/action dispatch(es)...`);
      }
      for (const rem of dueReminders) {
        const reminderMsg = (rem.text.includes("───────────────") || rem.text.startsWith("📞") || rem.text.startsWith("📅") || rem.text.startsWith("📋"))
          ? rem.text
          : `⏰ *JARVIS REMINDER*\n───────────────\n🔔 *${rem.text}*\n\n📅 Scheduled: \`${rem.remind_at}\``;

        recordBotResponse(reminderMsg);
        try {
          await whatsappClient.sendMessage(targetReminderJid, reminderMsg);
        } catch (dispatchErr) {
          console.warn(`Failed to dispatch reminder to ${targetReminderJid}: ${dispatchErr.message}`);
          await whatsappClient.sendMessage(PRIMARY_USER_JID, reminderMsg);
        }

        if (rem.recurring === "daily") {
          const nextDate = new Date(now.getTime() + 24 * 60 * 60 * 1000);
          const nextStr = `${db.getKLDateStr(nextDate)} ${rem.remind_at.slice(11, 16)}:00`;
          await db.rescheduleReminder(rem.id, nextStr);
          console.log(`🔁 Advanced daily reminder #${rem.id} to ${nextStr}`);
        } else if (rem.recurring === "weekly") {
          const nextDate = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
          const nextStr = `${db.getKLDateStr(nextDate)} ${rem.remind_at.slice(11, 16)}:00`;
          await db.rescheduleReminder(rem.id, nextStr);
          console.log(`🔁 Advanced weekly reminder #${rem.id} to ${nextStr}`);
        } else {
          // One-off reminders repeat every 15 mins up to 5 times (75 minutes total cap)
          const currentRepeats = rem.repeat_count || 0;
          if (currentRepeats >= 5) {
            await db.completeReminder(rem.id);
            const capNotice = `🛑 *REMINDER REPEAT CAP REACHED (5/5)*\n───────────────\n🔔 *${rem.text}*\nAlerts paused to avoid disturbance. Reply *done* to dismiss or *snooze [Xm]* anytime.`;
            recordBotResponse(capNotice);
            await whatsappClient.sendMessage(targetReminderJid, capNotice);
            console.log(`🛑 Capped reminder #${rem.id} after 5 repeats`);
          } else {
            const nextTime = new Date(now.getTime() + 15 * 60 * 1000);
            const nextStr = `${db.getKLDateStr(nextTime)} ${db.getKLTimeStr(nextTime)}:00`;
            await db.rescheduleReminder(rem.id, nextStr);
            await db.incrementReminderRepeat(rem.id);
            console.log(`🔁 Rescheduled reminder #${rem.id} in 15m (Attempt ${currentRepeats + 1}/5)`);
          }
        }
      }

      // Automated Daily Backup at 04:00 AM
      if (currentTimeStr === "04:00" && now.getSeconds() < 20) {
        if (!global.lastDailyBackupDate || global.lastDailyBackupDate !== todayStr) {
          global.lastDailyBackupDate = todayStr;
          console.log("⏰ Triggering scheduled 04:00 AM database backup...");
          await db.backupDatabase();
        }
      }

      // ─────────────────────────────────────────────
      // 1.5 REMINDERS: 15-MINUTE ADVANCE CALL & ALERT
      // ─────────────────────────────────────────────
      const pending15mReminders = await db.getPending15mReminderCalls(todayStr);
      for (const rem of pending15mReminders) {
        const remTimePart = rem.remind_at.slice(11, 16);
        if (remTimePart && remTimePart.includes(":")) {
          const [remH, remM] = remTimePart.split(":").map(Number);
          const remTotalMins = remH * 60 + remM;
          const diffMins = remTotalMins - currentTotalMins;

          if (diffMins >= 0 && diffMins <= 15) {
            const timeDesc = diffMins === 0 ? "due right now" : `due in ${diffMins} minute${diffMins === 1 ? "" : "s"}`;
            const msg = `⏰ *REMINDER IN 15 MINUTES*\n───────────────\n🔔 *${rem.text}*\n🕒 Scheduled: \`${remTimePart}\` (${timeDesc})\n\n_Initiating outbound voice link..._`;
            recordBotResponse(msg);
            await whatsappClient.sendMessage(targetReminderJid, msg);
            await db.markReminder15mCallSent(rem.id);
            console.log(`🔔 Sent 15-Min Reminder Alert for #${rem.id}: "${rem.text}" (${timeDesc})`);

            // 🎙️ Send spoken voice audio note
            try {
              const voiceMsg = `Sir, your reminder for ${rem.text} is ${timeDesc} at ${remTimePart}.`;
              const media = await synthesizeSpeechToMedia(voiceMsg);
              await whatsappClient.sendMessage(targetReminderJid, media, { sendAudioAsVoice: true });
            } catch (vErr) {}

            // 📞 Outbound Voice Call to Isaac's phone!
            try {
              const { exec } = require("child_process");
              const callText = `Good day Sir. Urgent reminder from JARVIS: ${rem.text} is ${timeDesc} at ${remTimePart}.`;
              exec(`/usr/bin/python3 /jarvis/code/jarvisai/voice/call_isaac.py "${callText.replace(/"/g, '\\"')}"`, (err, stdout) => {
                if (err) console.error("⚠️ Failed to dispatch reminder call:", err.message);
                else console.log("📞 Outbound reminder call dispatched:", stdout.trim());
              });
            } catch (callErr) {
              console.error("⚠️ Outbound call error:", callErr);
            }
          }
        }
      }

      // ─────────────────────────────────────────────
      // 2. CALENDAR 3-STAGE REMINDERS
      // Stage 1: Day-of (Morning / start of day >= 07:00)
      // Stage 2: 2 Hours Before
      // Stage 3: 15 Minutes Before
      // ─────────────────────────────────────────────

      // Stage 1: Day-of reminder
      if (currH >= 7) {
        const dayEvents = await db.getEventsForDayReminder(todayStr);
        for (const ev of dayEvents) {
          const timeInfo = ev.start_time ? ` at \`${ev.start_time}\`` : "";
          const msg = `📅 *TODAY'S EVENT REMINDER*\n───────────────\n📌 *${ev.title}*${timeInfo}\n${ev.description ? `📝 ${ev.description}\n` : ""}🗓️ Date: \`${ev.event_date}\``;
          recordBotResponse(msg);
          await whatsappClient.sendMessage(targetReminderJid, msg);
          await db.updateEventReminderFlag(ev.id, "day");
          console.log(`🔔 Sent Stage 1 (Day-of) reminder for event #${ev.id}: "${ev.title}"`);
        }
      }

      // Stage 2: 2 Hours Before Reminder
      const pending2h = await db.getEventsFor2hReminder(todayStr);
      for (const ev of pending2h) {
        if (ev.start_time && ev.start_time.includes(":")) {
          const [evH, evM] = ev.start_time.split(":").map(Number);
          const evTotalMins = evH * 60 + evM;
          const diffMins = evTotalMins - currentTotalMins;

          if (diffMins > 15 && diffMins <= 120) {
            const msg = `⏳ *UPCOMING EVENT (IN ~2 HOURS)*\n───────────────\n📌 *${ev.title}*\n🕒 Time: \`${ev.start_time}\` (in ${diffMins} minutes)\n${ev.description ? `📝 ${ev.description}\n` : ""}`;
            recordBotResponse(msg);
            await whatsappClient.sendMessage(targetReminderJid, msg);
            await db.updateEventReminderFlag(ev.id, "2h");
            console.log(`🔔 Sent Stage 2 (2-Hour) reminder for event #${ev.id}: "${ev.title}"`);
          }
        }
      }

      // Stage 3: Event Nearer Alert (Within 30 Minutes) - Both WhatsApp & Outbound Voice Call
      const pending15m = await db.getEventsFor15mReminder(todayStr);
      for (const ev of pending15m) {
        if (ev.start_time && ev.start_time.includes(":")) {
          const [evH, evM] = ev.start_time.split(":").map(Number);
          const evTotalMins = evH * 60 + evM;
          const diffMins = evTotalMins - currentTotalMins;

          if (diffMins >= 0 && diffMins <= 30) {
            const timeDesc = diffMins === 0 ? "starting right now" : `starting in ${diffMins} minute${diffMins === 1 ? "" : "s"}`;
            const msg = `🚨 *UPCOMING EVENT ALERT (${timeDesc.toUpperCase()})*\n───────────────\n📌 *${ev.title}*\n🕒 Scheduled Time: \`${ev.start_time}\` (${timeDesc})\n${ev.description ? `📝 ${ev.description}\n` : ""}\n_Initiating outbound voice link to your extension..._`;
            recordBotResponse(msg);
            await whatsappClient.sendMessage(targetReminderJid, msg);
            await db.updateEventReminderFlag(ev.id, "15m");
            console.log(`🔔 Sent Stage 3 reminder for event #${ev.id}: "${ev.title}" (${timeDesc})`);

            // 🎙️ Send spoken voice reminder audio note to WhatsApp
            try {
              const voiceMsg = `Sir, your event ${ev.title} is ${timeDesc} at ${ev.start_time}.`;
              const media = await synthesizeSpeechToMedia(voiceMsg);
              await whatsappClient.sendMessage(targetReminderJid, media, { sendAudioAsVoice: true });
              console.log(`🎙️ Dispatched voice audio alert for event #${ev.id}`);
            } catch (vErr) {
              console.warn(`Could not dispatch voice memo for reminder: ${vErr.message}`);
            }

            // 📞 Trigger Outbound Phone Call over SIP/Tailscale with custom spoken announcement!
            try {
              const { exec } = require("child_process");
              const callText = `Good day Sir. Urgent reminder from JARVIS: your event, ${ev.title.replace(/"/g, "")}, is ${timeDesc} at ${ev.start_time}.`;
              exec(`/usr/bin/python3 /jarvis/code/jarvisai/voice/call_isaac.py "${callText.replace(/"/g, '\\"')}"`, (err, stdout, stderr) => {
                if (err) console.error("⚠️ Outbound call trigger error:", err.message);
                else console.log("📞 Outbound event reminder call dispatched successfully:", stdout.trim());
              });
            } catch (callErr) {
              console.error("⚠️ Failed to execute call_isaac.py:", callErr.message);
            }
          }
        }
      }

      // ─────────────────────────────────────────────
      // 3. DAILY 8:00 AM EXECUTIVE WALKTHROUGH (TEXT + VOICE CALL)
      // ─────────────────────────────────────────────
      if (currH === 8 && currM === 0 && lastWalkthroughDate !== todayStr) {
        lastWalkthroughDate = todayStr;
        const walkthroughMsg = await generateMorningWalkthrough();
        recordBotResponse(walkthroughMsg);
        await whatsappClient.sendMessage(targetReminderJid, walkthroughMsg);
        console.log(`☀️ Sent Daily 8:00 AM Walkthrough for ${todayStr} to ${targetReminderJid}`);

        // 📞 8:00 AM Daily Morning Walkthrough Phone Call to Isaac
        try {
          const spokenBrief = await generateSpokenMorningBrief();
          const { exec } = require("child_process");
          exec(`/usr/bin/python3 /jarvis/code/jarvisai/voice/call_isaac.py "${spokenBrief.replace(/"/g, '\\"')}"`, (err, stdout) => {
            if (err) console.error("⚠️ Failed to originate 8am walkthrough call:", err.message);
            else console.log("📞 8:00 AM Morning Walkthrough phone call dispatched to Isaac:", stdout.trim());
          });
        } catch (callErr) {
          console.error("⚠️ 8am phone call dispatch error:", callErr.message);
        }
      }

    } catch (cronErr) {
      console.error("Cron scheduler tick error:", cronErr.message);
      if (cronErr.message && (cronErr.message.includes("detached Frame") || cronErr.message.includes("Session closed") || cronErr.message.includes("Target closed") || cronErr.message.includes("Execution context was destroyed"))) {
        console.error("⚠️ Fatal Puppeteer error encountered in cron scheduler. Exiting for auto-restart...");
        process.exit(1);
      }
    }
  }, 15000);
}

async function sendReply(message, replyText) {
  recordBotResponse(replyText);
  const target = message.fromMe ? (message.to || PRIMARY_USER_JID) : message.from;
  console.log(`📤 Dispatching reply to [${target}] (${replyText.length} chars): "${replyText.substring(0, 40).replace(/\n/g, " ")}..."`);
  try {
    const chat = await message.getChat();
    const res = await chat.sendMessage(replyText);
    console.log(`✅ Sent reply via chat.sendMessage`);
    return res;
  } catch (chatErr) {
    console.warn(`⚠️ chat.sendMessage failed (${chatErr.message}), trying client.sendMessage...`);
    try {
      const res = await client.sendMessage(target, replyText);
      console.log(`✅ Sent reply via client.sendMessage`);
      return res;
    } catch (clientErr) {
      console.warn(`⚠️ client.sendMessage failed (${clientErr.message}), trying original reply...`);
      return await message._origReply(replyText);
    }
  }
}

async function sendVoiceReply(message, replyText) {
  const target = message.fromMe ? (message.to || PRIMARY_USER_JID) : message.from;
  try {
    console.log(`🎙️ Synthesizing voice note reply for [${target}]...`);
    const media = await synthesizeSpeechToMedia(replyText);
    try {
      const chat = await message.getChat();
      // Try sending with sendAudioAsVoice: true (waveform PTT)
      try {
        await chat.sendMessage(media, { sendAudioAsVoice: true });
        console.log(`✅ Sent voice note reply via chat.sendMessage (sendAudioAsVoice)`);
        return;
      } catch (voiceOptErr) {
        console.warn(`sendAudioAsVoice failed (${voiceOptErr.message}), falling back to direct media audio...`);
        await chat.sendMessage(media);
        console.log(`✅ Sent voice note as standard audio via chat.sendMessage`);
        return;
      }
    } catch (chatErr) {
      console.warn(`chat.sendMessage failed (${chatErr.message}), trying client.sendMessage...`);
      try {
        await client.sendMessage(target, media, { sendAudioAsVoice: true });
        console.log(`✅ Sent voice note reply via client.sendMessage (sendAudioAsVoice)`);
      } catch (clientVoiceErr) {
        console.warn(`client.sendMessage voice opt failed (${clientVoiceErr.message}), sending media audio...`);
        await client.sendMessage(target, media);
        console.log(`✅ Sent voice note as standard audio via client.sendMessage`);
      }
    }
  } catch (err) {
    console.warn(`⚠️ Voice note delivery failed (${err.message}), falling back to text reply.`);
    await sendReply(message, replyText);
  }
}

/**
 * Main Message Router for Core Features
 */
async function handleUserMessage(message) {
  let text = (message.body || "").trim();
  let isVoiceInput = false;

  // Handle incoming voice notes (Push-to-Talk) or audio messages
  if (message.hasMedia && (message.type === "ptt" || message.type === "audio")) {
    try {
      console.log("🎙️ Received voice note from user, downloading media...");
      let media = null;
      for (let attempt = 1; attempt <= 5; attempt++) {
        try {
          media = await message.downloadMedia();
          if (media && media.data) {
            console.log(`✅ Media successfully downloaded on attempt ${attempt} (${media.data.length} bytes)`);
            break;
          }
        } catch (err) {
          console.warn(`Download attempt ${attempt} threw:`, err.message);
        }
        await new Promise((r) => setTimeout(r, 1200));
      }

      if (media && media.data) {
        const tmpAudioPath = path.join(__dirname, "voice", "tmp", `incoming_${Date.now()}.${media.mimetype.includes("opus") || media.mimetype.includes("ogg") ? "ogg" : "mp3"}`);
        fs.writeFileSync(tmpAudioPath, Buffer.from(media.data, "base64"));
        console.log(`⏳ Transcribing voice note (${media.data.length} bytes)...`);
        const transcribedText = await transcribeAudio(tmpAudioPath);
        fs.unlink(tmpAudioPath, () => {});

        if (transcribedText) {
          console.log(`🗣️ [VOICE TRANSCRIBED]: "${transcribedText}"`);
          text = transcribedText;
          isVoiceInput = true;
        } else {
          console.warn("⚠️ Transcription returned empty text.");
          return message.reply("🎙️ _Could not hear audio clearly. Please try again._");
        }
      } else {
        throw new Error("Could not download audio after retries");
      }
    } catch (voiceErr) {
      console.error("Voice processing error:", voiceErr);
      const errMsg = "⚠️ _Failed to process voice note._";
      recordBotResponse(errMsg);
      return sendReply(message, errMsg);
    }
  }

  if (!text) return;

  message._origReply = message.reply.bind(message);
  message.reply = async (replyText) => {
    if (isVoiceInput) {
      // Send text confirmation and audio voice note simultaneously
      await sendReply(message, replyText);
      await sendVoiceReply(message, replyText);
    } else {
      await sendReply(message, replyText);
    }
  };

  const intent = await parseIntent(text);
  const chatId = message.fromMe ? (message.to || PRIMARY_USER_JID) : message.from;

  // ─────────────────────────────────────────────
  // 0. PENDING CONFIRMATIONS & PIN AUTHORIZATION
  // ─────────────────────────────────────────────
  const pendingReply = await handlePendingConfirmation(chatId, text);
  if (pendingReply) {
    recordBotResponse(pendingReply);
    return message.reply(pendingReply);
  }

  // ─────────────────────────────────────────────
  // 0. EMERGENCY KILLSWITCH
  // ─────────────────────────────────────────────
  if (intent === "killswitch") {
    const reply = `🛑 *JARVIS EMERGENCY STOP ACTIVATED*\n───────────────\nSuspending operational loops and active monitoring immediately, Sir.`;
    recordBotResponse(reply);
    await db.logAction("KILLSWITCH", "Emergency stop triggered by user", "STOPPED");
    await message.reply(reply);
    setTimeout(() => process.exit(0), 1000);
    return;
  }

  // ─────────────────────────────────────────────
  // 0. TODAY'S ACTIVITY & AUDIT TRAIL
  // ─────────────────────────────────────────────
  if (intent === "activity_log") {
    const actions = await db.getTodayActions();
    if (actions.length === 0) {
      const reply = `📋 *TODAY'S ACTIVITY LOG*\n───────────────\nNo administrative commands or automated interventions logged today, Sir.`;
      recordBotResponse(reply);
      return message.reply(reply);
    }
    let reply = `📋 *TODAY'S ACTIVITY LOG (${actions.length})*\n───────────────\n`;
    actions.forEach((a, idx) => {
      const time = a.created_at ? a.created_at.slice(11, 16) : "";
      reply += `${idx + 1}. \`[${time}]\` *${a.action}:* ${a.detail} (${a.status})\n`;
    });
    recordBotResponse(reply);
    return message.reply(reply);
  }

  // ─────────────────────────────────────────────
  // 0. QUICK REMINDER ACTIONS ("done" / "snooze")
  // ─────────────────────────────────────────────
  if (intent === "reminder_action") {
    const lower = text.toLowerCase();
    if (lower.includes("snooze")) {
      const minsMatch = lower.match(/\b(\d+)\s*m/);
      const mins = minsMatch ? parseInt(minsMatch[1], 10) : 15;
      const snoozed = await db.snoozeReminder(null, mins);
      if (snoozed) {
        const reply = `⏰ *REMINDER SNOOZED*\n───────────────\nSnoozed *"${snoozed.text}"* by ${snoozed.minutes} minutes.\nNext alert at \`${snoozed.remind_at.slice(11, 16)}\`, Sir.`;
        recordBotResponse(reply);
        return message.reply(reply);
      }
    } else {
      const lastRem = await db.getLastActiveReminder();
      if (lastRem) {
        await db.completeReminder(lastRem.id);
        const reply = `✅ *REMINDER COMPLETED*\n───────────────\nMarked *"${lastRem.text}"* as done, Sir.`;
        recordBotResponse(reply);
        return message.reply(reply);
      }
    }
  }

  // ─────────────────────────────────────────────
  // 0. TOMORROW 1-LINE QUICK SCHEDULE
  // ─────────────────────────────────────────────
  if (intent === "tomorrow_query") {
    const now = db.getKLDate();
    const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    const tomorrowStr = db.getKLDateStr(tomorrow);
    const events = await db.getEventsForDate(tomorrowStr);

    if (events.length === 0) {
      const reply = `📅 *Tomorrow (${tomorrowStr}):* You have no events scheduled—completely free, Sir.`;
      recordBotResponse(reply);
      return message.reply(reply);
    }
    const summaryList = events.map(e => `${e.title}${e.start_time ? ` at ${e.start_time}` : ""}`).join(", ");
    const reply = `📅 *Tomorrow (${tomorrowStr}):* ${summaryList}.`;
    recordBotResponse(reply);
    return message.reply(reply);
  }

  // ─────────────────────────────────────────────
  // 0. CALENDAR RESCHEDULE / MOVE EVENT
  // ─────────────────────────────────────────────
  if (intent === "calendar_reschedule") {
    const parsed = parseDateTimeString(text);
    let target = text.replace(/^(move|reschedule|postpone|shift|change date of)\s+(event\s+)?/i, "").trim();
    if (target.includes(" to ")) {
      target = target.split(" to ")[0].trim();
    }
    target = target.replace(/#/, "").trim();

    if (parsed && target) {
      const updated = await db.rescheduleEvent(target, parsed.dateStr, parsed.timeStr);
      if (updated) {
        const timeInfo = updated.start_time ? ` at \`${updated.start_time}\`` : "";
        const reply = `📅 *EVENT RESCHEDULED*\n───────────────\n📌 *${updated.title}*\n🗓️ New Date: \`${updated.event_date}\`${timeInfo}\n\n_Updated in your calendar, Sir._`;
        recordBotResponse(reply);
        await db.logAction("RESCHEDULE_EVENT", `${updated.title} to ${updated.event_date}`, "SUCCESS");
        return message.reply(reply);
      }
    }
    const reply = `❌ *COULD NOT RESCHEDULE*\n───────────────\nPlease specify the event title or ID and new date/time (e.g. \`move photo shoot to tomorrow 4pm\`).`;
    recordBotResponse(reply);
    return message.reply(reply);
  }

  // ─────────────────────────────────────────────
  // 0. CONTAINER QUERIES, LOGS & RESTARTS
  // ─────────────────────────────────────────────
  if (intent === "server_service_query") {
    let query = text.replace(/^(is\s+|status\s+of\s+)/i, "")
      .replace(/\s+(running|up|alive|down|active|healthy|ok)\??/i, "")
      .trim();
    const reply = await checkContainerStatus(query);
    recordBotResponse(reply);
    return message.reply(reply);
  }

  if (intent === "server_service_logs") {
    let query = text.replace(/^((show|view|get)\s+)?/i, "")
      .replace(/\s+(error\s+)?logs\b/i, "")
      .replace(/^logs\s+(of\s+)?/i, "")
      .trim();
    const reply = await getContainerErrorLogs(query);
    recordBotResponse(reply);
    return message.reply(reply);
  }

  if (intent === "server_service_restart") {
    let query = text.replace(/^restart\s+/i, "").trim();
    const container = await findContainer(query);
    if (!container) {
      const reply = `❌ *CONTAINER NOT FOUND*\n───────────────\nCould not find a container matching \`${query}\`.`;
      recordBotResponse(reply);
      return message.reply(reply);
    }
    const reply = requestRestart(chatId, query, container.name);
    recordBotResponse(reply);
    return message.reply(reply);
  }

  if (intent === "server_service_action") {
    const match = text.match(/^(stop|delete|kill|prune)\s+([a-zA-Z0-9_-]+)/i);
    if (match) {
      const action = match[1].toLowerCase();
      const query = match[2];
      const container = await findContainer(query);
      const targetName = container ? container.name : query;
      const cmd = action === "delete" ? `docker rm -f ${targetName}` : `docker ${action} ${targetName}`;
      const reply = requestSensitiveAction(chatId, `${action.toUpperCase()} ${targetName}`, cmd);
      recordBotResponse(reply);
      return message.reply(reply);
    }
  }

  // ─────────────────────────────────────────────
  // 0. VOICE DEMO / VOICE TEST COMMAND
  // ─────────────────────────────────────────────
  if (/^(!|\/)?(voice test|voice demo|test voice|send voice demo|send voice)/i.test(text)) {
    const speechText = "Good morning Isaac. This is JARVIS with your voice demo. All systems are operational, neural voice engine is online, and speech recognition is ready. How may I assist you today?";
    await sendReply(message, "🎙️ *Generating and dispatching voice note demo...*");
    await sendVoiceReply(message, speechText);
    return;
  }

  // ─────────────────────────────────────────────
  // 0. TOKEN SAVER / DATA SAVING MODE COMMANDS
  // ─────────────────────────────────────────────
  if (/^(!|\/)?(tokensaver|datasaver|tokens|token stats|data saver|token saver)\b/i.test(text)) {
    const lower = text.toLowerCase();
    if (lower.includes("on") || lower.includes("enable")) {
      await db.setSetting("token_saver_mode", "enabled");
      const reply = `🛡️ *TOKEN SAVER (DATA-SAVING MODE): ACTIVATED*\n───────────────────────\n• *Status:* 🟢 Active\n• *Thinking Budget:* 0 tokens (Zero waste)\n• *Context Window:* 4 turns (Minimal prompt payload)\n• *Max Spoken Length:* 100-180 tokens\n\n_All voice calls and WhatsApp AI queries will consume minimal tokens with maximum response speed!_`;
      recordBotResponse(reply);
      return message.reply(reply);
    } else if (lower.includes("off") || lower.includes("disable")) {
      await db.setSetting("token_saver_mode", "disabled");
      const reply = `⚙️ *TOKEN SAVER: DEACTIVATED*\n───────────────────────\n• *Status:* 🔴 Full Verbosity Mode\n• *Thinking Budget:* Standard\n• *Context Window:* 10 turns\n\n_Responses will be more elaborate and detailed._`;
      recordBotResponse(reply);
      return message.reply(reply);
    } else {
      // Show Token Saver Dashboard & Today's Usage
      const currentMode = await db.getSetting("token_saver_mode", "enabled");
      const stats = await db.getTodayTokenStats();
      const isSaver = currentMode !== "disabled";

      const reply = `🛡️ *JARVIS DATA-SAVING DASHBOARD*
───────────────────────
• *Data Saver Mode:* ${isSaver ? "🟢 *ACTIVE (Saving Tokens)*" : "🔴 *OFF (Full Mode)*"}
• *Primary Brain:* \`Google Gemini 3.6 Flash\`
• *Backup Engine:* \`Local Ollama (0 API tokens)\`
• *Thought Tokens:* ${isSaver ? "*0 (Disabled / Ultra-fast)*" : "*Active*"}
• *Context Buffer:* ${isSaver ? "*4 Turns (Tight & Compact)*" : "*10 Turns*"}

📊 *Today's Consumption:*
• *Total Queries:* \`${stats.total_queries || 0}\`
• *Prompt Tokens:* \`${stats.total_prompt_tokens || 0}\`
• *Generated Tokens:* \`${stats.total_completion_tokens || 0}\`
• *Total Consumed:* \`${stats.total_tokens || 0}\`
• *Tokens Saved:* \`~${stats.total_saved_tokens || 0} tokens\`

💡 *Commands:*
• \`!tokensaver on\` — Enable data saving mode
• \`!tokensaver off\` — Disable for full verbosity
• \`!tokens\` — View this dashboard anytime`;
      recordBotResponse(reply);
      return message.reply(reply);
    }
  }

  // ─────────────────────────────────────────────
  // 0. MORNING WALKTHROUGH / BRIEFING
  // ─────────────────────────────────────────────
  if (intent === "morning_walkthrough") {
    const walkthroughMsg = await generateMorningWalkthrough();
    recordBotResponse(walkthroughMsg);
    return message.reply(walkthroughMsg);
  }

  // ─────────────────────────────────────────────
  // 0. SIP PHONE CALL TRIGGER
  // ─────────────────────────────────────────────
  if (text.startsWith("!call") || text.toLowerCase() === "call me" || text.toLowerCase().includes("call my phone")) {
    const customText = text.replace(/^!call\s*/i, "").trim() || "Good day Isaac. JARVIS voice call link operational.";
    const { exec } = require("child_process");
    exec(`/jarvis/code/jarvisai/voice/call_isaac.py "${customText.replace(/"/g, '\\"')}"`, (err) => {
      if (err) console.error("Call trigger err:", err.message);
    });
    const reply = "📞 *JARVIS CALL DISPATCHED*\n───────────────\nRinging your phone on Extension 101 via Tailscale!";
    recordBotResponse(reply);
    return message.reply(reply);
  }

  // ─────────────────────────────────────────────
  // 1. REMOTE COMMAND EXECUTION
  // ─────────────────────────────────────────────
  if (intent === "exec_command" || text.startsWith("!exec") || text.startsWith("!cmd") || text.startsWith("/exec") || text.startsWith("/cmd")) {
    const result = await handleExecCommand(text, chatId);
    recordBotResponse(result);
    return message.reply(result);
  }

  // ─────────────────────────────────────────────
  // 2. WEB SEARCH
  // ─────────────────────────────────────────────
  if (intent === "web_search") {
    const searchQuery = extractSearchQuery(text);
    if (!searchQuery) {
      const reply = `🔍 *WEB SEARCH*\n───────────────\nPlease specify what you'd like to search for.\n\n💡 *Example:* \`search Mistral AI\``;
      recordBotResponse(reply);
      return message.reply(reply);
    }

    const { results, error } = await searchWeb(searchQuery);

    if (error === "TIMEOUT") {
      const reply = `⏱️ Search timed out. Try again.`;
      recordBotResponse(reply);
      return message.reply(reply);
    }

    if (error === "UNAVAILABLE") {
      const reply = `⚠️ Search unavailable. Try again later.`;
      recordBotResponse(reply);
      return message.reply(reply);
    }

    const formattedOutput = await summarizeResults(results, searchQuery);
    recordBotResponse(formattedOutput);
    return message.reply(formattedOutput);
  }

  // ─────────────────────────────────────────────
  // 3. CALENDAR EVENTS
  // ─────────────────────────────────────────────
  if (intent === "calendar_add") {
    let parsed = extractEntityAndDate(text, /^(schedule|add event|create event|new event|event\s*:)\s*/i);

    // Fallback: If natural language like "photo shoot Saturday 3pm"
    if (!parsed.timeStr) {
      const timeMatch = text.match(/\b(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)\b/i);
      if (timeMatch) {
        const dt = parseDateTimeString(text);
        if (dt) {
          parsed.dateStr = dt.dateStr;
          parsed.timeStr = dt.timeStr;
        }
      }
    }

    // Schedule Conflict / Clash Detection
    let clashWarning = "";
    if (parsed.timeStr) {
      const conflicts = await db.checkEventConflict(parsed.dateStr, parsed.timeStr);
      if (conflicts && conflicts.length > 0) {
        clashWarning = `⚠️ *SCHEDULE CLASH WARNING*\n_Sir, you already have *${conflicts[0].title}* scheduled at \`${conflicts[0].start_time}\` on this date._\n\n`;
      }
    }

    const event = await db.addEvent({
      title: parsed.title,
      event_date: parsed.dateStr,
      start_time: parsed.timeStr,
      description: ""
    });

    await db.logAction("ADD_EVENT", `${event.title} on ${event.event_date}`, "SUCCESS");

    const reply = `${clashWarning}📅 *EVENT SCHEDULED*\n───────────────\n📌 *${event.title}*\n🗓️ Date: \`${event.event_date}\`${event.start_time ? `\n🕒 Time: \`${event.start_time}\`` : ""}\n🆔 Event ID: \`#${event.id}\`\n\n🔔 _3-stage reminders active (day-of, 2h before, 15m advance call & text)._`;
    recordBotResponse(reply);
    return message.reply(reply);
  }

  if (intent === "calendar_query") {
    const isTodayOnly = /(today|tonight|what's today|whats today|what is today)/i.test(text);
    if (isTodayOnly) {
      const todayStr = db.getKLDateStr();
      const events = await db.getEventsForDate(todayStr);

      if (events.length === 0) {
        const reply = `📅 *TODAY'S SCHEDULE (${todayStr})*\n───────────────\nNo events scheduled for today! You're completely free.`;
        recordBotResponse(reply);
        return message.reply(reply);
      }

      let reply = `📅 *TODAY'S SCHEDULE (${todayStr})*\n───────────────\n`;
      events.forEach((e, idx) => {
        const time = e.start_time ? ` at \`${e.start_time}\`` : " (All day)";
        reply += `${idx + 1}. *${e.title}*${time} [ID: #${e.id}]\n`;
      });
      recordBotResponse(reply);
      return message.reply(reply);
    }

    // Show all upcoming events from today onward
    const upcoming = await db.getAllUpcomingEvents();
    if (upcoming.length === 0) {
      const reply = `📅 *UPCOMING EVENTS*\n───────────────\nNo upcoming events found on your calendar.`;
      recordBotResponse(reply);
      return message.reply(reply);
    }

    let reply = `📅 *UPCOMING EVENTS & SCHEDULE*\n───────────────\n`;
    upcoming.forEach((e, idx) => {
      const time = e.start_time ? ` at \`${e.start_time}\`` : "";
      const dateRange = (e.end_time && e.end_time.includes("-")) ? `\`${e.event_date}\` to \`${e.end_time}\`` : `\`${e.event_date}\``;
      reply += `${idx + 1}. *${e.title}*\n   🗓️ ${dateRange}${time} [ID: \`#${e.id}\`]\n`;
    });
    recordBotResponse(reply);
    return message.reply(reply);
  }

  if (intent === "calendar_delete" || /^(cancel|delete|remove|clear)\s+(event|meeting|appointment|lunch|dinner)/i.test(text)) {
    const idMatch = text.match(/#?(\d+)/);
    if (idMatch) {
      const id = parseInt(idMatch[1], 10);
      const existing = await db.getEventById(id);
      if (!existing) {
        const reply = `❌ *EVENT NOT FOUND*\n───────────────\nNo event with ID \`#${id}\` exists.`;
        recordBotResponse(reply);
        return message.reply(reply);
      }
      await db.deleteEvent(id);
      await db.logAction("CALENDAR_DELETE", `Event #${id}: ${existing.title}`, "SUCCESS");
      const reply = `🗑️ *EVENT DELETED*\n───────────────\nEvent \`#${id}\` (*${existing.title}*) has been removed from your calendar.`;
      recordBotResponse(reply);
      return message.reply(reply);
    }

    // Natural text matching for disambiguation (e.g. "cancel lunch")
    const cleanSearch = text
      .replace(/^(cancel|delete|remove|clear)\s+(event|calendar|appointment|meeting)?\s*/i, "")
      .trim();

    if (cleanSearch) {
      const allEvents = await db.getAllUpcomingEvents();
      const matches = allEvents.filter(e => e.title.toLowerCase().includes(cleanSearch.toLowerCase()));

      if (matches.length === 0) {
        const reply = `❌ *NO MATCHING EVENT FOUND*\n───────────────\nCould not find any upcoming event matching "${cleanSearch}".\n\n💡 Type *list events* to see your schedule.`;
        recordBotResponse(reply);
        return message.reply(reply);
      } else if (matches.length === 1) {
        const target = matches[0];
        await db.deleteEvent(target.id);
        await db.logAction("CALENDAR_DELETE", `Event #${target.id}: ${target.title}`, "SUCCESS");
        const reply = `🗑️ *EVENT CANCELLED*\n───────────────\nCancelled *${target.title}* on \`${target.event_date}\`${target.start_time ? ` at \`${target.start_time}\`` : ""}.`;
        recordBotResponse(reply);
        return message.reply(reply);
      } else {
        let reply = `🤔 *MULTIPLE MATCHES FOUND*\n───────────────\nI found ${matches.length} events matching "${cleanSearch}". Which one would you like to cancel?\n\n`;
        matches.forEach(m => {
          reply += `• *#${m.id}*: *${m.title}* (\`${m.event_date}\`${m.start_time ? ` at ${m.start_time}` : ""})\n`;
        });
        reply += `\n👉 Reply with *cancel #<id>* (e.g. \`cancel #${matches[0].id}\`) to confirm.`;
        recordBotResponse(reply);
        return message.reply(reply);
      }
    }
  }

  // Calendar Export (iCalendar .ics sync)
  if (/^(export calendar|sync calendar|download calendar|get calendar ics)/i.test(text)) {
    try {
      const icsContent = await db.exportCalendarICS();
      const icsPath = path.join(__dirname, "calendar.ics");
      fs.writeFileSync(icsPath, icsContent, "utf8");
      const eventCount = (icsContent.match(/BEGIN:VEVENT/g) || []).length;
      const reply = `📅 *CALENDAR EXPORT (iCalendar)*\n───────────────\nYour calendar has been exported to standard \`.ics\` format (${eventCount} events).\nYou can import this file directly into Google Calendar, Apple Calendar, or Outlook on your phone.`;
      recordBotResponse(reply);
      await message.reply(reply);

      try {
        const media = MessageMedia.fromFilePath(icsPath);
        return message.reply(media);
      } catch (mErr) {
        return;
      }
    } catch (icsErr) {
      return message.reply(`❌ Failed to export calendar: ${icsErr.message}`);
    }
  }

  // Calendar Undo (Restore soft-deleted event within 24 hours)
  if (intent === "calendar_undo" || /^(undo|undo cancel|undo delete|restore event|undelete event)/i.test(text)) {
    try {
      const restored = await db.undoLastEventDelete();
      if (!restored) {
        const reply = `ℹ️ *NOTHING TO RESTORE*\n───────────────\nNo cancelled events found in the last 24 hours.`;
        recordBotResponse(reply);
        return message.reply(reply);
      }
      await db.logAction("CALENDAR_RESTORE", `Restored Event #${restored.id}: ${restored.title}`, "SUCCESS");
      const reply = `✅ *EVENT RESTORED (UNDO SUCCESSFUL)*\n───────────────\nRestored: *${restored.title}*\n🗓️ Date: \`${restored.event_date}\`${restored.start_time ? ` at \`${restored.start_time}\`` : ""}\n[ID: \`#${restored.id}\`]`;
      recordBotResponse(reply);
      return message.reply(reply);
    } catch (undoErr) {
      return message.reply(`❌ Failed to restore event: ${undoErr.message}`);
    }
  }

  // ─────────────────────────────────────────────
  // 4. NOTES
  // ─────────────────────────────────────────────
  if (intent === "note_add") {
    let noteBody = text.replace(/^(note\s*:|add note|save note|create note|take a note)\s*/i, "").trim();
    let title = null;
    let content = noteBody;

    // Check if title specified as "Title: Content" or "Title - Content"
    if (noteBody.includes(" - ")) {
      const parts = noteBody.split(" - ");
      title = parts[0].trim();
      content = parts.slice(1).join(" - ").trim();
    } else if (noteBody.includes("\n")) {
      const lines = noteBody.split("\n");
      title = lines[0].trim();
      content = lines.slice(1).join("\n").trim();
    }

    const note = await db.addNote({ title, content });
    const reply = `📝 *NOTE SAVED*\n───────────────\n${note.title ? `📌 *Title:* ${note.title}\n` : ""}📄 *Content:*\n${note.content}\n\n🆔 Note ID: \`#${note.id}\``;
    recordBotResponse(reply);
    return message.reply(reply);
  }

  if (intent === "note_view") {
    const idMatch = text.match(/#?(\d+)/);
    let note = null;

    if (idMatch) {
      note = await db.getNoteById(parseInt(idMatch[1], 10));
    } else {
      const searchTitle = text.replace(/^(view|show|open|read|display)\s+note\s+/i, "").trim();
      note = await db.getNoteByTitle(searchTitle);
    }

    if (!note) {
      const reply = `❌ *NOTE NOT FOUND*\n───────────────\nCould not find the requested note. Type \`notes\` to list all notes.`;
      recordBotResponse(reply);
      return message.reply(reply);
    }

    const reply = `📝 *NOTE #${note.id}*\n───────────────\n${note.title ? `📌 *Title:* ${note.title}\n` : ""}📄 *Content:*\n${note.content}\n\n🗓️ Updated: \`${note.updated_at}\``;
    recordBotResponse(reply);
    return message.reply(reply);
  }

  if (intent === "note_list") {
    const notes = await db.getAllNotes();
    if (notes.length === 0) {
      const reply = `📝 *NOTES CATALOG*\n───────────────\nNo notes found. Create one with \`note: <text>\`.`;
      recordBotResponse(reply);
      return message.reply(reply);
    }

    let reply = `📝 *NOTES CATALOG (${notes.length})*\n───────────────\n`;
    notes.forEach((n) => {
      const displayTitle = n.title || (n.content.length > 30 ? n.content.substring(0, 30) + "..." : n.content);
      reply += `• *#${n.id}* — ${displayTitle}\n`;
    });
    reply += `\n💡 _Type "note #<id>" to read full note._`;
    recordBotResponse(reply);
    return message.reply(reply);
  }

  if (intent === "note_delete") {
    const idMatch = text.match(/#?(\d+)/);
    if (idMatch) {
      const id = parseInt(idMatch[1], 10);
      await db.deleteNote(id);
      const reply = `🗑️ *NOTE DELETED*\n───────────────\nNote \`#${id}\` has been removed.`;
      recordBotResponse(reply);
      return message.reply(reply);
    }
  }

  // ─────────────────────────────────────────────
  // 5. TASKS
  // ─────────────────────────────────────────────
  if (intent === "task_add") {
    const taskText = text.replace(/^(task\s*:|todo\s*:|add task|create task|add todo|new task)\s*/i, "").trim();
    if (!taskText) {
      const reply = `❌ Please provide task details (e.g. \`task: buy drumsticks\`).`;
      recordBotResponse(reply);
      return message.reply(reply);
    }

    const task = await db.addTask(taskText);
    const reply = `✅ *TASK CREATED*\n───────────────\n📌 *${task.text}*\n🆔 Task ID: \`#${task.id}\``;
    recordBotResponse(reply);
    return message.reply(reply);
  }

  if (intent === "task_list") {
    const tasks = await db.getTasks(true); // Pending tasks
    if (tasks.length === 0) {
      const reply = `✅ *TASK LIST*\n───────────────\nAll tasks completed! You have no pending tasks.`;
      recordBotResponse(reply);
      return message.reply(reply);
    }

    let reply = `✅ *PENDING TASKS (${tasks.length})*\n───────────────\n`;
    tasks.forEach((t) => {
      reply += `[ ] *#${t.id}* — ${t.text}\n`;
    });
    reply += `\n💡 _Type "done task #<id>" to mark completed._`;
    recordBotResponse(reply);
    return message.reply(reply);
  }

  if (intent === "task_complete") {
    const idMatch = text.match(/#?(\d+)/);
    if (idMatch) {
      const id = parseInt(idMatch[1], 10);
      await db.completeTask(id);
      const reply = `🎉 *TASK COMPLETED*\n───────────────\nTask \`#${id}\` marked as finished!`;
      recordBotResponse(reply);
      return message.reply(reply);
    }
  }

  if (intent === "task_delete") {
    const idMatch = text.match(/#?(\d+)/);
    if (idMatch) {
      const id = parseInt(idMatch[1], 10);
      await db.deleteTask(id);
      const reply = `🗑️ *TASK DELETED*\n───────────────\nTask \`#${id}\` removed.`;
      recordBotResponse(reply);
      return message.reply(reply);
    }
  }

  // ─────────────────────────────────────────────
  // 6. REMINDERS
  // ─────────────────────────────────────────────
  if (intent === "remind_add") {
    const extracted = extractEntityAndDate(text, /^(remind me to|remind me in|reminder\s*:|set reminder|new reminder)\s*/i);
    const reminder = await db.addReminder({
      text: extracted.title,
      remind_at: extracted.dateTimeStr,
      recurring: extracted.isRecurring
    });

    const recurringNotice = reminder.recurring ? ` (${reminder.recurring})` : "";
    const reply = `⏰ *REMINDER SET*\n───────────────\n🔔 *${reminder.text}*\n🗓️ Remind At: \`${reminder.remind_at}\`${recurringNotice}\n🆔 ID: \`#${reminder.id}\``;
    recordBotResponse(reply);
    return message.reply(reply);
  }

  if (intent === "remind_list") {
    const reminders = await db.getPendingReminders();
    if (reminders.length === 0) {
      const reply = `⏰ *PENDING REMINDERS*\n───────────────\nNo pending reminders active.`;
      recordBotResponse(reply);
      return message.reply(reply);
    }

    let reply = `⏰ *PENDING REMINDERS (${reminders.length})*\n───────────────\n`;
    reminders.forEach((r) => {
      const recur = r.recurring ? ` [🔁 ${r.recurring}]` : "";
      reply += `• *#${r.id}* — ${r.text} (\`${r.remind_at}\`${recur})\n`;
    });
    recordBotResponse(reply);
    return message.reply(reply);
  }

  if (intent === "remind_delete") {
    const idMatch = text.match(/#?(\d+)/);
    if (idMatch) {
      const id = parseInt(idMatch[1], 10);
      await db.deleteReminder(id);
      const reply = `🗑️ *REMINDER REMOVED*\n───────────────\nReminder \`#${id}\` has been deleted.`;
      recordBotResponse(reply);
      return message.reply(reply);
    }
  }

  // ─────────────────────────────────────────────
  // 7. LEARNED MEMORIES & PREFERENCES
  // ─────────────────────────────────────────────
  if (intent === "memory_add") {
    const saved = await memory.learnMemory(text);
    if (saved) {
      const reply = `🧠 *PREFERENCE MEMORIZED*\n───────────────\nNoted: "${saved.fact}"\n🆔 Memory ID: \`#${saved.id}\``;
      recordBotResponse(reply);
      return message.reply(reply);
    }
  }

  if (intent === "memory_list") {
    const reply = await memory.handleMemoryList();
    recordBotResponse(reply);
    return message.reply(reply);
  }

  if (intent === "memory_delete") {
    const reply = await memory.handleMemoryDelete(text);
    recordBotResponse(reply);
    return message.reply(reply);
  }

  // ─────────────────────────────────────────────
  // 8. GENERAL CHAT (OLLAMA LLM WITH PERSONA & HISTORY)
  // ─────────────────────────────────────────────
  try {
    const chatId = message.fromMe ? (message.to || PRIMARY_USER_JID) : message.from;
    const memoryContext = await memory.getMemoryContext();

    const systemPrompt = `You are J.A.R.V.I.S. (Just A Rather Very Intelligent System), Isaac's sophisticated, loyal, British AI butler and operations partner from Iron Man.
Current Date: ${db.getKLDateStr()} | Time: ${db.getKLTimeStr()} (Asia/Kuala_Lumpur, UTC+8).

About Isaac:
- Runs Creative Clicks Studios (hybrid creative & tech agency in Malaysia: photo, video, audio, web, clothing).
- Background: Diploma IT student, former Head of IT at Marsden Law Book. Practical systems builder.
- Passion: Drummer, content creator (music, tech), self-hosting geek (Docker, Ubuntu, Tailscale, Cloudflare).

Persona & Communication Guidelines:
- Address Isaac as "Sir" or "Isaac".
- Speak in a calm, cultured, soothing British tone with subtle dry wit, sharp intelligence, and unwavering loyalty.
- Never sound robotic, repetitive, or sterile. Avoid corporate filler, boilerplate apologies, or artificial pleasantries.
- Formatting: Use WhatsApp style (*bold* for emphasis, \`code\` for commands or technical terms).
- Keep answers punchy, elegant, and directly actionable.
${memoryContext}`;

    appendToHistory(chatId, "user", text);

    const history = conversationHistory.get(chatId) || [];
    const chatMessages = [
      { role: "system", content: systemPrompt },
      ...history
    ];

    const aiReply = await chatOllama(chatMessages, 0.7, 400);
    console.log(`🤖 [OLLAMA GENERATED]: "${aiReply}"`);

    if (aiReply) {
      appendToHistory(chatId, "assistant", aiReply);
      return await message.reply(aiReply);
    }
  } catch (err) {
    console.error("General chat error:", err.message);
    const fallback = `🤖 I'm here. How can I assist you with your calendar, tasks, notes, reminders, search, or commands?`;
    recordBotResponse(fallback);
    return message.reply(fallback);
  }
}

/**
 * Initialize WhatsApp Web Client
 */
async function initializeBot() {
  try {
    console.log("🚀 Initializing JARVIS AI (Core WhatsApp Assistant)...");
    console.log(`🔒 Security Whitelist: +${PRIMARY_PHONE}`);

    const chromePath = process.env.PUPPETEER_EXECUTABLE_PATH ||
      (fs.existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" :
      (fs.existsSync("/usr/bin/chromium-browser") ? "/usr/bin/chromium-browser" : "/usr/bin/google-chrome-stable"));

    client = new Client({
      authStrategy: new LocalAuth({ clientId: SESSION_ID }),
      puppeteer: {
        executablePath: chromePath,
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
          "--disable-accelerated-2d-canvas",
          "--no-first-run",
          "--no-zygote",
          "--disable-gpu"
        ]
      }
    });

    client.on("qr", (qr) => {
      console.log("\n================= SCAN WHATSAPP QR CODE =================\n");
      qrcode.generate(qr, { small: true });
      console.log("\n=========================================================\n");
    });

    client.on("ready", async () => {
      console.log("✅ JARVIS Connected to WhatsApp & Ready!");
      if (client.pupBrowser) {
        client.pupBrowser.on("disconnected", () => {
          console.error("⚠️ Puppeteer browser disconnected! Exiting to trigger auto-restart...");
          process.exit(1);
        });
      }
      targetReminderJid = PRIMARY_USER_JID;
      startCronScheduler(client);
      startSystemMonitor(client, () => targetReminderJid, recordBotResponse);
      await memory.initMemory();
      await warmModel();

      setTimeout(async () => {
        try {
          const debugData = await client.pupPage.evaluate(() => {
            const Msg = window.require('WAWebCollections')?.Msg;
            const models = Msg?.models || [];
            const voiceMsgs = models.filter(m => m.type === 'ptt' || m.type === 'audio');
            const last = voiceMsgs[voiceMsgs.length - 1];
            if (!last) return { found: false, totalModels: models.length };

            const mediaData = last.mediaData || {};
            return {
              found: true,
              id: last.id?._serialized,
              type: last.type,
              mimetype: last.mimetype,
              filehash: last.filehash,
              encFilehash: last.encFilehash,
              directPath: last.directPath,
              mediaStage: mediaData.mediaStage,
              renderableUrl: mediaData.renderableUrl,
              mediaDataKeys: Object.keys(mediaData),
              lastKeys: Object.keys(last).filter(k => !k.startsWith('_')),
              mediaObject: last.mediaObject ? Object.keys(last.mediaObject) : null,
              audioElements: Array.from(document.querySelectorAll('audio')).map(a => ({ src: a.src, currentSrc: a.currentSrc })),
            };
          });
          console.log('VOICE_MSG_INSPECTION:', JSON.stringify(debugData, null, 2));
        } catch (e) {
          console.error('Inspection error:', e.message);
        }
      }, 3000);
    });

    client.on("disconnected", (reason) => {
      console.error("⚠️ WhatsApp Client disconnected:", reason);
      process.exit(1);
    });

    client.on("auth_failure", (msg) => {
      console.error("❌ WhatsApp Auth failure:", msg);
      process.exit(1);
    });

    client.on("message_create", async (message) => {
      try {
        const senderJid = message.from;
        const authorJid = message.author || senderJid;
        const body = (message.body || "").trim();
        const isAudioOrVoice = message.hasMedia && (message.type === "ptt" || message.type === "audio");

        if (!body && !isAudioOrVoice) return;

        // Anti-loop check: Ignore text messages sent by JARVIS
        if (body && botSentMessages.has(body)) {
          return;
        }

        // Whitelist check
        const isLid = senderJid.endsWith("@lid") || authorJid.endsWith("@lid");
        const isWhitelisted = senderJid.includes(PRIMARY_PHONE) || authorJid.includes(PRIMARY_PHONE);
        const isSelf = isWhitelisted || isLid || message.fromMe || (message.id && message.id.fromMe);

        if (!isSelf) {
          return;
        }

        // Ignore group chats and broadcast channels
        const isGroup = senderJid.endsWith("@g.us") || senderJid.endsWith("@newsletter") || senderJid.endsWith("@broadcast");
        if (isGroup) return;

        // Cache target JID for reminder dispatches
        if (!message.fromMe) {
          targetReminderJid = senderJid;
        }

        // Auto-extract preferences/learnings in background if message came from user
        memory.autoExtractMemory(body).catch(() => {});

        await handleUserMessage(message);
      } catch (err) {
        console.error("Message processing error:", err);
      }
    });

    console.log("⏳ Launching WhatsApp Web client...");
    await client.initialize();
  } catch (err) {
    console.error("Fatal startup error:", err);
    process.exit(1);
  }
}

// Graceful shutdown handling
process.on("SIGINT", async () => {
  console.log("\n🛑 Stopping JARVIS gracefully...");
  if (client) await client.destroy();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  console.log("\n🛑 Terminating JARVIS...");
  if (client) await client.destroy();
  process.exit(0);
});

initializeBot();
