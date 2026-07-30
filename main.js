const { Client, LocalAuth } = require("whatsapp-web.js");
const qrcode = require("qrcode-terminal");
const fs = require("fs");
const path = require("path");
require("dotenv").config();

const { queryOllama, warmModel } = require("./ollama");
const db = require("./db");
const { searchWeb } = require("./search");
const { checkServers } = require("./server_health");
const { handleQuotationGen } = require("./quotations");
const { parseIntent } = require("./intents");
const {
  initMemory,
  learnMemory,
  autoExtractMemory,
  getMemoryContext,
  handleMemoryList,
  handleMemoryDelete
} = require("./memory");

const SESSION_ID = process.env.SESSION_ID || "isaac_ai_session";
const PRIMARY_PHONE = process.env.PRIMARY_PHONE || "60176001484";
const PRIMARY_USER_JID = process.env.PRIMARY_USER_JID || `${PRIMARY_PHONE}@c.us`;

// Load Agent Profile (Isaac's Complete Profile)
const AGENT_PROFILE_PATH = path.join(__dirname, "AGENT.md");
let agentProfile = "";
if (fs.existsSync(AGENT_PROFILE_PATH)) {
  agentProfile = fs.readFileSync(AGENT_PROFILE_PATH, "utf8");
}

let client;
let conversationHistory = {};
let targetReminderJid = PRIMARY_USER_JID;

// Cache to prevent self-looping on bot's own dispatched messages
const botSentMessages = new Set();

function recordBotResponse(text) {
  if (!text) return;
  botSentMessages.add(text.trim());
  if (botSentMessages.size > 100) {
    const first = botSentMessages.values().next().value;
    botSentMessages.delete(first);
  }
}

// Main initialization
async function initializeBot() {
  try {
    console.log("🚀 Initializing WhatsApp Bot...");
    console.log(`🔒 Security active: Restricting responses exclusively to +${PRIMARY_PHONE}`);

    const chromePath = process.env.PUPPETEER_EXECUTABLE_PATH || (fs.existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : (fs.existsSync("/usr/bin/chromium-browser") ? "/usr/bin/chromium-browser" : "/usr/bin/google-chrome-stable"));

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
      console.log("✅ WhatsApp Connected & Ready!");
      await initMemory();
      startReminderScheduler(client);
      startMorningDigestCron(client);
      // Pre-warm the LLM so the first message is fast
      await warmModel();
    });

    // --- WHATSAPP CALL HANDLER ---
    client.on("call", async (call) => {
      try {
        console.log(`📞 Incoming call from ${call.from}`);
        await call.reject();
        const callReply = `📞 *CALL RECEIVED*\n───────────────\nHey Isaac! I detected your call. I'm operating as your AI Assistant (JARVIS).\n\nText me your request here and I'll process it immediately!`;
        recordBotResponse(callReply);
        await client.sendMessage(call.from, callReply);
      } catch (err) {
        console.error("Call handling error:", err.message);
      }
    });

    // Helper to set WhatsApp typing state cleanly
    async function setTypingState(client, chatId, state = "typing") {
      try {
        if (!client || !client.pupPage) return;
        await client.pupPage.evaluate(async (id, st) => {
          if (window.WWebJS && typeof window.WWebJS.sendChatstate === "function") {
            await window.WWebJS.sendChatstate(st, id);
          }
        }, chatId, state);
      } catch (err) {
        // Ignore typing presence errors
      }
    }

    client.on("message_create", async (message) => {
      try {
        const senderJid = message.from;
        const authorJid = message.author || senderJid;
        const body = message.body ? message.body.trim() : "";

        // ABSOLUTE ANTI-LOOP CHECK: If message text matches a response sent by the bot, ignore it!
        if (botSentMessages.has(body)) {
          return;
        }

        // Whitelist Check: Allow messages from Isaac (+60176001484 or @lid Linked Devices)
        const isLid = senderJid.endsWith("@lid") || authorJid.endsWith("@lid");
        const isIsaacPhone = senderJid.includes(PRIMARY_PHONE) || authorJid.includes(PRIMARY_PHONE);
        const isIsaac = isIsaacPhone || isLid || message.fromMe || (message.id && message.id.fromMe);

        if (!isIsaac) {
          console.log(`⛔ [SECURITY] Blocked unauthorized message from: ${senderJid}`);
          return;
        }

        const isGroup = senderJid.endsWith("@g.us") || senderJid.endsWith("@newsletter") || senderJid.endsWith("@broadcast");
        if (isGroup) return;

        targetReminderJid = senderJid;

        // Handle Audio / Voice Notes
        if (message.hasMedia && (message.type === "audio" || message.type === "ptt")) {
          setTypingState(client, senderJid, "typing");
          const voiceReply = `🎙️ *VOICE NOTE RECEIVED*\n───────────────\nI've received your voice note, Isaac! Audio command processing is active. If you need a specific task or note created, you can also text me directly.`;
          recordBotResponse(voiceReply);
          setTypingState(client, senderJid, "stop");
          await client.sendMessage(senderJid, voiceReply);
          return;
        }

        if (!body) return;

        // Silently extract preferences & habits to memory file in background
        autoExtractMemory(body);

        console.log(`📨 [ISAAC - ${senderJid}] ${body}`);

        setTypingState(client, senderJid, "typing");

        const response = await processMessage(body, senderJid, client);

        setTypingState(client, senderJid, "stop");
        recordBotResponse(response); // Cache before sending to prevent self-trigger
        await client.sendMessage(senderJid, response);
        console.log(`📤 [TO ISAAC] ${response}`);

        if (!conversationHistory[senderJid]) {
          conversationHistory[senderJid] = [];
        }
        conversationHistory[senderJid].push({
          user: body,
          assistant: response,
          timestamp: new Date()
        });

        if (conversationHistory[senderJid].length > 10) {
          conversationHistory[senderJid].shift();
        }

      } catch (error) {
        console.error(`❌ Error handling message: ${error.message}`);
        try {
          if (message && message.from) {
            setTypingState(client, message.from, "stop");
            const errReply = "❌ Error processing message. Please try again.";
            recordBotResponse(errReply);
            await client.sendMessage(message.from, errReply);
          }
        } catch (sendErr) {
          console.error("Failed to send error response:", sendErr.message);
        }
      }
    });

    await client.initialize();

  } catch (error) {
    console.error("Connection error:", error);
    process.exit(1);
  }
}

// Background Reminder Scheduler (Multi-Stage: Day-Of, 2-Hours Before, Imminent Start)
function startReminderScheduler(client) {
  console.log(`⏰ Multi-Stage Reminder Scheduler Active -> Primary Contact: ${targetReminderJid}`);
  
  const checkReminders = async () => {
    try {
      if (!targetReminderJid) return;

      const klNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kuala_Lumpur' }));

      // Helper to calculate minutes until event
      const getMinsUntil = (event) => {
        if (!event.start_time) return 0;
        const [h, m] = event.start_time.split(':').map(Number);
        const [eY, eM, eD] = event.event_date.split('-').map(Number);
        const evtTime = new Date(eY, eM - 1, eD, h, m, 0, 0);
        return Math.floor((evtTime.getTime() - klNow.getTime()) / 60000);
      };

      // 1. STAGE 1: Day-Of Notification (Fires on the day of event)
      const dayEvents = await db.getDueDayReminders();
      for (const event of dayEvents) {
        const minsUntil = getMinsUntil(event);
        const reminderMsg = `☀️ *TODAY'S EVENT REMINDER*\n───────────────\n📌 *Event:* ${event.title}\n📆 *Date:* Today (\`${event.event_date}\`)\n⏰ *Time:* \`${event.start_time || "10:00"}\`\n${event.description ? "📝 *Description:* " + event.description + "\n" : ""}${event.recipient_phone ? "👤 *Client Contact:* `" + event.recipient_phone + "`\n" : ""}🆔 *ID:* \`#${event.id}\`
\n💡 _I will remind you again 2 hours before the start time._`;

        recordBotResponse(reminderMsg);
        await client.sendMessage(targetReminderJid, reminderMsg);
        await db.markReminderDaySent(event.id);
        console.log(`🔔 Sent Day-Of reminder for Event #${event.id} to Isaac`);
      }

      // 2. STAGE 2: 2 Hours (120 Mins) Before Event
      const twoHourEvents = await db.getDue2HourReminders();
      for (const event of twoHourEvents) {
        const minsUntil = getMinsUntil(event);
        const reminderMsg = `⏰ *UPCOMING EVENT REMINDER (2 HOURS BEFORE)*\n───────────────\n⏳ *STARTING IN ~2 HOURS* (\`${minsUntil} mins\`)\n📌 *Event:* ${event.title}\n📆 *Date:* \`${event.event_date}\`\n⏰ *Time:* \`${event.start_time || "10:00"}\`\n${event.description ? "📝 *Description:* " + event.description + "\n" : ""}${event.recipient_phone ? "👤 *Client Contact:* `" + event.recipient_phone + "`\n" : ""}🆔 *ID:* \`#${event.id}\``;

        recordBotResponse(reminderMsg);
        await client.sendMessage(targetReminderJid, reminderMsg);

        if (event.recipient_phone) {
          let cleanPhone = event.recipient_phone.replace(/[\s\-\+]/g, "").trim();
          if (cleanPhone.startsWith("0")) cleanPhone = "60" + cleanPhone.substring(1);
          const clientJid = `${cleanPhone}@c.us`;
          const clientMsg = `📅 *EVENT REMINDER - CREATIVE CLICKS STUDIOS*\n───────────────\n⏳ *Reminder:* Starting in ~2 hours (\`${event.start_time || "10:00"}\`)\n📌 *Event:* ${event.title}\n📆 *Date:* \`${event.event_date}\`\n\nSee you soon!`;
          try {
            recordBotResponse(clientMsg);
            await client.sendMessage(clientJid, clientMsg);
            console.log(`🔔 Sent 2-hour client reminder for Event #${event.id} to ${clientJid}`);
          } catch (cErr) {
            console.error(`Failed to send client 2-hour notification to ${clientJid}:`, cErr.message);
          }
        }

        await db.markReminder2HSent(event.id);
        console.log(`🔔 Sent 2-Hour reminder for Event #${event.id} to Isaac`);
      }

      // 3. STAGE 3: Imminent Start (15-30 Mins Before / Starting Now)
      const imminentEvents = await db.getPendingEventReminders(30);
      for (const event of imminentEvents) {
        const minsUntil = getMinsUntil(event);
        const urgencyTag = minsUntil <= 5 ? '🔴 *STARTING NOW*' : `🟡 *STARTING SOON* (\`~${minsUntil} mins\`)`;
        const reminderMsg = `⏰ *IMMINENT EVENT REMINDER*\n───────────────\n${urgencyTag}\n📌 *Event:* ${event.title}\n📆 *Date:* \`${event.event_date}\`\n⏰ *Time:* \`${event.start_time || "10:00"}\`\n${event.description ? "📝 *Description:* " + event.description + "\n" : ""}🆔 *ID:* \`#${event.id}\``;
        
        recordBotResponse(reminderMsg);
        await client.sendMessage(targetReminderJid, reminderMsg);
        await db.markEventReminderSent(event.id);
        console.log(`🔔 Sent Imminent reminder for Event #${event.id} to Isaac`);
      }
    } catch (err) {
      console.error("Reminder Scheduler Error:", err.message);
    }
  };

  checkReminders();
  setInterval(checkReminders, 60000);
}

// Daily Executive Morning Digest Cron (8:00 AM MYT)
function startMorningDigestCron(client) {
  let lastSentDate = "";
  setInterval(async () => {
    try {
      const now = new Date();
      const klTime = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Kuala_Lumpur" }));
      const dateStr = db.getKLDateStr();
      const hours = klTime.getHours();
      const mins = klTime.getMinutes();

      if (hours === 8 && mins === 0 && lastSentDate !== dateStr) {
        lastSentDate = dateStr;
        if (targetReminderJid) {
          const digestMsg = await handleMorningDigest();
          recordBotResponse(digestMsg);
          await client.sendMessage(targetReminderJid, digestMsg);
          console.log(`☀️ Sent Morning Digest for ${dateStr} to Isaac`);
        }
      }
    } catch (e) {
      console.error("Morning Digest Cron error:", e.message);
    }
  }, 30000);
}

// Main message processor
async function processMessage(userMsg, sender, clientInstance = null) {
  try {
    const intent = await parseIntent(userMsg);
    let response = "";

    if (intent === "generate_quote") {
      response = await handleQuotationGen(userMsg, clientInstance);
    } else if (intent === "server_status") {
      response = await handleServerStatus();
    } else if (intent === "morning_digest") {
      response = await handleMorningDigest();
    } else if (intent === "content_ideas") {
      response = await handleContentIdeas(userMsg);
    } else if (intent === "send_message") {
      response = await handleOutboundMessage(userMsg);
    } else if (intent === "web_search") {
      response = await handleWebSearch(userMsg);
    } else if (intent === "calendar_query") {
      response = await handleCalendarQuery();
    } else if (intent === "calendar_add") {
      response = await handleCalendarAdd(userMsg);
    } else if (intent === "calendar_delete") {
      response = await handleCalendarDelete(userMsg);
    } else if (intent === "task_add") {
      response = await handleTaskAdd(userMsg);
    } else if (intent === "task_list") {
      response = await handleTaskList();
    } else if (intent === "task_complete") {
      response = await handleTaskComplete(userMsg);
    } else if (intent === "task_delete") {
      response = await handleTaskDelete(userMsg);
    } else if (intent === "note_add") {
      response = await handleNoteAdd(userMsg);
    } else if (intent === "note_view") {
      response = await handleNoteView(userMsg);
    } else if (intent === "note_list") {
      response = await handleNoteList();
    } else if (intent === "note_search") {
      response = await handleNoteSearch(userMsg);
    } else if (intent === "note_delete") {
      response = await handleNoteDelete(userMsg);
    } else if (intent === "memory_add") {
      response = await handleMemoryAdd(userMsg);
    } else if (intent === "memory_list") {
      response = await handleMemoryList();
    } else if (intent === "memory_delete") {
      response = await handleMemoryDelete(userMsg);
    } else {
      response = await handleGeneralChat(userMsg, sender);
    }

    return response || "I'm on it, Isaac. Let me know what you need.";

  } catch (error) {
    console.error("Message processing error:", error);
    throw error;
  }
}

// --- SERVER HEALTH HANDLER ---
async function handleServerStatus() {
  try {
    const servers = await checkServers();
    const list = servers.map(s => `• *${s.name}:* ${s.status}`).join("\n");
    return `🖥️ *INFRASTRUCTURE HEALTH CHECK*\n───────────────\n${list}\n\n💡 _Tailscale & local servers monitored._`;
  } catch (err) {
    return `❌ *Server check error:* ${err.message}`;
  }
}

// --- MORNING DIGEST HANDLER ---
async function handleMorningDigest() {
  try {
    const events = await db.getUpcomingEvents(1);
    const tasks = await db.getTasks(false);
    const servers = await checkServers();

    const dateStr = db.getKLDateStr();
    const eventSummary = events.length > 0 
      ? events.map(e => `• *${e.title}* at \`${e.start_time || "10:00"}\``).join("\n")
      : "• _No events scheduled today._";

    const taskSummary = tasks.length > 0
      ? tasks.slice(0, 3).map(t => `• ${t.text}`).join("\n")
      : "• _All tasks complete!_";

    const serverSummary = servers.map(s => `${s.name.split(" ")[0]}: ${s.status}`).join(" | ");

    return `☀️ *GOOD MORNING, ISAAC!* (\`${dateStr}\`)\n───────────────\n📅 *TODAY'S SCHEDULE:*\n${eventSummary}\n\n📋 *TOP PENDING TASKS:*\n${taskSummary}\n\n🖥️ *SERVERS:* ${serverSummary}\n───────────────\nHave a productive day!`;
  } catch (err) {
    return `❌ *Error generating morning digest:* ${err.message}`;
  }
}

// --- CONTENT IDEAS HANDLER ---
async function handleContentIdeas(userMsg) {
  try {
    const prompt = `You are JARVIS, Isaac's creative assistant.
Isaac is a drummer (electronic kit, Ableton), video producer (Premiere Pro, Sony AX700), TikTok content creator, and owner of Creative Clicks Studios.

User Request: "${userMsg}"

Generate 3 high-impact, engaging content ideas with catchy titles and quick hooks suitable for TikTok, Instagram, or YouTube. Format with clean bullet points.`;

    const ideas = await queryOllama(prompt, 0.7, 200);

    return `🎬 *CREATIVE CONTENT IDEAS*\n───────────────\n${formatForWhatsApp(ideas)}`;
  } catch (err) {
    return `❌ *Error generating content ideas:* ${err.message}`;
  }
}

// --- OUTBOUND MESSAGE DISPATCH HANDLER ---
async function handleOutboundMessage(userMsg) {
  try {
    const phoneMatch = userMsg.match(/(\+?\d[\d\s\-]{7,15}\d)/);
    if (!phoneMatch) {
      return "❌ Please specify a valid phone number (e.g. *send message to +60123456789: Hello!*).";
    }

    let rawPhone = phoneMatch[1].replace(/[\s\-\+]/g, "").trim();
    if (rawPhone.startsWith("0")) {
      rawPhone = "60" + rawPhone.substring(1);
    }

    const targetJid = `${rawPhone}@c.us`;

    let textToSend = userMsg.substring(userMsg.indexOf(phoneMatch[1]) + phoneMatch[1].length).replace(/^[:\s\-]+/, "").trim();

    if (!textToSend) {
      return `❌ Please specify the message text to send to \`+${rawPhone}\`.`;
    }

    await client.sendMessage(targetJid, textToSend);

    return `📤 *MESSAGE SENT*\n───────────────\n👤 *Recipient:* \`+${rawPhone}\`\n💬 *Content:* "${textToSend}"`;
  } catch (err) {
    return `❌ *Failed to send message:* ${err.message}`;
  }
}

// --- WEB SEARCH HANDLER ---
async function handleWebSearch(userMsg) {
  try {
    // Strip conversational phrasing to extract the actual search topic
    let query = userMsg
      .replace(/^(can you|could you|please|hey|jarvis|yo)[\s,]*/i, "")
      .replace(/^(research for me on|research for me|search web for|search online for|search for|find out about|find out|look up online|look up|look into|tell me about|what is the latest news on|what is the latest on|search web|web search|search online|google|browse|research|find online|search|explain|find|investigate)\s*/i, "")
      .replace(/^(for me\s+)?(for|about|on|regarding|into)\s*/i, "")
      .replace(/\?+$/, "")
      .trim();
    if (!query) query = userMsg.trim();

    const searchResults = await searchWeb(query, client);

    if (!searchResults || searchResults.length === 0) {
      return `🌐 *WEB SEARCH*\n───────────────\n📭 _No web results found for "${query}"._`;
    }

    const contextText = searchResults.map(r => `• *${r.title}*\n  _${r.snippet}_${r.url ? "\n  URL: " + r.url : ""}`).join("\n\n");

    const prompt = `You are JARVIS, Isaac's personal executive assistant. Summarize these web search results for Isaac concisely and direct to the point.

User Search Query: "${query}"

Web Search Results:
${contextText}

Give a direct, well-structured response in 2-4 sentences or bullet points highlighting the most important key findings. Zero AI fluff.`;

    const summary = await queryOllama(prompt, 0.7, 200);

    const sources = searchResults
      .filter(r => r.url && !r.url.includes("wikipedia.org"))
      .slice(0, 2)
      .map(r => `• ${r.title}: ${r.url}`)
      .join("\n");

    const sourceFooter = sources ? `\n\n🔗 *Top Sources:*\n${sources}` : "";

    return `🌐 *WEB SEARCH RESULTS* (\`${query}\`)\n───────────────\n${formatForWhatsApp(summary)}${sourceFooter}`;
  } catch (err) {
    return `❌ *Web search error:* ${err.message}`;
  }
}

// --- CALENDAR HANDLERS WITH STRICT VALIDATION ---
async function handleCalendarQuery() {
  try {
    const events = await db.getUpcomingEvents(7);
    if (events.length === 0) {
      return "📅 *YOUR UPCOMING SCHEDULE*\n───────────────\n📭 _No upcoming events for the next 7 days._";
    }
    const list = events.map((e, i) => 
      `${i + 1}️⃣ *${e.title}*\n   🗓 Date: \`${e.event_date}\` | ⏰ Time: \`${e.start_time || "10:00"}\`\n   ${e.recipient_phone ? "👤 Contact: `" + e.recipient_phone + "`\n   " : ""}🆔 Event ID: \`#${e.id}\``
    ).join("\n\n");
    return `📅 *YOUR UPCOMING SCHEDULE*\n───────────────\n${list}\n\n💡 _Tip: Reply "delete event <id>" to remove._`;
  } catch (err) {
    return `❌ *Error fetching calendar:* ${err.message}`;
  }
}

async function handleCalendarAdd(userMsg) {
  try {
    const todayStr = db.getKLDateStr();
    const klNow = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kuala_Lumpur" }));
    const currentTimeStr = `${String(klNow.getHours()).padStart(2, "0")}:${String(klNow.getMinutes()).padStart(2, "0")}`;

    // --- FAST PATH: Try regex extraction first to skip LLM entirely ---
    let jsonMatch = null;
    const regexParsed = tryRegexCalendarParse(userMsg, klNow, todayStr);
    if (regexParsed) {
      jsonMatch = [JSON.stringify(regexParsed)];
      console.log(`⚡ Calendar parsed via regex (skipped LLM): ${jsonMatch[0]}`);
    } else {
      // Fallback to LLM extraction
      const weekdayStr = klNow.toLocaleDateString("en-US", { weekday: "long" });
      const extractPrompt = `Extract event details from: "${userMsg}". Today is ${todayStr} (${weekdayStr}), time is ${currentTimeStr} MYT. Return JSON ONLY: {"title":"...","date":"YYYY-MM-DD","startTime":"HH:MM","endTime":"HH:MM","description":"","recipientPhone":""}. Do NOT include date or time words in the title field.`;
      const extractedRaw = await queryOllama(extractPrompt, 0.3, 100);
      jsonMatch = extractedRaw.match(/\{[\s\S]*\}/);
    }
    if (!jsonMatch) {
      return "❌ Could not extract event title and time. Please specify title, date, and time (e.g. *schedule Meeting tomorrow at 14:00*).";
    }

    const eventData = JSON.parse(jsonMatch[0]);

    // --- STRICT CALENDAR VALIDATION GUARDS ---
    if (!eventData.title || eventData.title === "..." || eventData.title.includes("YYYY") || eventData.title.toLowerCase().includes("undefined")) {
      return "❌ Please specify a valid event title, date, and time (e.g. *schedule Meeting on 2026-08-01 at 14:00*).";
    }

    const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
    if (!eventData.date || !dateRegex.test(eventData.date) || eventData.date.includes("YYYY")) {
      return "❌ Please specify a valid date for the event (e.g. *2026-08-01* or *tomorrow*).";
    }

    const timeRegex = /^\d{2}:\d{2}$/;
    if (!eventData.startTime || !timeRegex.test(eventData.startTime) || eventData.startTime.includes("HH")) {
      eventData.startTime = "10:00";
    }

    const result = await db.addEvent(eventData);
    return `✅ *EVENT SCHEDULED*\n───────────────\n📌 *Title:* ${result.title}\n📆 *Date:* \`${result.date}\`\n⏰ *Time:* \`${result.startTime || "10:00"}\`\n${result.recipientPhone ? "👤 *Contact:* `" + result.recipientPhone + "`\n" : ""}🆔 *Event ID:* \`#${result.id}\`
\n⏰ _I will send you a WhatsApp reminder for this._`;
  } catch (error) {
    return `❌ *Could not schedule event:* Please specify title, date, and time clearly (e.g. *schedule Photo Shoot tomorrow at 14:00*).`;
  }
}

async function handleCalendarDelete(userMsg) {
  try {
    const match = userMsg.match(/\d+/);
    if (!match) return "❌ Please specify the event ID (e.g. *delete event 1*).";
    const id = parseInt(match[0]);
    await db.deleteEvent(id);
    return `🗑️ *EVENT REMOVED*\n───────────────\nRemoved event \`#${id}\` from your calendar.`;
  } catch (err) {
    return `❌ *Error deleting event:* ${err.message}`;
  }
}

// --- TASK HANDLERS ---
async function handleTaskAdd(userMsg) {
  try {
    const taskText = userMsg.replace(/^(add task|create task|add todo|remind me to|create todo)\s*:?\s*/i, "").trim();
    if (!taskText) return "❌ Please specify what task you'd like to add.";
    const result = await db.addTask(taskText);
    return `✅ *TASK ADDED*\n───────────────\n📌 *Task:* ${result.text}\n🆔 *ID:* \`#${result.id}\``;
  } catch (error) {
    return `❌ *Error adding task:* ${error.message}`;
  }
}

async function handleTaskList() {
  try {
    const tasks = await db.getTasks(false);
    if (tasks.length === 0) {
      return "📋 *YOUR PENDING TASKS*\n───────────────\n📭 _No pending tasks! All caught up._";
    }
    const list = tasks.map((t, i) => `${i + 1}️⃣ *${t.text}* \`[ID: #${t.id}]\``).join("\n");
    return `📋 *YOUR PENDING TASKS*\n───────────────\n${list}\n\n💡 _Tip: Reply "complete task <id>" to finish a task._`;
  } catch (error) {
    return `❌ *Error listing tasks:* ${error.message}`;
  }
}

async function handleTaskComplete(userMsg) {
  try {
    const match = userMsg.match(/\d+/);
    if (!match) return "❌ Please specify task ID to complete (e.g. *complete task 1*).";
    const taskNum = parseInt(match[0]);
    const tasks = await db.getTasks(false);
    let targetId = taskNum;
    if (taskNum > 0 && taskNum <= tasks.length) {
      targetId = tasks[taskNum - 1].id;
    }
    await db.completeTask(targetId);
    return `🎉 *TASK COMPLETED*\n───────────────\nMarked task \`#${targetId}\` as finished!`;
  } catch (error) {
    return `❌ *Error completing task:* ${error.message}`;
  }
}

async function handleTaskDelete(userMsg) {
  try {
    const match = userMsg.match(/\d+/);
    if (!match) return "❌ Please specify task ID to delete.";
    const id = parseInt(match[0]);
    await db.deleteTask(id);
    return `🗑️ *TASK DELETED*\n───────────────\nRemoved task \`#${id}\` from your list.`;
  } catch (err) {
    return `❌ *Error deleting task:* ${err.message}`;
  }
}

// --- NOTE HANDLERS ---
async function handleNoteAdd(userMsg) {
  try {
    let title = "";
    let content = userMsg;

    // Check for explicit title pattern like "note named Mistral AI:", "title: Mistral AI", etc.
    const titleNamedMatch = userMsg.match(/(?:named|titled|name|title)\s*[:,\s]?\s*["']?([^,\n\r"']+)["']?\s*[:,\n\r]\s*([\s\S]+)/i);
    if (titleNamedMatch) {
      title = titleNamedMatch[1].trim();
      content = titleNamedMatch[2].trim();
    } else {
      content = userMsg.replace(/^(note down|save note|add note|create note|take a note|remember note|save this note|make a note)\s*:?\s*/i, "").trim();
    }

    if (!content) return "❌ Please specify note content.";
    const result = await db.addNote(content, title);
    return `📝 *NOTE SAVED*\n───────────────\n📌 *Title:* ${result.title}\n🆔 *Note ID:* \`#${result.id}\`
\n💡 _Reply "view note ${result.id}" to display full content._`;
  } catch (err) {
    return `❌ *Error saving note:* ${err.message}`;
  }
}

async function handleNoteList() {
  try {
    const notes = await db.getNotes();
    if (notes.length === 0) {
      return "📝 *YOUR SAVED NOTES*\n───────────────\n📭 _No saved notes yet._";
    }
    const list = notes.map((n, i) => 
      `${i + 1}️⃣ *${n.title}* \`[ID: #${n.id}]\``
    ).join("\n");
    return `📝 *YOUR SAVED NOTES* (${notes.length})\n───────────────\n${list}\n\n💡 _Reply "view note <number/ID>" (e.g. "view note 1") to read full note._`;
  } catch (err) {
    return `❌ *Error reading notes:* ${err.message}`;
  }
}

async function handleNoteView(userMsg) {
  try {
    const match = userMsg.match(/\d+/);
    if (!match) return "❌ Please specify which note to view (e.g. *view note 1*).";
    const num = parseInt(match[0]);
    const notes = await db.getNotes();

    let targetNote = null;
    // Check if matching list index (1..N)
    if (num > 0 && num <= notes.length) {
      targetNote = notes[num - 1];
    } else {
      // Check if matching direct ID
      targetNote = notes.find(n => n.id === num);
    }

    if (!targetNote) {
      targetNote = await db.getNoteById(num);
    }

    if (!targetNote) {
      return `❌ Note #${num} not found. Reply *show notes* to view all available notes.`;
    }

    const dateStr = targetNote.created_at ? targetNote.created_at.slice(0, 10) : "";

    return `📄 *NOTE: ${targetNote.title}* \`[ID: #${targetNote.id}]\`\n───────────────\n${targetNote.content}${dateStr ? "\n\n🗓 *Created:* `" + dateStr + "`" : ""}`;
  } catch (err) {
    return `❌ *Error displaying note:* ${err.message}`;
  }
}

async function handleNoteSearch(userMsg) {
  try {
    const query = userMsg.replace(/^(search note|find note|lookup note)\s*:?\s*/i, "").trim();
    if (!query) return "❌ Please enter a search keyword.";
    const results = await db.searchNotes(query);
    if (results.length === 0) {
      return `🔍 *NOTE SEARCH*\n───────────────\n📭 _No notes found matching "${query}"._`;
    }
    const list = results.map((n) => `• *${n.title}* \`[ID: #${n.id}]\`\n  _${n.content}_`).join("\n\n");
    return `🔍 *SEARCH RESULTS FOR "${query}"*\n───────────────\n${list}`;
  } catch (err) {
    return `❌ *Error searching notes:* ${err.message}`;
  }
}

async function handleNoteDelete(userMsg) {
  try {
    const match = userMsg.match(/\d+/);
    if (!match) return "❌ Please specify note ID to delete.";
    const id = parseInt(match[0]);
    await db.deleteNote(id);
    return `🗑️ *NOTE DELETED*\n───────────────\nDeleted note \`#${id}\`.`;
  } catch (err) {
    return `❌ *Error deleting note:* ${err.message}`;
  }
}

// --- WHATSAPP TEXT FORMATTING HELPER ---
function formatForWhatsApp(text) {
  if (!text) return text;
  let formatted = text;
  // Convert markdown headers to WhatsApp bold
  formatted = formatted.replace(/^#{1,6}\s*(.+)$/gm, '*$1*');
  // Convert markdown bold **text** to WhatsApp bold *text*
  formatted = formatted.replace(/\*\*(.+?)\*\*/g, '*$1*');
  // Convert markdown italic _text_ — already works in WhatsApp
  // Convert markdown bullet points
  formatted = formatted.replace(/^\s*[-*]\s+/gm, '• ');
  // Convert numbered lists (1. item) to clean format
  formatted = formatted.replace(/^\s*(\d+)\.\s+/gm, '$1️⃣ ');
  // Remove markdown links [text](url) → text (url)
  formatted = formatted.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)');
  // Remove triple backtick code blocks
  formatted = formatted.replace(/```[\w]*\n?/g, '').replace(/```/g, '');
  // Convert inline code `text` to WhatsApp monospace
  // (WhatsApp uses ``` for monospace but single backtick works on most clients)
  return formatted.trim();
}

// --- MEMORY HANDLERS ---
async function handleMemoryAdd(userMsg) {
  try {
    const fact = userMsg.replace(/^(remember that|learn that|keep in mind|remember this|save preference|learn this|note that|remember)\s*:?\s*/i, "").trim();
    if (!fact) return "❌ Please specify what you'd like me to remember.";
    const result = await learnMemory(fact, "user_defined");
    return `🧠 *MEMORY SAVED*\n───────────────\n📌 *Learned:* "${result.fact}"\n🆔 *Memory ID:* \`#${result.id}\`
\n💡 _I will keep this in mind for future interactions!_`;
  } catch (err) {
    return `❌ *Error saving memory:* ${err.message}`;
  }
}

// --- GENERAL CHAT HANDLER ---
const COMPACT_PROFILE = `You are JARVIS, Isaac's real personal executive assistant.
Isaac's Context: IT student in Malaysia, head of Creative Clicks Studios (photography, video editing, design), drummer, TikTok creator.
Your Systems: You manage his Calendar, Tasks, Notes, Servers (Friday, Alpha, JARVIS), Web Search, Quotations, and Persistent Memory.

STRICT TONE & RULES:
1. Speak directly, naturally, and warmly like a real human executive assistant. Zero AI fluff.
2. NEVER say "I am an AI", "I don't have access to your device/calendar", "Features are in development", or give chatbot disclaimers.
3. If Isaac asks a general question, give a direct, helpful, well-formatted answer (*bold*, _italic_, • bullets).
4. If Isaac asks to schedule or do something and you need details, ask him directly like a real assistant (e.g., "Got it! What time would you like me to set for that?").`;

async function handleGeneralChat(userMsg, sender) {
  let history = "";
  if (conversationHistory[sender]) {
    history = conversationHistory[sender]
      .slice(-3)
      .map(m => `User: ${m.user}\nAssistant: ${m.assistant}`)
      .join("\n");
    history = "\nRecent conversation:\n" + history;
  }

  const memoryContext = await getMemoryContext();

  const prompt = `${COMPACT_PROFILE}
${memoryContext}
${history}

User: ${userMsg}

Respond directly in 1-4 crisp, helpful sentences.`;

  const rawResponse = await queryOllama(prompt, 0.7, 200);
  return formatForWhatsApp(rawResponse);
}

// --- FAST REGEX CALENDAR PARSER (skips LLM for common patterns) ---
function tryRegexCalendarParse(msg, klNow, todayStr) {
  try {
    const cleanMsg = msg
      .replace(/[\r\n]+/g, " ")
      .replace(/^(schedule|book|add event|create event|set an event|set event|add meeting|create meeting|remind me to|remind me about|remind me in|remind me|set reminder|set a reminder|add reminder|add to calendar|put in calendar|put on my calendar|put on my schedule|new event)\s*:?\s*/i, "")
      .replace(/^[,\s:\-\.]+/, "")
      .trim();

    // 1. Extract Phone (must match phone format, not YYYY-MM-DD date)
    const phoneMatch = cleanMsg.match(/(?:phone|contact|mobile|tel|whatsapp)?\s*:?\s*(\+?60\d[\d\s-]{7,12}\d|01\d[\d\s-]{7,10}\d|\+\d{8,15})\b/i);
    const recipientPhone = phoneMatch ? phoneMatch[1] : "";
    const phoneFullMatchText = phoneMatch ? phoneMatch[0] : "";

    // 2. Extract Date
    const dateRes = parseRelativeDate(cleanMsg, klNow, todayStr);

    // 3. Extract Time
    const timeRes = parseTime(cleanMsg, klNow);

    // If neither date nor time was detected, return null to fallback to LLM
    if (!dateRes && !timeRes) {
      return null;
    }

    const finalDate = dateRes ? dateRes.date : todayStr;
    const startTime = timeRes ? timeRes.startTime : "10:00";
    const endTime = timeRes ? timeRes.endTime : "";

    // 4. Extract Clean Title
    const title = extractTitle(
      msg,
      dateRes ? dateRes.matchedText : "",
      timeRes ? timeRes.matchedText : "",
      phoneFullMatchText
    );

    return {
      title,
      date: finalDate,
      startTime,
      endTime,
      description: "",
      recipientPhone
    };
  } catch (e) {
    return null;
  }
}

function formatDateStr(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function parseRelativeDate(clean, klNow, todayStr) {
  const isoDay = (d) => (d.getDay() === 0 ? 7 : d.getDay());
  const currentIso = isoDay(klNow);

  const dayMap = {
    monday: 1, mon: 1,
    tuesday: 2, tue: 2, tues: 2,
    wednesday: 3, wed: 3,
    thursday: 4, thu: 4, thur: 4, thurs: 4,
    friday: 5, fri: 5,
    saturday: 6, sat: 6,
    sunday: 7, sun: 7
  };

  const dayPattern = "(monday|mon|tuesday|tue|tues|wednesday|wed|thursday|thu|thur|thurs|friday|fri|saturday|sat|sunday|sun)";

  // 1. Explicit date YYYY-MM-DD
  const explicitYMD = clean.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  if (explicitYMD) {
    return { date: explicitYMD[1], matchedText: explicitYMD[0] };
  }

  // Explicit DD/MM/YYYY or DD-MM-YYYY
  const explicitDMY = clean.match(/\b(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})\b/);
  if (explicitDMY) {
    const d = String(explicitDMY[1]).padStart(2, "0");
    const m = String(explicitDMY[2]).padStart(2, "0");
    const y = explicitDMY[3];
    return { date: `${y}-${m}-${d}`, matchedText: explicitDMY[0] };
  }

  // Explicit DD/MM or DD-MM
  const explicitDM = clean.match(/\b(\d{1,2})[\/-](\d{1,2})\b/);
  if (explicitDM) {
    const d = String(explicitDM[1]).padStart(2, "0");
    const m = String(explicitDM[2]).padStart(2, "0");
    const y = klNow.getFullYear();
    return { date: `${y}-${m}-${d}`, matchedText: explicitDM[0] };
  }

  // Month DD or DD Month (e.g. July 31, 31st July, 31 July)
  const monthNames = "(january|jan|february|feb|march|mar|april|apr|may|june|jun|july|jul|august|aug|september|sep|sept|october|oct|november|nov|december|dec)";
  const monthDD = clean.match(new RegExp(`\\b${monthNames}\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`, "i"));
  const ddMonth = clean.match(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+${monthNames}\\b`, "i"));
  if (monthDD || ddMonth) {
    const matched = monthDD || ddMonth;
    const mStr = monthDD ? matched[1] : matched[2];
    const dNum = parseInt(monthDD ? matched[2] : matched[1]);
    const mMonths = ["jan","feb","mar","apr","may","jun","jul","aug","sep","oct","nov","dec"];
    const mIdx = mMonths.findIndex(m => mStr.toLowerCase().startsWith(m));
    if (mIdx !== -1) {
      const y = klNow.getFullYear();
      const mFormatted = String(mIdx + 1).padStart(2, "0");
      const dFormatted = String(dNum).padStart(2, "0");
      return { date: `${y}-${mFormatted}-${dFormatted}`, matchedText: matched[0] };
    }
  }

  // 2. "day after tomorrow"
  if (/\bday after tomorrow\b/i.test(clean)) {
    const d = new Date(klNow);
    d.setDate(d.getDate() + 2);
    return { date: formatDateStr(d), matchedText: clean.match(/\bday after tomorrow\b/i)[0] };
  }

  // 3. "tomorrow" / "tmrw"
  if (/\b(tomorrow|tmrw)\b/i.test(clean)) {
    const d = new Date(klNow);
    d.setDate(d.getDate() + 1);
    return { date: formatDateStr(d), matchedText: clean.match(/\b(tomorrow|tmrw)\b/i)[0] };
  }

  // 4. "today"
  if (/\btoday\b/i.test(clean)) {
    return { date: todayStr, matchedText: clean.match(/\btoday\b/i)[0] };
  }

  // 5. "in X days"
  const inXDays = clean.match(/\bin\s+(\d+)\s+days?\b/i);
  if (inXDays) {
    const days = parseInt(inXDays[1]);
    const d = new Date(klNow);
    d.setDate(d.getDate() + days);
    return { date: formatDateStr(d), matchedText: inXDays[0] };
  }

  // 6. Day of week patterns:
  // a) "<day> next week" or "next week (on/'s)? <day>" or "<day> of next week"
  const nextWeekDay = clean.match(new RegExp(`(?:\\b${dayPattern}\\s+(?:of\\s+)?next\\s+week\\b|\\bnext\\s+week(?:'s|\\s+on)?\\s+${dayPattern}\\b)`, "i"));
  if (nextWeekDay) {
    const matchedStr = nextWeekDay[0];
    const dayMatch = matchedStr.match(new RegExp(dayPattern, "i"));
    if (dayMatch) {
      const targetIso = dayMap[dayMatch[1].toLowerCase()];
      const offset = (targetIso + 7) - currentIso;
      const d = new Date(klNow);
      d.setDate(d.getDate() + offset);
      return { date: formatDateStr(d), matchedText: matchedStr };
    }
  }

  // b) "this <day>", "next <day>", "on <day>", or standalone "<day>"
  const thisOrNextDay = clean.match(new RegExp(`\\b(?:this|next|on)?\\s*${dayPattern}\\b`, "i"));
  if (thisOrNextDay) {
    const matchedStr = thisOrNextDay[0];
    const dayMatch = matchedStr.match(new RegExp(dayPattern, "i"));
    if (dayMatch) {
      const targetIso = dayMap[dayMatch[1].toLowerCase()];
      let offset;
      if (/\bnext\b/i.test(matchedStr) && targetIso > currentIso) {
        offset = (targetIso + 7) - currentIso;
      } else if (targetIso > currentIso) {
        offset = targetIso - currentIso;
      } else if (targetIso < currentIso) {
        offset = (targetIso + 7) - currentIso;
      } else {
        offset = /\bnext\b/i.test(matchedStr) ? 7 : 0;
      }
      const d = new Date(klNow);
      d.setDate(d.getDate() + offset);
      return { date: formatDateStr(d), matchedText: matchedStr };
    }
  }

  return null;
}

function parseTime(clean, klNow) {
  // 1. Range 12-hour: "3pm - 5pm", "3:00pm to 5:00pm", "7:30am - 12pm", "7:30 am to 12 pm"
  const range12 = clean.match(/\b(1[0-2]|0?[1-9])(?::([0-5]\d))?\s*(am|pm)\s*(?:-|to|until)\s*(1[0-2]|0?[1-9])(?::([0-5]\d))?\s*(am|pm)\b/i);
  if (range12) {
    let h1 = parseInt(range12[1]), m1 = range12[2] ? parseInt(range12[2]) : 0;
    const ampm1 = range12[3].toLowerCase();
    if (ampm1 === "pm" && h1 < 12) h1 += 12;
    if (ampm1 === "am" && h1 === 12) h1 = 0;

    let h2 = parseInt(range12[4]), m2 = range12[5] ? parseInt(range12[5]) : 0;
    const ampm2 = range12[6].toLowerCase();
    if (ampm2 === "pm" && h2 < 12) h2 += 12;
    if (ampm2 === "am" && h2 === 12) h2 = 0;

    const startTime = `${String(h1).padStart(2, "0")}:${String(m1).padStart(2, "0")}`;
    const endTime = `${String(h2).padStart(2, "0")}:${String(m2).padStart(2, "0")}`;
    return { startTime, endTime, matchedText: range12[0] };
  }

  // Range 24-hour: "15:00 - 17:00", "07:30 to 12:00"
  const range24 = clean.match(/\b([01]?\d|2[0-3]):([0-5]\d)\s*(?:-|to|until)\s*([01]?\d|2[0-3]):([0-5]\d)\b/i);
  if (range24) {
    const startTime = `${String(range24[1]).padStart(2, "0")}:${String(range24[2]).padStart(2, "0")}`;
    const endTime = `${String(range24[3]).padStart(2, "0")}:${String(range24[4]).padStart(2, "0")}`;
    return { startTime, endTime, matchedText: range24[0] };
  }

  // Single 12-hour: "at 3pm", "3:30 pm", "7:30am"
  const time12 = clean.match(/\b(?:at\s+)?(1[0-2]|0?[1-9])(?::([0-5]\d))?\s*(am|pm)\b/i);
  if (time12) {
    let h = parseInt(time12[1]);
    let m = time12[2] ? parseInt(time12[2]) : 0;
    const ampm = time12[3].toLowerCase();
    if (ampm === "pm" && h < 12) h += 12;
    if (ampm === "am" && h === 12) h = 0;
    const startTime = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
    const endH = (h + 1) % 24;
    const endTime = `${String(endH).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
    return { startTime, endTime, matchedText: time12[0] };
  }

  // Single 24-hour: "at 15:00", "15:30"
  const time24 = clean.match(/\b(?:at\s+)?([01]?\d|2[0-3]):([0-5]\d)\b(?!\s*(?:am|pm))/i);
  if (time24) {
    const h = parseInt(time24[1]), m = parseInt(time24[2]);
    const startTime = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
    const endH = (h + 1) % 24;
    const endTime = `${String(endH).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
    return { startTime, endTime, matchedText: time24[0] };
  }

  // Relative minutes/hours: "in 15 mins", "in 2 hours"
  const inMins = clean.match(/\b(?:in\s+)?(\d+)\s*min(?:ute)?s?(?:\s+from\s+now)?\b/i);
  if (inMins) {
    const future = new Date(klNow.getTime() + parseInt(inMins[1]) * 60000);
    const startTime = `${String(future.getHours()).padStart(2, "0")}:${String(future.getMinutes()).padStart(2, "0")}`;
    const endH = (future.getHours() + 1) % 24;
    const endTime = `${String(endH).padStart(2, "0")}:${String(future.getMinutes()).padStart(2, "0")}`;
    return { startTime, endTime, matchedText: inMins[0] };
  }

  const inHours = clean.match(/\b(?:in\s+)?(\d+)\s*hours?(?:\s+from\s+now)?\b/i);
  if (inHours) {
    const future = new Date(klNow.getTime() + parseInt(inHours[1]) * 3600000);
    const startTime = `${String(future.getHours()).padStart(2, "0")}:${String(future.getMinutes()).padStart(2, "0")}`;
    const endH = (future.getHours() + 1) % 24;
    const endTime = `${String(endH).padStart(2, "0")}:${String(future.getMinutes()).padStart(2, "0")}`;
    return { startTime, endTime, matchedText: inHours[0] };
  }

  return null;
}

function extractTitle(rawMsg, dateMatchedText, timeMatchedText, phoneMatchedText) {
  let title = rawMsg;

  title = title.replace(/^(schedule|book|add event|create event|set an event|set event|add meeting|create meeting|remind me to|remind me about|remind me in|remind me|set reminder|set a reminder|add reminder|add to calendar|put in calendar|put on my calendar|put on my schedule|new event)\s*:?\s*/i, "");

  if (dateMatchedText) {
    const esc = dateMatchedText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    title = title.replace(new RegExp(`(?:\\bon\\s+)?${esc}`, 'gi'), "");
  }

  if (timeMatchedText) {
    const esc = timeMatchedText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    title = title.replace(new RegExp(`(?:\\bat\\s+|\\bfrom\\s+)?${esc}`, 'gi'), "");
  }

  if (phoneMatchedText) {
    const esc = phoneMatchedText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    title = title.replace(new RegExp(`(?:\\bphone\\s*:?\\s*)?${esc}`, 'gi'), "");
  }

  title = title
    .replace(/[\r\n]+/g, " ")
    .replace(/^(?:and\s+)?remind\s+me\b.*/i, "")
    .replace(/^[,\s:\-\.]+/, "")
    .replace(/[,\s:\-\.]+$/, "")
    .replace(/\s+/g, " ")
    .trim();

  title = title.replace(/^(?:on|at|for|from)\s+/i, "").replace(/\s+(?:on|at|for|from)$/i, "").trim();

  return title || "Scheduled Event";
}

if (require.main === module) {
  initializeBot().catch(console.error);

  process.on("SIGINT", async () => {
    console.log("\n👋 Shutting down...");
    if (client) await client.destroy();
    process.exit(0);
  });
}

module.exports = { initializeBot, processMessage };
