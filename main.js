const { Client, LocalAuth } = require("whatsapp-web.js");
const qrcode = require("qrcode-terminal");
const fs = require("fs");
require("dotenv").config();

const { queryOllama, warmModel } = require("./ollama");
const db = require("./db");
const { parseIntent, extractEntityAndDate, parseDateTimeString, extractSearchQuery } = require("./intents");
const { handleExecCommand } = require("./cmd_runner");
const { searchWeb, summarizeResults } = require("./search");

process.env.TZ = process.env.TZ || "Asia/Kuala_Lumpur";

const SESSION_ID = process.env.SESSION_ID || "isaac_ai_session";
const PRIMARY_PHONE = process.env.PRIMARY_PHONE || "60176001484";
const PRIMARY_USER_JID = process.env.PRIMARY_USER_JID || `${PRIMARY_PHONE}@c.us`;

let client;
let targetReminderJid = PRIMARY_USER_JID;
const botSentMessages = new Set();

function recordBotResponse(text) {
  if (!text) return;
  botSentMessages.add(text.trim());
  if (botSentMessages.size > 100) {
    const first = botSentMessages.values().next().value;
    botSentMessages.delete(first);
  }
}

/**
 * 3-Stage Event Reminders & Timed Reminders Cron Loop (Runs every 60s)
 */
function startCronScheduler(whatsappClient) {
  console.log("⏰ Starting 60s Cron Scheduler for Events & Reminders (UTC+8)...");

  setInterval(async () => {
    try {
      if (!whatsappClient || !whatsappClient.pupPage) return;

      const now = db.getKLDate();
      const todayStr = db.getKLDateStr(now);
      const currentTimeStr = db.getKLTimeStr(now); // "HH:MM"
      const [currH, currM] = currentTimeStr.split(":").map(Number);
      const currentTotalMins = currH * 60 + currM;

      // ─────────────────────────────────────────────
      // 1. SIMPLE REMINDERS
      // ─────────────────────────────────────────────
      const dueReminders = await db.getDueReminders(`${todayStr} ${currentTimeStr}:59`);
      for (const rem of dueReminders) {
        const reminderMsg = `⏰ *JARVIS REMINDER*\n───────────────\n🔔 *${rem.text}*\n\n📅 Scheduled: \`${rem.remind_at}\``;
        recordBotResponse(reminderMsg);
        await whatsappClient.sendMessage(targetReminderJid, reminderMsg);

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
          await db.completeReminder(rem.id);
          console.log(`✅ Dispatched reminder #${rem.id}: "${rem.text}"`);
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

      // Stage 3: 15 Minutes Before Reminder
      const pending15m = await db.getEventsFor15mReminder(todayStr);
      for (const ev of pending15m) {
        if (ev.start_time && ev.start_time.includes(":")) {
          const [evH, evM] = ev.start_time.split(":").map(Number);
          const evTotalMins = evH * 60 + evM;
          const diffMins = evTotalMins - currentTotalMins;

          if (diffMins >= 0 && diffMins <= 15) {
            const msg = `🚨 *EVENT STARTING SOON (15 MIN)*\n───────────────\n📌 *${ev.title}*\n🕒 Starting at: \`${ev.start_time}\`\n${ev.description ? `📝 ${ev.description}` : ""}`;
            recordBotResponse(msg);
            await whatsappClient.sendMessage(targetReminderJid, msg);
            await db.updateEventReminderFlag(ev.id, "15m");
            console.log(`🔔 Sent Stage 3 (15-Min) reminder for event #${ev.id}: "${ev.title}"`);
          }
        }
      }

    } catch (cronErr) {
      console.error("Cron scheduler tick error:", cronErr.message);
    }
  }, 60000);
}

/**
 * Main Message Router for Core Features
 */
async function handleUserMessage(message) {
  const text = (message.body || "").trim();
  if (!text) return;

  const intent = await parseIntent(text);
  console.log(`📨 [INTENT: ${intent}] "${text}"`);

  // ─────────────────────────────────────────────
  // 1. REMOTE COMMAND EXECUTION
  // ─────────────────────────────────────────────
  if (intent === "exec_command" || text.startsWith("!exec") || text.startsWith("!cmd") || text.startsWith("/exec") || text.startsWith("/cmd")) {
    const result = await handleExecCommand(text);
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

    if (!results || results.length === 0) {
      const reply = `🔍 *Results for '${searchQuery}':*\n\nNo results found for '${searchQuery}'. Try different keywords.`;
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

    const event = await db.addEvent({
      title: parsed.title,
      event_date: parsed.dateStr,
      start_time: parsed.timeStr,
      description: ""
    });

    const reply = `📅 *EVENT SCHEDULED*\n───────────────\n📌 *${event.title}*\n🗓️ Date: \`${event.event_date}\`${event.start_time ? `\n🕒 Time: \`${event.start_time}\`` : ""}\n🆔 Event ID: \`#${event.id}\`\n\n🔔 _3-stage reminders active (day-of, 2h before, 15m before)._`;
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

    // Default: Next 7 days
    const upcoming = await db.getUpcomingEvents(7);
    if (upcoming.length === 0) {
      const reply = `📅 *UPCOMING EVENTS (NEXT 7 DAYS)*\n───────────────\nNo upcoming events found.`;
      recordBotResponse(reply);
      return message.reply(reply);
    }

    let reply = `📅 *UPCOMING EVENTS (7 DAYS)*\n───────────────\n`;
    upcoming.forEach((e, idx) => {
      const time = e.start_time ? ` at \`${e.start_time}\`` : "";
      reply += `${idx + 1}. *${e.title}* — \`${e.event_date}\`${time} [ID: #${e.id}]\n`;
    });
    recordBotResponse(reply);
    return message.reply(reply);
  }

  if (intent === "calendar_delete") {
    const idMatch = text.match(/#?(\d+)/);
    if (idMatch) {
      const id = parseInt(idMatch[1], 10);
      await db.deleteEvent(id);
      const reply = `🗑️ *EVENT DELETED*\n───────────────\nEvent \`#${id}\` has been removed from your calendar.`;
      recordBotResponse(reply);
      return message.reply(reply);
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
  // 7. GENERAL CHAT (OLLAMA LLM)
  // ─────────────────────────────────────────────
  try {
    const systemPrompt = `You are JARVIS, a personal autonomous AI assistant.
Keep answers concise, direct, and helpful. Use WhatsApp formatting (*bold* for emphasis). Never use AI pleasantries or robotic disclaimers. Current timezone is Asia/Kuala_Lumpur (UTC+8). Current date: ${db.getKLDateStr()}.`;

    const aiReply = await queryOllama(text, 0.7, 200, systemPrompt);
    if (aiReply) {
      recordBotResponse(aiReply);
      return message.reply(aiReply);
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
      targetReminderJid = PRIMARY_USER_JID;
      startCronScheduler(client);
      await warmModel();
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

        if (!body) return;

        // Anti-loop check: Ignore messages sent by JARVIS
        if (botSentMessages.has(body)) {
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
