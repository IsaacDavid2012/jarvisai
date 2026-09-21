const { queryOllama } = require("./ollama");
const { getKLDate, getKLDateStr, getKLTimeStr } = require("./db");

/**
 * Extracts a clean web search query by stripping common prefixes
 * @param {string} msg 
 * @returns {string}
 */
function extractSearchQuery(msg) {
  return msg
    .replace(/^(!|\/)(search|google|find|web)\s*/i, "")
    .replace(/^(can you |please )?(search web for|search for|search online for|search online|search web|search the web for|search the web|search|look up online|look up for|look up|google|find online|find out about|find out|tell me about|tell me who is|tell me what is|what is|who is|find)\s*:?\s*/i, "")
    .replace(/\s*\?+$/, "")
    .trim();
}

/**
 * Parses natural language relative and absolute date/time in Asia/Kuala_Lumpur (UTC+8)
 */
function parseDateTimeString(text) {
  if (!text) return null;
  const input = text.toLowerCase().trim();
  const now = getKLDate();

  let targetDate = new Date(now);
  let parsedTime = null; // "HH:MM"
  let isRecurring = null;

  // Check recurring
  if (/\b(every day|daily)\b/i.test(input)) {
    isRecurring = "daily";
  } else if (/\b(every week|weekly)\b/i.test(input)) {
    isRecurring = "weekly";
  }

  // 1. Check relative offsets like "in 15 minutes", "in 2 hours", "in 3 days"
  const inMinutesMatch = input.match(/(?:\bin\s+|^)(\d+)\s*(?:mins?|minutes?)\b/i);
  if (inMinutesMatch) {
    const mins = parseInt(inMinutesMatch[1], 10);
    const future = new Date(now.getTime() + mins * 60000);
    const dateStr = getKLDateStr(future);
    const timeStr = getKLTimeStr(future);
    return { dateStr, timeStr, dateTimeStr: `${dateStr} ${timeStr}:00`, isRecurring };
  }

  const inHoursMatch = input.match(/(?:\bin\s+|^)(\d+)\s*(?:hrs?|hours?)\b/i);
  if (inHoursMatch) {
    const hrs = parseInt(inHoursMatch[1], 10);
    const future = new Date(now.getTime() + hrs * 3600000);
    const dateStr = getKLDateStr(future);
    const timeStr = getKLTimeStr(future);
    return { dateStr, timeStr, dateTimeStr: `${dateStr} ${timeStr}:00`, isRecurring };
  }

  const inDaysMatch = input.match(/(?:\bin\s+|^)(\d+)\s*days?\b/i);
  if (inDaysMatch) {
    const days = parseInt(inDaysMatch[1], 10);
    targetDate.setDate(targetDate.getDate() + days);
  } else if (/\bday after tomorrow\b/i.test(input)) {
    targetDate.setDate(targetDate.getDate() + 2);
  } else if (/\btomorrow\b/i.test(input)) {
    targetDate.setDate(targetDate.getDate() + 1);
  } else if (/\btoday\b/i.test(input) || /\btonight\b/i.test(input)) {
    // Keep targetDate as today
  } else {
    // Check Day of Week (e.g., "Saturday", "next Tuesday", "this Friday")
    const daysOfWeek = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
    const dayMatch = input.match(/\b(next\s+|this\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/i);
    if (dayMatch) {
      const isNext = (dayMatch[1] || "").trim() === "next";
      const targetDayIndex = daysOfWeek.indexOf(dayMatch[2].toLowerCase());
      const currentDayIndex = now.getDay();
      let diff = targetDayIndex - currentDayIndex;

      if (diff <= 0) {
        diff += 7;
      }
      if (isNext && diff < 7) {
        diff += 7;
      }
      targetDate.setDate(targetDate.getDate() + diff);
    } else {
      // Check explicit date e.g. "aug 25", "25 august", "2026-08-25"
      const isoDateMatch = input.match(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/);
      if (isoDateMatch) {
        targetDate = new Date(parseInt(isoDateMatch[1], 10), parseInt(isoDateMatch[2], 10) - 1, parseInt(isoDateMatch[3], 10));
      } else {
        const monthNames = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
        const monthMatch = input.match(/\b(?:(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]{3,9})|([a-z]{3,9})\s+(\d{1,2})(?:st|nd|rd|th)?)\b/i);
        if (monthMatch) {
          const dayPart = parseInt(monthMatch[1] || monthMatch[4], 10);
          const monthStr = (monthMatch[2] || monthMatch[3]).toLowerCase().slice(0, 3);
          const mIndex = monthNames.indexOf(monthStr);
          if (mIndex !== -1 && dayPart >= 1 && dayPart <= 31) {
            targetDate.setMonth(mIndex, dayPart);
            if (targetDate.getTime() < now.getTime() - 24 * 3600000) {
              targetDate.setFullYear(targetDate.getFullYear() + 1);
            }
          }
        }
      }
    }
  }

  // 2. Parse Time (e.g. "3pm", "3:30pm", "15:00", "9:00 am", "noon", "midnight")
  const time12Match = input.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i);
  if (time12Match) {
    let hours = parseInt(time12Match[1], 10);
    const minutes = parseInt(time12Match[2] || "0", 10);
    const meridiem = time12Match[3].toLowerCase();

    if (meridiem === "pm" && hours < 12) hours += 12;
    if (meridiem === "am" && hours === 12) hours = 0;

    parsedTime = `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
  } else {
    const time24Match = input.match(/\b(?:at\s+)?([01]?\d|2[0-3]):([0-5]\d)\b/i);
    if (time24Match) {
      parsedTime = `${String(time24Match[1]).padStart(2, "0")}:${String(time24Match[2]).padStart(2, "0")}`;
    } else if (/\bnoon\b/i.test(input)) {
      parsedTime = "12:00";
    } else if (/\bmidnight\b/i.test(input)) {
      parsedTime = "00:00";
    } else if (/\btonight\b/i.test(input)) {
      parsedTime = "20:00";
    } else {
      const simpleAtHourMatch = input.match(/\bat\s+(\d{1,2})\b/i);
      if (simpleAtHourMatch) {
        let h = parseInt(simpleAtHourMatch[1], 10);
        if (h <= 12) {
          if (h >= 1 && h <= 7) h += 12;
        }
        parsedTime = `${String(h).padStart(2, "0")}:00`;
      }
    }
  }

  const dateStr = getKLDateStr(targetDate);
  const timeStr = parsedTime || "09:00";
  const dateTimeStr = `${dateStr} ${timeStr}:00`;

  return { dateStr, timeStr: parsedTime, dateTimeStr, isRecurring };
}

/**
 * Extracts title/text and date/time info from a calendar event or reminder message
 */
function extractEntityAndDate(rawText, defaultPrefixRegex) {
  const parsed = parseDateTimeString(rawText);
  let cleaned = rawText.replace(defaultPrefixRegex, "").trim();

  let title = cleaned
    .replace(/\b(today|tomorrow|day after tomorrow|tonight)\b/gi, "")
    .replace(/\b(next\s+|this\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/gi, "")
    .replace(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/gi, "")
    .replace(/\b(?:at\s+)?([01]?\d|2[0-3]):([0-5]\d)\b/gi, "")
    .replace(/\bat\s+\d{1,2}\b/gi, "")
    .replace(/(?:\bin\s+|^)\d+\s*(?:mins?|minutes?|hrs?|hours?|days?)\b(?:\s+to)?/gi, "")
    .replace(/\b(every day|daily|every week|weekly)\b/gi, "")
    .replace(/\b(?:on|at|for)\b/gi, "")
    .replace(/^\s*to\s+/i, "")
    .replace(/\s{2,}/g, " ")
    .trim();

  if (!title) {
    title = cleaned;
  }

  return {
    title,
    dateStr: parsed ? parsed.dateStr : getKLDateStr(),
    timeStr: parsed ? parsed.timeStr : null,
    dateTimeStr: parsed ? parsed.dateTimeStr : `${getKLDateStr()} 09:00:00`,
    isRecurring: parsed ? parsed.isRecurring : null
  };
}

/**
 * Fast Regex Intent Detector
 */
function parseIntentRegex(message) {
  const msg = message.toLowerCase().trim();

  // 0. Safety Killswitch
  if (/^(killswitch|emergency stop|shut off jarvis|shutdown jarvis|stop jarvis)$/i.test(msg)) {
    return "killswitch";
  }

  // 0.5 Activity & Audit Trail
  if (/^(what did you do today|activity log|audit log|actions today|today's actions|todays actions|what have you done today)/i.test(msg)) {
    return "activity_log";
  }

  // 0.6 Reminder Quick Actions (Done / Snooze)
  if (/^(done|complete|snooze(\s+\d+m?)?)$/i.test(msg)) {
    return "reminder_action";
  }

  // 0.7 Tomorrow Schedule Quick Query
  if (/^(what's on tomorrow|whats on tomorrow|what is on tomorrow|what do i have tomorrow|tomorrow schedule|tomorrow's schedule|tomorrows schedule|events tomorrow|tomorrow)$/i.test(msg)) {
    return "tomorrow_query";
  }

  // 0.8 Calendar Reschedule / Move Event
  if (/^(move|reschedule|postpone|shift|change date of)\s+(event\s+)?(#?\d+|[a-zA-Z0-9\s]+)\s+to\s+/i.test(msg)) {
    return "calendar_reschedule";
  }

  // 0.9 Server Container Specific Queries & Error Logs
  if (/^(is\s+([a-zA-Z0-9_-]+)\s+(running|up|alive|down|active|healthy|ok)\??|status\s+of\s+([a-zA-Z0-9_-]+)\??)/i.test(msg)) {
    return "server_service_query";
  }
  if (/^((show|view|get)\s+)?([a-zA-Z0-9_-]+)\s+(error\s+)?logs\b/i.test(msg) || /^logs\s+(of\s+)?([a-zA-Z0-9_-]+)/i.test(msg)) {
    return "server_service_logs";
  }
  if (/^restart\s+([a-zA-Z0-9_-]+)\b/i.test(msg)) {
    return "server_service_restart";
  }
  if (/^(stop|delete|kill|prune)\s+([a-zA-Z0-9_-]+)\b/i.test(msg)) {
    return "server_service_action";
  }

  // 1. Remote Command Execution
  if (/^(!|\/)(exec|cmd|run|bash|sh)\b/i.test(msg) || /^(run command|execute command|run shell|exec command)\s*:/i.test(msg)) {
    return "exec_command";
  }

  // 2. Tasks
  if (/^(task|todo)\s*:\s*.+/i.test(msg) || /^(add task|create task|add todo|create todo|new task)\b/i.test(msg)) {
    return "task_add";
  }
  if (/^(show|list|view|my|all|pending)\s+(tasks|todos)\b/i.test(msg) || msg === "tasks" || msg === "todos" || msg === "my tasks" || msg === "todo") {
    return "task_list";
  }
  if (/^(complete|done|finish|mark done)\s+task\s+#?(\d+)/i.test(msg) || /^task\s+#?(\d+)\s+(done|complete|completed|finished)/i.test(msg)) {
    return "task_complete";
  }
  if (/^(delete|remove|cancel)\s+task\s+#?(\d+)/i.test(msg)) {
    return "task_delete";
  }

  // 3. Notes
  if (/^(view|show|open|read|display)\s+note\s+(#?\d+|.+)/i.test(msg) || /^note\s+#?(\d+)$/i.test(msg)) {
    return "note_view";
  }
  if (/^note\s*:\s*.+/i.test(msg) || /^(add note|save note|create note|new note|take a note)\b/i.test(msg)) {
    return "note_add";
  }
  if (/^(show|list|view|all|my)\s+notes\b/i.test(msg) || msg === "notes" || msg === "my notes" || msg === "notes catalog") {
    return "note_list";
  }
  if (/^(delete|remove)\s+note\s+(#?\d+|.+)/i.test(msg)) {
    return "note_delete";
  }

  // 4. Reminders
  if (/^remind me\s+to\b/i.test(msg) || /^remind me\s+in\b/i.test(msg) || /^reminder\s*:\s*.+/i.test(msg) || /^set reminder\b/i.test(msg) || /^new reminder\b/i.test(msg)) {
    return "remind_add";
  }
  if (/^(show|list|view|check|my|all|pending)\s+reminders\b/i.test(msg) || msg === "reminders" || msg === "my reminders" || msg === "pending reminders") {
    return "remind_list";
  }
  if (/^(delete|remove|complete|done|cancel)\s+reminder\s+#?(\d+)/i.test(msg)) {
    return "remind_delete";
  }

  // 5. Calendar Events
  if (/^(what's today|whats today|what is today|show my events|my events|what's on|show calendar|my calendar|what do i have|events today|today's schedule|todays schedule)/i.test(msg) ||
      msg === "calendar" || msg === "events" || msg === "schedule" || msg === "today") {
    return "calendar_query";
  }
  if (/^(delete|remove|cancel)\s+event\s+#?(\d+)/i.test(msg)) {
    return "calendar_delete";
  }

  const eventKeywords = "(shoot|photo shoot|video shoot|session|meeting|practice|service|appointment|call|lunch|dinner|rehearsal|flight|badminton|gym|event)";
  const timeIndicators = "(at \\d|on \\d|tomorrow|today|tonight|this \\w+|next \\w+|in \\d+|\\d+pm|\\d+am|\\d+:\\d+|saturday|sunday|monday|tuesday|wednesday|thursday|friday)";

  if (/^(schedule|add event|create event|new event|event\s*:)\b/i.test(msg)) {
    return "calendar_add";
  }
  if (new RegExp(`\\b${eventKeywords}\\b.*${timeIndicators}`, "i").test(msg) || new RegExp(`${timeIndicators}.*\\b${eventKeywords}\\b`, "i").test(msg)) {
    return "calendar_add";
  }

  // 6. Web Search Intent
  if (/^(!|\/)(search|google|web)\b/i.test(msg) ||
      /^(search for|search web for|search web|search online for|search online|search the web for|search the web|search|look up online|look up for|look up|google|find online|find out about|tell me about|what is|who is|find)\b/i.test(msg)) {
    return "web_search";
  }

  // 7. Natural command queries (storage, RAM, docker, uptime, system resources)
  if (/(storage|disk space|how much space|free ram|ram usage|memory usage|running containers|docker ps|server uptime|system load|system health|system status|check resources|resource monitor|server load|hardware status)/i.test(msg)) {
    return "exec_command";
  }

  // 8. Morning Walkthrough / Briefing
  if (/(morning walkthrough|daily walkthrough|walkthrough|morning briefing|daily briefing|morning digest|briefing|today's briefing|todays briefing|morning update)/i.test(msg)) {
    return "morning_walkthrough";
  }

  // 9. Learned Memories
  if (/^remember\s*(that|to|about)?\s*.+/i.test(msg) || /^learn\s*(that)?\s*.+/i.test(msg)) {
    return "memory_add";
  }
  if (/^(show|list|view|my|all)\s+memories\b/i.test(msg) || msg === "memories" || msg === "my memory" || msg === "what do you remember") {
    return "memory_list";
  }
  if (/^(forget|delete|remove)\s+memory\s+#?(\d+)/i.test(msg)) {
    return "memory_delete";
  }

  return "general";
}

/**
 * High accuracy Intent Classifier combining regex + Ollama LLM fallback
 */
async function parseIntent(message) {
  const regexIntent = parseIntentRegex(message);
  if (regexIntent !== "general") {
    return regexIntent;
  }

  // If regex returns "general", check with Ollama for nuanced expressions
  const words = message.trim().split(/\s+/);
  if (words.length < 2) return "general";

  try {
    const prompt = `Classify the user's intent into EXACTLY ONE category:
User: "${message}"

Categories:
- web_search: Looking up facts, searching online, or asking what/who something is
- calendar_add: Scheduling an event/meeting/shoot with date or time
- calendar_query: Checking schedule, events, or asking what is happening today/this week
- task_add: Adding a to-do item or task
- note_add: Saving a note, idea, or information
- remind_add: Setting a timed reminder (e.g. remind me to call someone)
- exec_command: System check or running a server command
- morning_walkthrough: Requesting morning briefing, daily overview, or walkthrough
- memory_add: Explicitly telling the assistant to remember or learn a preference or fact
- general: General conversation, greeting, opinion, or casual chat

Respond ONLY with the category name string (e.g. web_search).`;

    const aiRes = await queryOllama(prompt, 0.1, 20);
    const cleanCategory = aiRes.trim().toLowerCase().replace(/[^a-z_]/g, "");
    const valid = ["web_search", "calendar_add", "calendar_query", "task_add", "note_add", "remind_add", "exec_command", "morning_walkthrough", "memory_add", "general"];

    if (valid.includes(cleanCategory)) {
      return cleanCategory;
    }
  } catch (err) {
    // Fallback gracefully
  }

  return "general";
}

module.exports = {
  parseIntent,
  parseIntentRegex,
  parseDateTimeString,
  extractEntityAndDate,
  extractSearchQuery
};
