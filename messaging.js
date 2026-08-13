const db = require("./db");
const { queryOllama } = require("./ollama");

// Active draft and contact context state in memory
let activeDraft = null;
let lastMentionedContact = null;

function getActiveDraft() {
  return activeDraft;
}

function setActiveDraft(draft) {
  activeDraft = {
    ...draft,
    updatedAt: new Date()
  };
  if (draft && (draft.recipient || draft.phone)) {
    lastMentionedContact = { name: draft.recipient || "", phone: draft.phone || "" };
  }
  return activeDraft;
}

function clearActiveDraft() {
  activeDraft = null;
}

function setLastMentionedContact(contact) {
  if (contact && (contact.name || contact.phone)) {
    lastMentionedContact = contact;
  }
}

function getLastMentionedContact() {
  return lastMentionedContact;
}

/**
 * Parses relative date-time expressions into Asia/Kuala_Lumpur timestamp (YYYY-MM-DD HH:MM:SS)
 */
function parseRelativeDateTime(text, refDate = new Date()) {
  const klNowStr = new Date().toLocaleString("sv-SE", { timeZone: "Asia/Kuala_Lumpur" });
  const klNow = new Date(klNowStr.replace(" ", "T"));
  const lower = text.toLowerCase().trim();
  let targetDate = new Date(klNow.getTime());

  // 1. Relative hour/minute offsets
  const inMinsMatch = lower.match(/\bin\s+(\d+)\s*(?:min|minute)s?\b/i);
  const inHoursMatch = lower.match(/\bin\s+(\d+)\s*(?:hour|hr)s?\b/i);

  if (inMinsMatch) {
    targetDate = new Date(klNow.getTime() + parseInt(inMinsMatch[1]) * 60000);
    return formatParsedResult(targetDate, klNow);
  }

  if (inHoursMatch) {
    targetDate = new Date(klNow.getTime() + parseInt(inHoursMatch[1]) * 3600000);
    return formatParsedResult(targetDate, klNow);
  }

  // 2. Date Component
  let dateFound = false;

  const ymdMatch = lower.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  const dmyMatch = lower.match(/\b(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})\b/);

  if (ymdMatch) {
    const [y, m, d] = ymdMatch[1].split("-").map(Number);
    targetDate.setFullYear(y, m - 1, d);
    dateFound = true;
  } else if (dmyMatch) {
    const d = parseInt(dmyMatch[1]), m = parseInt(dmyMatch[2]), y = parseInt(dmyMatch[3]);
    targetDate.setFullYear(y, m - 1, d);
    dateFound = true;
  } else if (/\b(tomorrow|tmrw)\b/i.test(lower)) {
    targetDate.setDate(targetDate.getDate() + 1);
    dateFound = true;
  } else if (/\bday after tomorrow\b/i.test(lower)) {
    targetDate.setDate(targetDate.getDate() + 2);
    dateFound = true;
  } else if (/\btoday\b/i.test(lower)) {
    dateFound = true;
  } else {
    const dayMap = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6, mon: 1, tue: 2, tues: 2, wed: 3, thu: 4, thur: 4, fri: 5, sat: 6, sun: 0 };
    const dayPattern = "(monday|mon|tuesday|tue|tues|wednesday|wed|thursday|thu|thur|thurs|friday|fri|saturday|sat|sunday|sun)";
    const dayMatch = lower.match(new RegExp(`\\b(?:this|next|on)?\\s*${dayPattern}\\b`, "i"));

    if (dayMatch) {
      const targetDay = dayMap[dayMatch[1].toLowerCase()];
      const currentDay = klNow.getDay();
      let diff = targetDay - currentDay;

      if (/\bnext\b/i.test(lower)) {
        diff = diff <= 0 ? diff + 7 : diff + 7;
      } else if (diff <= 0) {
        diff += 7;
      }
      targetDate.setDate(targetDate.getDate() + diff);
      dateFound = true;
    }
  }

  // 3. Time Component
  let timeFound = false;

  const time12Match = lower.match(/\b(1[0-2]|0?[1-9])(?::([0-5]\d))?\s*(am|pm)\b/i);
  const time24Match = lower.match(/\b(?:at\s+)?([01]?\d|2[0-3]):([0-5]\d)\b(?!\s*(?:am|pm))/i);

  if (time12Match) {
    let h = parseInt(time12Match[1]);
    const m = time12Match[2] ? parseInt(time12Match[2]) : 0;
    const ampm = time12Match[3].toLowerCase();
    if (ampm === "pm" && h < 12) h += 12;
    if (ampm === "am" && h === 12) h = 0;
    targetDate.setHours(h, m, 0, 0);
    timeFound = true;
  } else if (time24Match) {
    const h = parseInt(time24Match[1]), m = parseInt(time24Match[2]);
    targetDate.setHours(h, m, 0, 0);
    timeFound = true;
  }

  if (!timeFound && dateFound) {
    targetDate.setHours(15, 0, 0, 0); // default to 3:00 PM
    timeFound = true;
  }

  if (timeFound && !dateFound) {
    if (targetDate.getTime() <= klNow.getTime()) {
      targetDate.setDate(targetDate.getDate() + 1);
    }
  }

  if (!dateFound && !timeFound) {
    return { error: "Could not parse date or time from expression." };
  }

  return formatParsedResult(targetDate, klNow);
}

function formatParsedResult(targetDate, klNow) {
  if (targetDate.getTime() <= klNow.getTime()) {
    return { error: "Specified date/time has already passed." };
  }

  const timestamp = db.getKLTimestamp(targetDate);
  const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const dayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  
  const mName = monthNames[targetDate.getMonth()];
  const dNum = targetDate.getDate();
  const dName = dayNames[targetDate.getDay()];

  let hours = targetDate.getHours();
  const mins = String(targetDate.getMinutes()).padStart(2, "0");
  const ampm = hours >= 12 ? "pm" : "am";
  const formattedHours = hours % 12 || 12;
  const time12Str = `${formattedHours}${mins === "00" ? "" : ":" + mins}${ampm}`;

  let dayLabel = `${dName}, ${mName} ${dNum}`;
  const tomDate = new Date(klNow);
  tomDate.setDate(tomDate.getDate() + 1);

  if (targetDate.toDateString() === klNow.toDateString()) {
    dayLabel = "today";
  } else if (targetDate.toDateString() === tomDate.toDateString()) {
    dayLabel = "tomorrow";
  }

  return {
    timestamp,
    displayTime: `${time12Str} MYT, ${mName} ${dNum}`,
    shortDisplay: `${time12Str} ${dayLabel}`
  };
}

/**
 * Words that should NEVER be parsed as a contact recipient name
 */
const NON_RECIPIENT_WORDS = new Set([
  "tomorrow", "tmrw", "today", "yesterday", "tonight",
  "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
  "mon", "tue", "tues", "wed", "thu", "thur", "thurs", "fri", "sat", "sun",
  "next", "this", "last", "week", "month", "year", "morning", "afternoon", "evening", "night",
  "me", "myself", "us", "him", "her", "them", "someone", "everyone", "anyone",
  "a", "an", "the", "some", "meeting", "shoot", "event", "confirmation", "call", "lunch", "dinner"
]);

function isValidRecipientName(str) {
  if (!str) return false;
  const clean = str.trim().toLowerCase();
  if (NON_RECIPIENT_WORDS.has(clean)) return false;
  if (/^\+?\d[\d\s\-]{6,15}\d$/.test(clean)) return true;
  if (/\b(tomorrow|today|yesterday|tonight|next week|this week|at \d|on \d)\b/i.test(clean)) return false;
  return true;
}

/**
 * Format phone string to JID
 */
function toJid(phone) {
  let clean = phone.replace(/[\s\-\+]/g, "").trim();
  if (clean.startsWith("0")) clean = "60" + clean.substring(1);
  if (!clean.endsWith("@c.us")) clean += "@c.us";
  return clean;
}

/**
 * Helper to resolve contact name or phone number with pronoun support (he, she, him, her, they)
 */
async function resolveContactInfo(identifier) {
  if (!identifier) {
    if (lastMentionedContact && lastMentionedContact.phone) return lastMentionedContact;
    return { name: "", phone: "" };
  }

  const cleanId = identifier.trim().toLowerCase();

  // Support pronouns referencing the last contact
  if (["he", "she", "him", "her", "they", "them", "contact", "recipient", "client"].includes(cleanId)) {
    if (lastMentionedContact && lastMentionedContact.phone) return lastMentionedContact;
  }

  if (!isValidRecipientName(identifier)) return { name: "", phone: "" };

  const contact = await db.getContact(identifier);
  if (contact) {
    const res = { name: contact.name, phone: contact.phone };
    setLastMentionedContact(res);
    return res;
  }

  let clean = identifier.replace(/[\s\-\+]/g, "").trim();
  if (clean.startsWith("0")) clean = "60" + clean.substring(1);
  if (/^\d{8,15}$/.test(clean)) {
    const res = { name: identifier, phone: clean };
    setLastMentionedContact(res);
    return res;
  }
  return { name: identifier, phone: "" };
}

// --- CORE MESSAGING HANDLERS ---

/**
 * Draft message via natural language with Ollama (Auto-enriched with contacts & calendar)
 */
async function handleDraftMessage(userMsg) {
  try {
    // 1. Fetch all contacts for LLM awareness
    const allContacts = await db.getAllContacts();
    const contactsListStr = allContacts.length > 0
      ? allContacts.map(c => `• ${c.name} (+${c.phone})`).join("\n")
      : "No saved contacts yet.";

    // 2. Fetch upcoming events from calendar for context enrichment
    let eventContext = "";
    try {
      const upcomingEvents = await db.getUpcomingEvents(3);
      if (upcomingEvents && upcomingEvents.length > 0) {
        eventContext = upcomingEvents.map(e => `• ${e.title} (Date: ${e.event_date}, Time: ${e.start_time || "TBD"})`).join("\n");
      }
    } catch (e) {}

    let contactInfo = { name: "", phone: "" };
    let recipientName = "";

    for (const c of allContacts) {
      const reg = new RegExp(`\\b${c.name}\\b`, "i");
      if (reg.test(userMsg)) {
        recipientName = c.name;
        contactInfo = { name: c.name, phone: c.phone };
        setLastMentionedContact(contactInfo);
        break;
      }
    }

    // 3. If no DB contact matched, try regex matching for "for <name>" or "to <name>" with validation guard
    if (!recipientName) {
      const recipientMatch = userMsg.match(/(?:for|to)\s+([A-Z][a-z0-9_]+|\+?\d[\d\s\-]{7,15}\d)/i);
      if (recipientMatch && isValidRecipientName(recipientMatch[1])) {
        recipientName = recipientMatch[1].trim();
        contactInfo = await resolveContactInfo(recipientName);
      }
    }

    // 4. Extract core instruction
    let instruction = userMsg
      .replace(/^(draft|compose|create)\s+(a\s+)?(message|text|draft)\s*/i, "")
      .trim();

    if (recipientName) {
      const esc = recipientName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      instruction = instruction.replace(new RegExp(`(?:for|to)\\s+${esc}\\s*`, "i"), "");
    }

    instruction = instruction.replace(/^about\s+/i, "").trim();
    if (!instruction) instruction = userMsg;

    const prompt = `You are JARVIS, drafting a WhatsApp message for Isaac (Founder & Creative Director of Creative Clicks Studios).

ISAAC'S EXACT WHATSAPP WRITING STYLE (CRITICAL):
1. Sound like a real, friendly, articulate human sending a quick WhatsApp text.
2. Concise, warm, direct, and natural (1-3 sentences max).
3. NEVER use formal corporate email jargon like "I wanted to touch base regarding our upcoming collaboration", "as part of event #24", or ISO dates like "2026-08-13".
4. Use natural, warm greetings (e.g. "Hey Marsden," or "Hi Marsden,").
5. Keep sign-offs natural and light (e.g., "Let me know when you get a chance!", "Best, Isaac", or "Looking forward to it!").

Target Recipient: ${contactInfo.name || recipientName || "Client / Contact"}
Topic / Purpose: "${instruction}"

Return ONLY the natural WhatsApp message body text without intros or wrapping quotes.`;

    const draftedText = await queryOllama(prompt, 0.5, 300);

    setActiveDraft({
      text: draftedText,
      recipient: contactInfo.name || recipientName || "",
      phone: contactInfo.phone || "",
      instruction: instruction
    });

    const contactDisplay = contactInfo.phone
      ? `${contactInfo.name} (\`+${contactInfo.phone}\`)`
      : (recipientName ? recipientName : "_Unspecified_");

    return `📝 *MESSAGE DRAFT CREATED*\n───────────────\n👤 *Recipient:* ${contactDisplay}\n💬 *Draft Content:*\n${draftedText}\n───────────────\n💡 *Actions:*
• Say *"send"* or *"send to ${recipientName || "contact"}"* to send now.
• Say *"change to more casual"* or *"add detail..."* to refine.
• Say *"send at 3pm tomorrow"* to schedule.
• Say *"remind me if no reply in 24 hours"* to set auto-followup.`;
  } catch (err) {
    return `❌ *Error drafting message:* ${err.message}`;
  }
}

/**
 * Iterative draft refinement
 */
async function handleRefineDraft(userMsg) {
  try {
    const current = getActiveDraft();
    if (!current || !current.text) {
      return "❌ No active message draft found. Please draft a message first (e.g. *draft message for Mark about the photo shoot*).";
    }

    const prompt = `You are JARVIS, Isaac's executive AI assistant.
Isaac is refining an active message draft.

Current Draft:
"${current.text}"

Refinement Instruction from Isaac:
"${userMsg}"

Rewrite and refine the draft message incorporating Isaac's request. Maintain executive quality.
Return ONLY the final revised message body text without intros or quotation marks.`;

    const refinedText = await queryOllama(prompt, 0.5, 250);

    setActiveDraft({
      ...current,
      text: refinedText
    });

    return `📝 *REFINED DRAFT*\n───────────────\n💬 *Updated Content:*\n${refinedText}\n───────────────\n💡 _Reply "send", "send at <time>", or refine further._`;
  } catch (err) {
    return `❌ *Error refining draft:* ${err.message}`;
  }
}

/**
 * Send message immediately to single or multiple recipients
 */
async function handleSendMessage(userMsg, clientInstance) {
  try {
    const draft = getActiveDraft();

    // 1. Extract recipient and clean command modifiers (e.g. "now", "immediately", "please")
    let recipientStr = "";
    const recMatch = userMsg.match(/to\s+([A-Z0-9_,\s\+]+?)(?:\:|$|\babout\b|\bthat\b|\bat\b|\bon\b)/i);
    if (recMatch) {
      let rawCandidate = recMatch[1].trim();
      rawCandidate = rawCandidate.replace(/\b(now|immediately|right now|please|today)\b/gi, "").trim();

      const allContacts = await db.getAllContacts();
      for (const c of allContacts) {
        const reg = new RegExp(`\\b${c.name}\\b`, "i");
        if (reg.test(userMsg)) {
          rawCandidate = c.name;
          break;
        }
      }
      recipientStr = rawCandidate;
    }

    if (!recipientStr && draft && draft.recipient) {
      recipientStr = draft.recipient;
    }

    // 2. Determine message text to send: STRICT SINGLE DISPATCH SAFETY
    let textToSend = "";
    const colonIndex = userMsg.indexOf(":");

    if (draft && draft.text) {
      textToSend = draft.text;
    } else if (colonIndex !== -1 && colonIndex < userMsg.length - 1) {
      textToSend = userMsg.substring(colonIndex + 1).trim();
    } else {
      // If no active draft and no colon text provided, DO NOT auto-generate or send extra messages!
      const targetName = recipientStr || "the contact";
      return `ℹ️ *Message Already Dispatched*\n───────────────\nNo active draft pending for ${targetName}. Only the single requested message was sent.\n\n💡 _Say "draft message for ${targetName}..." if you'd like to compose a new message._`;
    }

    if (!textToSend) {
      return "❌ No active message draft found. Please draft a message first or provide content (e.g. *send to Mark: Hello!*).";
    }

    if (!recipientStr && (!draft || !draft.phone)) {
      return "❌ Please specify a recipient (e.g. *send to Mark* or *send to +60176001484*).";
    }

    // Split multiple recipients (comma or 'and')
    const rawRecipients = recipientStr ? recipientStr.split(/\s*,\s*|\s+and\s+/i).filter(Boolean) : [draft.phone];
    const results = [];

    for (const rawRec of rawRecipients) {
      const contactInfo = await resolveContactInfo(rawRec);

      if (!contactInfo.phone) {
        results.push(`⚠️ Contact \`${rawRec}\` not found in contacts list.`);
        continue;
      }

      const targetJid = toJid(contactInfo.phone);

      if (clientInstance) {
        await clientInstance.sendMessage(targetJid, textToSend);
      }

      const logRes = await db.logMessage("outbound", "Isaac", contactInfo.name || contactInfo.phone, textToSend);

      // Check if user requested auto-followup in command (e.g. "remind me if he doesn't reply in 24 hours")
      const followupMatch = userMsg.match(/(?:remind|followup|follow-up|escalate)\s+.*?(?:in\s+)?(\d+)\s*(hour|hr|day)s?/i);
      let followupNote = "";

      if (followupMatch) {
        let num = parseInt(followupMatch[1]);
        const unit = followupMatch[2].toLowerCase();
        if (unit.startsWith("day")) num = num * 24;

        const klNow = new Date(new Date().toLocaleString("sv-SE", { timeZone: "Asia/Kuala_Lumpur" }).replace(" ", "T"));
        const triggerDate = new Date(klNow.getTime() + num * 3600000);
        const triggerStr = db.getKLTimestamp(triggerDate);

        await db.addMessageFollowup(logRes.id, contactInfo.name || contactInfo.phone, triggerStr, num);
        followupNote = `\n⏰ *Follow-up tracking set:* I will ping you in ${num} hours if no reply.`;
      }
      results.push(`✅ *Dispatched to ${contactInfo.name}* (\`+${contactInfo.phone}\`)${followupNote}`);
    }

    clearActiveDraft();

    return `📤 *MESSAGE DISPATCH SUMMARY*\n───────────────\n${results.join("\n")}\n\n💬 *Sent Content:*\n${textToSend}`;
  } catch (err) {
    return `❌ *Failed to send message:* ${err.message}`;
  }
}

/**
 * 1-Shot AI Draft & Immediate Dispatch
 * (e.g. "tell Mark that I'll be 10 minutes late", "draft and send to Sarah that the shoot is confirmed")
 */
async function handleDraftAndSend(userMsg, clientInstance) {
  try {
    const allContacts = await db.getAllContacts();
    let recipientName = "";
    let contactInfo = { name: "", phone: "" };

    for (const c of allContacts) {
      const reg = new RegExp(`\\b${c.name}\\b`, "i");
      if (reg.test(userMsg)) {
        recipientName = c.name;
        contactInfo = { name: c.name, phone: c.phone };
        break;
      }
    }

    if (!recipientName) {
      const recMatch = userMsg.match(/(?:to|tell|text|message)\s+([A-Za-z0-9_\+]+)/i);
      if (recMatch && isValidRecipientName(recMatch[1])) {
        recipientName = recMatch[1].trim();
        contactInfo = await resolveContactInfo(recipientName);
      }
    }

    if (!contactInfo.phone) {
      return `⚠️ Contact \`${recipientName || "unknown"}\` not found in contacts list. Reply *add contact <name> <phone>* to save them first.`;
    }

    let instruction = userMsg
      .replace(/^(draft and send|tell|text|message|send message to)\s+/i, "")
      .trim();

    if (recipientName) {
      const esc = recipientName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      instruction = instruction.replace(new RegExp(`(?:to\\s+)?${esc}\\s*`, "i"), "");
    }
    instruction = instruction.replace(/^(that|telling him|telling her|telling them|about|to)\s+/i, "").trim();

    const prompt = `You are JARVIS, writing a short, direct WhatsApp message for Isaac (Founder of Creative Clicks Studios).
Recipient: ${contactInfo.name}
Isaac's Instruction: "${instruction || userMsg}"

ISAAC'S WHATSAPP STYLE:
1. Write like a real person sending a quick WhatsApp text.
2. Short, natural, warm, and concise (1-2 sentences).
3. Zero corporate jargon.

Return ONLY the message body text.`;

    const messageText = await queryOllama(prompt, 0.4, 150);

    const targetJid = toJid(contactInfo.phone);
    if (clientInstance) {
      await clientInstance.sendMessage(targetJid, messageText);
    }
    await db.logMessage("outbound", "Isaac (Instant AI)", contactInfo.name || contactInfo.phone, messageText);

    return `📤 *MESSAGE SENT TO ${contactInfo.name.toUpperCase()}* (\`+${contactInfo.phone}\`)\n───────────────\n💬 "${messageText}"`;
  } catch (err) {
    return `❌ *Failed to draft and send message:* ${err.message}`;
  }
}

/**
 * Schedule message for relative or explicit date/time
 */
async function handleScheduleMessage(userMsg, clientInstance) {
  try {
    const draft = getActiveDraft();

    // Extract recipient
    let recipient = "";
    const recMatch = userMsg.match(/to\s+([A-Z0-9_,\s\+]+?)(?:\s+at|\s+on|\s+in|\:|$)/i);
    if (recMatch) {
      recipient = recMatch[1].trim();
    } else if (draft && draft.recipient) {
      recipient = draft.recipient;
    }

    // Extract message content
    let messageText = "";
    const colonIdx = userMsg.indexOf(":");
    if (colonIdx !== -1) {
      messageText = userMsg.substring(colonIdx + 1).trim();
    } else if (draft && draft.text) {
      messageText = draft.text;
    }

    if (!recipient) {
      return "❌ Please specify a recipient for scheduling (e.g. *send this to Mark at 3pm tomorrow*).";
    }

    if (!messageText) {
      return "❌ Please specify message content or draft a message first.";
    }

    // Parse date/time relative expression
    const parsedTime = parseRelativeDateTime(userMsg);
    if (parsedTime.error) {
      return `❌ *Scheduling Error:* ${parsedTime.error}`;
    }

    const contactInfo = await resolveContactInfo(recipient);
    const targetRecipient = contactInfo.name || recipient;

    const scheduled = await db.addScheduledMessage(targetRecipient, messageText, parsedTime.timestamp);

    clearActiveDraft();

    return `✅ Scheduled to send at ${parsedTime.shortDisplay} (${parsedTime.displayTime})\n───────────────\n👤 *Recipient:* ${targetRecipient}\n💬 *Message:* ${messageText}\n🆔 *Schedule ID:* \`#${scheduled.id}\``;
  } catch (err) {
    return `❌ *Scheduling Error:* ${err.message}`;
  }
}

/**
 * Set followup reminder for sent message
 */
async function handleSetFollowupReminder(userMsg) {
  try {
    // Extract threshold hours
    const hrMatch = userMsg.match(/(\d+)\s*(hour|hr|day)s?/i);
    let hours = 24; // default
    if (hrMatch) {
      hours = parseInt(hrMatch[1]);
      if (hrMatch[2].toLowerCase().startsWith("day")) {
        hours = hours * 24;
      }
    }

    // Extract contact name if mentioned
    const nameMatch = userMsg.match(/(?:if|for)\s+([A-Z][a-z0-9_]+|\+?\d[\d\s\-]{7,15}\d)/i);
    let recipientName = nameMatch ? nameMatch[1].trim() : "";

    let lastMsg = null;
    if (recipientName) {
      lastMsg = await db.getLastOutboundMessage(recipientName);
    } else {
      const draft = getActiveDraft();
      if (draft && draft.recipient) {
        recipientName = draft.recipient;
        lastMsg = await db.getLastOutboundMessage(recipientName);
      }
    }

    if (!lastMsg) {
      // Find absolute last outbound message sent to anyone
      const allHistory = await db.searchMessageLog("", 1);
      if (allHistory && allHistory.length > 0 && allHistory[0].direction === "outbound") {
        lastMsg = allHistory[0];
        recipientName = lastMsg.recipient;
      }
    }

    const contactInfo = await resolveContactInfo(recipientName || "Contact");
    const targetName = contactInfo.name || recipientName || "he";

    const klNow = new Date(new Date().toLocaleString("sv-SE", { timeZone: "Asia/Kuala_Lumpur" }).replace(" ", "T"));
    const triggerDate = new Date(klNow.getTime() + hours * 3600000);
    const triggerStr = db.getKLTimestamp(triggerDate);

    await db.addMessageFollowup(lastMsg ? lastMsg.id : null, contactInfo.name || recipientName || "Contact", triggerStr, hours);

    const timeFrame = hours === 24 ? "tomorrow" : `in ${hours} hours`;

    return `⏰ Set. I'll ping you ${timeFrame} if ${targetName} doesn't reply.`;
  } catch (err) {
    return `❌ *Error setting follow-up reminder:* ${err.message}`;
  }
}

// --- CONTACT ALIAS MANAGEMENT ---
async function handleContactAdd(userMsg) {
  try {
    const match = userMsg.match(/(?:add|save|create)\s+contact\s+([A-Za-z0-9_\s]+?)\s+(\+?\d[\d\s\-]{7,15}\d)/i);
    if (!match) {
      return "❌ Please specify contact name and phone number (e.g. *add contact Mark +60176001484*).";
    }
    const name = match[1].trim();
    const phone = match[2].trim();
    const result = await db.addContact(name, phone);
    return `👤 *CONTACT SAVED*\n───────────────\n📌 *Name:* ${result.name}\n📞 *Phone:* \`+${result.phone}\``;
  } catch (err) {
    return `❌ *Error adding contact:* ${err.message}`;
  }
}

async function handleContactList() {
  try {
    const contacts = await db.getAllContacts();
    if (contacts.length === 0) {
      return "👤 *CONTACT ALIASES*\n───────────────\n📭 _No contact aliases saved yet. Reply 'add contact <name> <phone>' to create one._";
    }
    const list = contacts.map((c, i) => `${i + 1}️⃣ *${c.name}:* \`+${c.phone}\``).join("\n");
    return `👤 *CONTACT ALIASES* (${contacts.length})\n───────────────\n${list}`;
  } catch (err) {
    return `❌ *Error fetching contacts:* ${err.message}`;
  }
}

async function handleContactDelete(userMsg) {
  try {
    const identifier = userMsg.replace(/^(delete|remove)\s+contact\s*/i, "").trim();
    if (!identifier) return "❌ Please specify contact name or ID to delete.";
    await db.deleteContact(identifier);
    return `🗑️ *CONTACT REMOVED*\n───────────────\nRemoved contact alias \`${identifier}\`.`;
  } catch (err) {
    return `❌ *Error deleting contact:* ${err.message}`;
  }
}

// --- MESSAGE TEMPLATES MANAGEMENT ---
async function handleTemplateSave(userMsg) {
  try {
    const match = userMsg.match(/(?:save|create|add)\s+template\s+([a-zA-z0-9_]+)\s+[:"]?\s*([\s\S]+)/i);
    if (!match) {
      return "❌ Please specify template name and text (e.g. *save template quote_followup Hi [Name], following up...*).";
    }
    const name = match[1].trim();
    const text = match[2].replace(/^["']|["']$/g, "").trim();
    const res = await db.addTemplate(name, text);
    return `📋 *TEMPLATE SAVED*\n───────────────\n📌 *Name:* \`${res.name}\`\n💬 *Content:*\n${res.template_text}`;
  } catch (err) {
    return `❌ *Error saving template:* ${err.message}`;
  }
}

async function handleTemplateList() {
  try {
    const templates = await db.getAllTemplates();
    if (templates.length === 0) {
      return "📋 *MESSAGE TEMPLATES*\n───────────────\n📭 _No templates saved yet. Reply 'save template <name> <text>' to create one._";
    }
    const list = templates.map((t, i) => `${i + 1}️⃣ *\`${t.name}\`*\n   _${t.template_text}_`).join("\n\n");
    return `📋 *MESSAGE TEMPLATES* (${templates.length})\n───────────────\n${list}`;
  } catch (err) {
    return `❌ *Error listing templates:* ${err.message}`;
  }
}

async function handleTemplateUse(userMsg) {
  try {
    const match = userMsg.match(/use\s+template\s+([a-zA-z0-9_]+)(?:\s+for\s+([A-Za-z0-9_\s\+]+))?/i);
    if (!match) {
      return "❌ Please specify template name (e.g. *use template quote_followup for Mark*).";
    }
    const tName = match[1].trim();
    const recipient = match[2] ? match[2].trim() : "";

    const t = await db.getTemplate(tName);
    if (!t) return `❌ Template \`${tName}\` not found. Reply *list templates* to view available.`;

    let filledText = t.template_text;
    if (recipient) {
      filledText = filledText.replace(/\[Name\]|\[Contact\]|\[Client\]/gi, recipient);
    }

    setActiveDraft({
      text: filledText,
      recipient: recipient,
      phone: ""
    });

    return `📝 *DRAFT FROM TEMPLATE (\`${tName}\`)*\n───────────────\n${recipient ? "👤 *Recipient:* " + recipient + "\n" : ""}💬 *Content:*\n${filledText}\n───────────────\n💡 _Reply "send" to dispatch or refine further._`;
  } catch (err) {
    return `❌ *Error applying template:* ${err.message}`;
  }
}

// --- MESSAGE HISTORY / LOG SEARCH ---
async function handleMessageHistory(userMsg) {
  try {
    const match = userMsg.match(/(?:history|chat|log)\s+(?:with\s+)?([A-Za-z0-9_\+]+)/i);
    const identifier = match ? match[1].trim() : "";

    if (!identifier) {
      const recent = await db.searchMessageLog("", 10);
      if (recent.length === 0) return "📜 *MESSAGE LOG*\n───────────────\n📭 _No message history logged yet._";
      const list = recent.map(m => `• *[${m.direction.toUpperCase()}]* ${m.sender || m.recipient} (\`${m.timestamp}\`):\n  ${m.message_text}`).join("\n\n");
      return `📜 *RECENT MESSAGE LOG*\n───────────────\n${list}`;
    }

    const history = await db.getContactHistory(identifier, 10);
    if (history.length === 0) {
      return `📜 *MESSAGE HISTORY*\n───────────────\n📭 _No logged messages found for "${identifier}"._`;
    }

    const list = history.map(m => `• *[${m.direction.toUpperCase()}]* \`${m.timestamp}\`:\n  ${m.message_text}`).join("\n\n");
    return `📜 *MESSAGE HISTORY WITH "${identifier.toUpperCase()}"*\n───────────────\n${list}`;
  } catch (err) {
    return `❌ *Error loading history:* ${err.message}`;
  }
}

// --- CRON CHECK DISPATCHERS FOR MAIN.JS ---

/**
 * Dispatch due scheduled messages at exact time
 */
async function checkAndDispatchScheduledMessages(clientInstance) {
  try {
    const dueMessages = await db.getDueScheduledMessages();
    if (!dueMessages || dueMessages.length === 0) return;

    const primaryJid = process.env.PRIMARY_USER_JID || "60176001484@c.us";

    for (const msg of dueMessages) {
      const contactInfo = await resolveContactInfo(msg.recipient);
      if (!contactInfo.phone) {
        console.warn(`⚠️ Cannot dispatch scheduled message #${msg.id}: No phone for recipient ${msg.recipient}`);
        await db.markScheduledMessageSent(msg.id);
        continue;
      }

      const targetJid = toJid(contactInfo.phone);

      if (clientInstance) {
        await clientInstance.sendMessage(targetJid, msg.message_text);
        console.log(`🚀 [SCHEDULED DISPATCH] Sent scheduled message #${msg.id} to ${targetJid}`);
      }

      await db.logMessage("outbound", "JARVIS (Scheduled)", contactInfo.name || contactInfo.phone, msg.message_text);
      await db.markScheduledMessageSent(msg.id);

      // Notify Isaac
      if (clientInstance) {
        const notifyMsg = `📤 *SCHEDULED MESSAGE DISPATCHED*\n───────────────\n👤 *Recipient:* ${contactInfo.name} (\`+${contactInfo.phone}\`)\n⏰ *Scheduled At:* \`${msg.scheduled_at}\`\n\n💬 *Content:*\n${msg.message_text}`;
        await clientInstance.sendMessage(primaryJid, notifyMsg);
      }
    }
  } catch (err) {
    console.error("Scheduled message dispatch error:", err.message);
  }
}

/**
 * Check for unanswered messages and trigger followups / escalation
 */
async function checkAndProcessFollowups(clientInstance) {
  try {
    const dueFollowups = await db.getDueFollowups();
    if (!dueFollowups || dueFollowups.length === 0) return;

    const primaryJid = process.env.PRIMARY_USER_JID || "60176001484@c.us";

    for (const followup of dueFollowups) {
      const contactInfo = await resolveContactInfo(followup.recipient);
      const recipientKey = contactInfo.name || followup.recipient;

      // Check if recipient has replied since the followup was set
      const hasReplied = await db.hasInboundMessageAfter(recipientKey, followup.created_at || followup.followup_triggered_at);

      if (hasReplied) {
        console.log(`✅ [FOLLOWUP RESOLVED] Recipient ${recipientKey} replied. Marking followup #${followup.id} resolved.`);
        await db.resolveFollowupsForRecipient(recipientKey);
        continue;
      }

      // If no reply after threshold hours:
      const autoReminderText = `Hi ${contactInfo.name || "there"}, just following up on my message from earlier! Let me know when you get a chance to check it out.`;
      
      let autoSent = false;
      if (clientInstance && contactInfo.phone) {
        try {
          const targetJid = toJid(contactInfo.phone);
          await clientInstance.sendMessage(targetJid, autoReminderText);
          await db.logMessage("outbound", "JARVIS (Auto-Followup)", contactInfo.name || contactInfo.phone, autoReminderText);
          autoSent = true;
          console.log(`🔔 [AUTO-REMINDER SENT] Sent followup to ${recipientKey}`);
        } catch (sendErr) {
          console.error(`Failed to send auto-reminder to ${recipientKey}:`, sendErr.message);
        }
      }

      // Escalate alert to Isaac
      if (clientInstance) {
        const hoursText = followup.threshold_hours >= 24 ? `${followup.threshold_hours / 24}24hrs` : `${followup.threshold_hours}hrs`;
        const alertMsg = `⏰ *AUTO-FOLLOWUP ALERT*\n───────────────\n👤 *Contact:* ${contactInfo.name || followup.recipient}${contactInfo.phone ? " (`+" + contactInfo.phone + "`)" : ""}\n⚠️ *Status:* Has not replied to your message from ${hoursText} ago.\n${autoSent ? "\n💬 *Auto-reminder sent:* \"" + autoReminderText + "\"\n" : ""}\n_Want to resend or give them a call?_`;
        
        await clientInstance.sendMessage(primaryJid, alertMsg);
      }

      await db.markFollowupEscalated(followup.id, autoSent ? 1 : 0);
    }
  } catch (err) {
    console.error("Followup processing error:", err.message);
  }
}

function handleShowMenu() {
  return `🤖 *JARVIS EXECUTIVE CONTROL MENU*
───────────────
*Welcome, Isaac!* Here is your interactive command directory for managing messages, calendar, tasks, and infrastructure:

📝 *MESSAGE DRAFTING & SENDING*
• \`draft message for [name] about [topic]\`
• \`change to more casual / concise / formal\`
• \`send\` or \`send to [name]\`

📅 *MESSAGE SCHEDULING*
• \`send this at 3pm tomorrow\`
• \`send at 2pm next Monday\`
• \`send in 6 hours\`

⏰ *AUTO-FOLLOWUP & TRACKING*
• \`remind me if no reply in 24 hours\`
• \`escalate after 48 hours\`

👤 *CONTACT ALIASES*
• \`add contact [name] [phone]\`
• \`list contacts\`
• \`delete contact [name]\`

📋 *MESSAGE TEMPLATES*
• \`save template [name] [text]\`
• \`use template [name] for [contact]\`
• \`list templates\`

📜 *MESSAGE LOG & HISTORY*
• \`chat log\` or \`history with [name]\`

🗓️ *CALENDAR, TASKS & NOTES*
• \`schedule [event] tomorrow at 3pm\`
• \`add task [task description]\`
• \`add note [title]: [content]\`

🖥️ *SYSTEM & INFRASTRUCTURE*
• \`server status\` (Check Friday, Alpha, JARVIS)
• \`generate quote for [client]\`
• \`morning digest\`
───────────────
💡 _Type any command above or ask naturally to execute._`;
}

function getInteractiveMenuList() {
  try {
    const { List } = require("whatsapp-web.js");
    const sections = [
      {
        title: "MESSAGING",
        rows: [
          { id: "menu_draft_msg", title: "📝 Draft Message", description: "Who to send to? -> What about?" },
          { id: "menu_schedule_msg", title: "📅 Schedule Message", description: "When to send? -> Who? -> Message?" },
          { id: "menu_use_template", title: "📋 Use Template", description: "Pick saved template -> Send to who?" },
          { id: "menu_add_contact", title: "👤 Add Contact", description: "Contact name? -> Phone number?" }
        ]
      },
      {
        title: "SYSTEM",
        rows: [
          { id: "menu_add_event", title: "📆 Add Event", description: "Event name? -> When? -> Time?" },
          { id: "menu_add_task", title: "✅ Add Task", description: "Task description? -> Due when?" },
          { id: "menu_add_note", title: "📝 Add Note", description: "Note title? -> Content?" },
          { id: "menu_search_web", title: "🌐 Search Web", description: "Search for what? -> Live AI summary" }
        ]
      },
      {
        title: "SERVER & BRIEFING",
        rows: [
          { id: "menu_server_status", title: "🖥️ Server Status", description: "Instant health check for Friday, Alpha, JARVIS" },
          { id: "menu_morning_digest", title: "☀️ Morning Digest", description: "Instant executive daily briefing" }
        ]
      }
    ];

    return new List(
      "Select an option below. JARVIS will guide you step-by-step:",
      "View Menu Options",
      sections,
      "🤖 JARVIS EXECUTIVE MENU",
      "Creative Clicks Studios • Asia/Kuala_Lumpur"
    );
  } catch (err) {
    return null;
  }
}

async function showMenu(client, chatId) {
  const interactiveList = getInteractiveMenuList();
  if (client && chatId && interactiveList) {
    try {
      await client.sendMessage(chatId, interactiveList);
      return null;
    } catch (e) {
      console.warn("Could not send interactive list message, falling back to text:", e.message);
    }
  }
  const textMenu = handleShowMenu();
  if (client && chatId) {
    await client.sendMessage(chatId, textMenu);
  }
  return textMenu;
}

async function handleMenuSelection(chatId, optionId, client = null) {
  const cleanOpt = (optionId || "").trim().toLowerCase();

  if (cleanOpt === "menu_server_status") {
    const { checkServers } = require("./server_health");
    const servers = await checkServers();
    const list = servers.map(s => `• *${s.name}:* ${s.status}`).join("\n");
    return `🖥️ *INFRASTRUCTURE HEALTH CHECK*\n───────────────\n${list}\n\n💡 _Tailscale & local servers monitored._`;
  }

  if (cleanOpt === "menu_morning_digest") {
    const events = await db.getUpcomingEvents(1);
    const tasks = await db.getTasks(false);
    const { checkServers } = require("./server_health");
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
  }

  if (cleanOpt === "menu_draft_msg") {
    await db.setMenuSession(chatId, "draft_message", 1, {});
    return `📝 *DRAFT MESSAGE (Step 1/2)*\n───────────────\nWho should I send this to?\n\n💡 _Type contact name or phone number (or type *cancel* to abort)._`;
  }

  if (cleanOpt === "menu_schedule_msg") {
    await db.setMenuSession(chatId, "schedule_message", 1, {});
    return `📅 *SCHEDULE MESSAGE (Step 1/3)*\n───────────────\nWhen should I send this message?\n\n💡 _e.g. "3pm tomorrow", "2pm next Monday", "in 2 hours" (or *cancel*)._`;
  }

  if (cleanOpt === "menu_use_template") {
    const templates = await db.getAllTemplates();
    if (!templates || templates.length === 0) {
      return `📋 *MESSAGE TEMPLATES*\n───────────────\n📭 _No templates saved yet._\n\n💡 _Say "save template <name> <text>" to create one._`;
    }
    const list = templates.map((t, i) => `${i + 1}️⃣ *\`${t.name}\`*\n   _${t.template_text}_`).join("\n\n");
    await db.setMenuSession(chatId, "use_template", 1, { templates });
    return `📋 *SELECT TEMPLATE (Step 1/2)*\n───────────────\n${list}\n\nWhich template would you like to use?\n\n💡 _Type the template name or number (or *cancel*)._`;
  }

  if (cleanOpt === "menu_add_contact") {
    await db.setMenuSession(chatId, "add_contact", 1, {});
    return `👤 *ADD CONTACT (Step 1/2)*\n───────────────\nWhat is the contact's name?\n\n💡 _e.g. "Mark", "Sarah Client" (or *cancel*)._`;
  }

  if (cleanOpt === "menu_add_event") {
    await db.setMenuSession(chatId, "add_event", 1, {});
    return `📆 *ADD CALENDAR EVENT (Step 1/3)*\n───────────────\nWhat is the event name / title?\n\n💡 _e.g. "Photo shoot with Sarah", "Band rehearsal" (or *cancel*)._`;
  }

  if (cleanOpt === "menu_add_task") {
    await db.setMenuSession(chatId, "add_task", 1, {});
    return `✅ *ADD TASK (Step 1/2)*\n───────────────\nWhat is the task description?\n\n💡 _e.g. "Buy drumsticks", "Export legal podcast audio" (or *cancel*)._`;
  }

  if (cleanOpt === "menu_add_note") {
    await db.setMenuSession(chatId, "add_note", 1, {});
    return `📝 *ADD NOTE (Step 1/2)*\n───────────────\nWhat is the note title?\n\n💡 _e.g. "Mistral 7B Benchmarks", "Camera settings" (or *cancel*)._`;
  }

  if (cleanOpt === "menu_search_web") {
    await db.setMenuSession(chatId, "search_web", 1, {});
    return `🌐 *SEARCH THE WEB*\n───────────────\nWhat would you like me to research or search for?\n\n💡 _Type your query (or *cancel*)._`;
  }

  return `🤖 *Unknown menu option.* Reply *menu* to view all available options.`;
}

async function handleGuidedFlowInput(chatId, userMsg, client = null, session = null) {
  const currentSession = session || await db.getMenuSession(chatId);
  if (!currentSession || !currentSession.action) return null;

  const raw = userMsg.trim();
  const lower = raw.toLowerCase();

  // 1. Global Cancel Trigger
  if (lower === "cancel" || lower === "abort" || lower === "exit" || lower === "stop") {
    await db.clearMenuSession(chatId);
    return `❌ *Action Cancelled.*\n───────────────\nReply *menu* anytime to view available options.`;
  }

  const { action, step, data = {} } = currentSession;

  // 2. DRAFT MESSAGE FLOW
  if (action === "draft_message") {
    if (step === 1) {
      data.recipient = raw;
      const contactInfo = await resolveContactInfo(raw);
      data.phone = contactInfo.phone || "";
      data.name = contactInfo.name || raw;
      await db.setMenuSession(chatId, action, 2, data);
      return `📝 *DRAFT MESSAGE (Step 2/2)*\n───────────────\n👤 *Recipient:* ${data.name}${data.phone ? " (`+" + data.phone + "`)" : ""}\n\nWhat is the message about? (Type your instructions, key details, or bullet points)`;
    }
    if (step === 2) {
      data.instruction = raw;
      const draftRes = await handleDraftMessage(`draft message for ${data.name || data.recipient} about ${raw}`);
      const activeDraft = getActiveDraft();
      data.draftText = activeDraft ? activeDraft.text : "";
      await db.setMenuSession(chatId, action, 3, data);
      return `${draftRes}\n\n💡 *Reply:* \`yes\` to send now, \`schedule at <time>\` to schedule, \`change to...\` to refine, or \`cancel\`.`;
    }
    if (step === 3) {
      if (/^(yes|send|yep|yeah|sure|ok|send it)$/i.test(lower)) {
        await db.clearMenuSession(chatId);
        return await handleSendMessage(`send to ${data.name || data.recipient}`, client);
      }
      if (/^schedule\b/i.test(lower) || /\b(tomorrow|next|pm|am|\d{4})\b/i.test(lower)) {
        await db.clearMenuSession(chatId);
        return await handleScheduleMessage(raw, client);
      }
      if (/^(change|make|refine|shorter|longer|more|casual|formal)/i.test(lower)) {
        const refinedRes = await handleRefineDraft(raw);
        const activeDraft = getActiveDraft();
        data.draftText = activeDraft ? activeDraft.text : "";
        await db.setMenuSession(chatId, action, 3, data);
        return `${refinedRes}\n\n💡 *Reply:* \`yes\` to send now, \`schedule at <time>\`, or refine again.`;
      }
      if (/^(no|discard|nah|cancel)$/i.test(lower)) {
        await db.clearMenuSession(chatId);
        clearActiveDraft();
        return `❌ *Draft discarded.*\n───────────────\nReply *menu* anytime to start again.`;
      }
    }
  }

  // 3. SCHEDULE MESSAGE FLOW
  if (action === "schedule_message") {
    if (step === 1) {
      const parsed = parseRelativeDateTime(raw);
      if (parsed.error) {
        return `⚠️ *Invalid Time:* ${parsed.error}\n\nPlease enter a time like *"3pm tomorrow"*, *"2pm next Monday"*, or type *cancel*.`;
      }
      data.scheduledAt = parsed.timestamp;
      data.timeDisplay = parsed.displayTime;
      data.shortDisplay = parsed.shortDisplay;
      await db.setMenuSession(chatId, action, 2, data);
      return `📅 *SCHEDULE MESSAGE (Step 2/3)*\n───────────────\n⏰ *Time:* \`${data.displayTime || data.shortDisplay}\`\n\nWho should I send this message to? (Contact name or phone number)`;
    }
    if (step === 2) {
      data.recipient = raw;
      await db.setMenuSession(chatId, action, 3, data);
      return `📅 *SCHEDULE MESSAGE (Step 3/3)*\n───────────────\n⏰ *Time:* \`${data.displayTime || data.shortDisplay}\`\n👤 *Recipient:* ${data.recipient}\n\nWhat is the message content?`;
    }
    if (step === 3) {
      data.messageText = raw;
      const scheduled = await db.addScheduledMessage(data.recipient, data.messageText, data.scheduledAt);
      await db.clearMenuSession(chatId);
      return `✅ *MESSAGE SCHEDULED*\n───────────────\n👤 *Recipient:* ${data.recipient}\n⏰ *Send Time:* \`${data.shortDisplay}\` (${data.timeDisplay})\n💬 *Content:* ${data.messageText}\n🆔 *Schedule ID:* \`#${scheduled.id}\``;
    }
  }

  // 4. USE TEMPLATE FLOW
  if (action === "use_template") {
    if (step === 1) {
      const templates = data.templates || await db.getAllTemplates();
      let selectedTemplate = null;

      const num = parseInt(raw);
      if (!isNaN(num) && num > 0 && num <= templates.length) {
        selectedTemplate = templates[num - 1];
      } else {
        selectedTemplate = templates.find(t => t.name.toLowerCase() === lower);
      }

      if (!selectedTemplate) {
        return `⚠️ *Template Not Found.* Please type a valid template name or number (e.g. *1* or *${templates[0] ? templates[0].name : "quote"}*), or type *cancel*.`;
      }

      data.templateName = selectedTemplate.name;
      data.templateText = selectedTemplate.template_text;
      await db.setMenuSession(chatId, action, 2, data);
      return `📋 *USE TEMPLATE: \`${selectedTemplate.name}\` (Step 2/2)*\n───────────────\n💬 *Template:* _${selectedTemplate.template_text}_\n\nWho should I send this template to? (Contact name or phone number)`;
    }
    if (step === 2) {
      data.recipient = raw;
      let filled = data.templateText.replace(/\[Name\]|\[Contact\]|\[Client\]/gi, data.recipient);
      setActiveDraft({
        text: filled,
        recipient: data.recipient,
        phone: ""
      });
      await db.clearMenuSession(chatId);
      return `📝 *DRAFT READY FROM TEMPLATE*\n───────────────\n👤 *Recipient:* ${data.recipient}\n💬 *Draft Content:*\n${filled}\n───────────────\n💡 _Say "send" to dispatch now, "send at <time>" to schedule, or refine._`;
    }
  }

  // 5. ADD CONTACT FLOW
  if (action === "add_contact") {
    if (step === 1) {
      data.name = raw;
      await db.setMenuSession(chatId, action, 2, data);
      return `👤 *ADD CONTACT (Step 2/2)*\n───────────────\n📌 *Name:* ${data.name}\n\nWhat is their phone number? (e.g. *+60176001484* or *0176001484*)`;
    }
    if (step === 2) {
      let cleanPhone = raw.replace(/[\s\-\+]/g, "").trim();
      if (cleanPhone.startsWith("0")) cleanPhone = "60" + cleanPhone.substring(1);
      if (!/^\d{8,15}$/.test(cleanPhone)) {
        return `⚠️ *Invalid Phone Number.* Please enter a valid number (e.g. *+60176001484*), or type *cancel*.`;
      }
      await db.addContact(data.name, cleanPhone);
      await db.clearMenuSession(chatId);
      return `👤 *CONTACT SAVED*\n───────────────\n📌 *Name:* ${data.name}\n📞 *Phone:* \`+${cleanPhone}\`\n\n💡 _You can now use "${data.name}" directly when drafting or scheduling!_`;
    }
  }

  // 6. ADD EVENT FLOW
  if (action === "add_event") {
    if (step === 1) {
      data.title = raw;
      await db.setMenuSession(chatId, action, 2, data);
      return `📆 *ADD CALENDAR EVENT (Step 2/3)*\n───────────────\n📌 *Event:* ${data.title}\n\nWhat date? (e.g. *tomorrow*, *Saturday*, *2026-08-20*)`;
    }
    if (step === 2) {
      const parsed = parseRelativeDateTime(raw + " 10am");
      data.date = parsed.timestamp ? parsed.timestamp.split(" ")[0] : db.getKLDateStr();
      await db.setMenuSession(chatId, action, 3, data);
      return `📆 *ADD CALENDAR EVENT (Step 3/3)*\n───────────────\n📌 *Event:* ${data.title}\n📆 *Date:* \`${data.date}\`\n\nWhat time? (e.g. *3pm*, *10:30am*, *14:00*)`;
    }
    if (step === 3) {
      const parsedTime = parseRelativeDateTime(`today at ${raw}`);
      let startTime = "10:00";
      if (!parsedTime.error && parsedTime.timestamp) {
        startTime = parsedTime.timestamp.split(" ")[1].substring(0, 5);
      } else {
        const tMatch = raw.match(/\b([01]?\d|2[0-3])(?::([0-5]\d))?\s*(am|pm)?\b/i);
        if (tMatch) {
          let h = parseInt(tMatch[1]);
          const m = tMatch[2] ? tMatch[2] : "00";
          const ampm = tMatch[3] ? tMatch[3].toLowerCase() : "";
          if (ampm === "pm" && h < 12) h += 12;
          if (ampm === "am" && h === 12) h = 0;
          startTime = `${String(h).padStart(2, "0")}:${m}`;
        }
      }
      const event = await db.addEvent({
        title: data.title,
        date: data.date,
        startTime: startTime
      });
      await db.clearMenuSession(chatId);
      return `📆 *EVENT SCHEDULED*\n───────────────\n📌 *Event:* ${data.title}\n📆 *Date:* \`${data.date}\`\n⏰ *Time:* \`${startTime}\`\n🆔 *Event ID:* \`#${event.id}\`\n\n🔔 _3-Stage proactive reminders activated._`;
    }
  }

  // 7. ADD TASK FLOW
  if (action === "add_task") {
    const task = await db.addTask(raw);
    await db.clearMenuSession(chatId);
    return `✅ *TASK SAVED*\n───────────────\n📌 *Task:* ${raw}\n🆔 *Task ID:* \`#${task.id}\``;
  }

  // 8. ADD NOTE FLOW
  if (action === "add_note") {
    if (step === 1) {
      data.title = raw;
      await db.setMenuSession(chatId, action, 2, data);
      return `📝 *ADD NOTE (Step 2/2)*\n───────────────\n📌 *Title:* ${data.title}\n\nWhat is the content of the note?`;
    }
    if (step === 2) {
      data.content = raw;
      const note = await db.addNote(data.title, data.content);
      await db.clearMenuSession(chatId);
      return `📝 *NOTE SAVED*\n───────────────\n📌 *Title:* ${data.title}\n🆔 *Note ID:* \`#${note.id}\`\n💬 *Content:*\n${data.content}`;
    }
  }

  // 9. WEB SEARCH FLOW
  if (action === "search_web") {
    await db.clearMenuSession(chatId);
    const { searchWeb } = require("./search");
    return await searchWeb(raw);
  }

  await db.clearMenuSession(chatId);
  return null;
}

module.exports = {
  getActiveDraft,
  setActiveDraft,
  clearActiveDraft,
  parseRelativeDateTime,
  handleDraftMessage,
  handleRefineDraft,
  handleSendMessage,
  handleScheduleMessage,
  handleSetFollowupReminder,
  handleContactAdd,
  handleContactList,
  handleContactDelete,
  handleTemplateSave,
  handleTemplateList,
  handleTemplateUse,
  handleMessageHistory,
  handleShowMenu,
  showMenu,
  handleMenuSelection,
  handleGuidedFlowInput,
  handleDraftAndSend,
  checkAndDispatchScheduledMessages,
  checkAndProcessFollowups
};
