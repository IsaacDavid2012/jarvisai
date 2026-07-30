const { queryOllama } = require("./ollama");

function parseIntentRegex(message) {
  const msg = message.toLowerCase().trim();

  // --- QUOTATION & INVOICE INTENTS ---
  if (/(generate quote|create quote|quotation|generate invoice|create invoice|quote for|invoice for|send.*quotation|send.*quote|draft.*quote|quote\b|invoice\b|client name|pricing for|rate for)/.test(msg)) {
    return "generate_quote";
  }

  // --- SERVER STATUS INTENT ---
  if (/(server status|check server|check servers|server health|ping friday|ping alpha|ping jarvis|servers\b|how are (the |my )?servers|server status|infra status|is friday up|is alpha up)/.test(msg)) {
    return "server_status";
  }

  // --- MORNING DIGEST INTENT ---
  if (/(morning digest|daily briefing|morning report|digest\b|briefing\b|daily summary|morning update)/.test(msg)) {
    return "morning_digest";
  }

  // --- CONTENT IDEAS INTENT ---
  if (/(content ideas|tiktok ideas|drum ideas|video ideas|youtube ideas|ideas for|give me ideas|brainstorm content)/.test(msg)) {
    return "content_ideas";
  }

  // --- NOTES INTENTS ---
  if (/(view|show|open|read|display|select)\s+note\s+(#?\d+)/.test(msg) || /^\s*note\s+(#?\d+)\s*$/.test(msg)) {
    return "note_view";
  }
  if (/(note down|save note|add note|create note|take a note|remember note|remember that|note\s*:|keep a note|write down|make a note|save this note)/.test(msg)) {
    return "note_add";
  }
  if (/(show|list|view|my|all)\s+notes\b/.test(msg) || msg === "notes" || msg === "my notes") {
    return "note_list";
  }
  if (/(search|find|lookup)\s+note\b/.test(msg)) {
    return "note_search";
  }
  if (/(delete|remove)\s+note\b/.test(msg)) {
    return "note_delete";
  }

  // --- MEMORY & LEARNING INTENTS ---
  if (/(remember that|learn that|keep in mind|remember this|save preference|learn this|note that|remember\b:|prefers|likes to|dislikes|favorite|always use|never use)/.test(msg)) {
    return "memory_add";
  }
  if (/(show|list|view|what do you|my)\s+(memories|memory|preferences|learned)\b/.test(msg) || msg === "memory" || msg === "memories") {
    return "memory_list";
  }
  if (/(forget|delete|remove)\s+memory\b/.test(msg)) {
    return "memory_delete";
  }

  // --- CALENDAR & REMINDER INTENTS ---
  const eventWords = "(shoot|session|meeting|practice|service|class|call|flight|dinner|lunch|hangout|badminton|gym|appointment|gig|recording|edit|rehearsal|event|reminder)";
  const timeIndicators = "(at \\d|on \\d|tomorrow|today|this \\w+|next \\w+|in \\d+|from now|\\d+pm|\\d+am|\\d+:\\d+)";

  if (/(schedule|book|add event|create event|set an event|set event|add meeting|create meeting|remind me|new reminder|set reminder|set a reminder|reminder for|add reminder|add to calendar|put in calendar|add to schedule|new event|put on my calendar|put on my schedule)/.test(msg)) {
    return "calendar_add";
  }

  if (new RegExp(`\\b${eventWords}\\b.*${timeIndicators}`, "i").test(msg) || new RegExp(`${timeIndicators}.*\\b${eventWords}\\b`, "i").test(msg)) {
    return "calendar_add";
  }

  if (/(got a|have a|going to|heading to|heading out for)\s+.*(at|on|tomorrow|today|this|next|\d+pm|\d+am)/.test(msg)) {
    return "calendar_add";
  }

  if (/(delete|remove|cancel)\s+(event|meeting|reminder|appointment)/.test(msg)) {
    return "calendar_delete";
  }

  if (/(what|when|show|list|view|upcoming|my|today|this week|how's my|how is my)\s*.*(calendar|event|meeting|appointment|schedule|reminder|week|day)/.test(msg) || 
      /what's (my )?(schedule|calendar|week|today|upcoming)/.test(msg) ||
      /how's my week looking/.test(msg) ||
      msg === "calendar" || msg === "schedule" || msg === "events" || msg === "my schedule" || msg === "what's on") {
    return "calendar_query";
  }

  // --- TASKS INTENTS ---
  if (/(add task|create task|add todo|create todo|new task|todo\s*:|add to my todo|add to my tasks|put on my task list|need to|have to|must|don't forget to|dont forget to|remember to)/.test(msg)) {
    return "task_add";
  }
  if (/(show|list|view|my|all|pending)\s+(tasks|todos)/.test(msg) || msg === "tasks" || msg === "todos" || msg === "my tasks" || msg === "to do" || msg === "todo" || msg === "task list") {
    return "task_list";
  }
  if (/(done|complete|finish|mark|completed)\s+task/.test(msg) || /task\s+\d+\s+(done|complete|finished)/.test(msg)) {
    return "task_complete";
  }
  if (/(delete|remove)\s+task/.test(msg)) {
    return "task_delete";
  }

  // --- WEB SEARCH & RESEARCH INTENTS ---
  if (/(search web|web search|google|browse|search online|find online|look up online|search for|look up|what is|who is|how to|latest news|research|find out|tell me about|investigate|compare|vs|benefits of|pros and cons)/.test(msg)) {
    return "web_search";
  }

  // --- OUTBOUND MESSAGE INTENT ---
  if (/(send message|send msg|send whatsapp|send text)\b/.test(msg)) {
    return "send_message";
  }
  if (/(send to|send it to)\b/.test(msg) && /(\+?\d[\d\s\-]{7,15}\d)/.test(msg)) {
    return "send_message";
  }

  return "general";
}

async function parseIntent(message) {
  const regexIntent = parseIntentRegex(message);
  if (regexIntent !== "general") {
    return regexIntent;
  }

  // If regex returns "general" and message has > 2 words, ask AI classifier to determine intent
  const words = message.trim().split(/\s+/);
  if (words.length < 2) return "general";

  try {
    const prompt = `Categorize intent of user message: "${message}"
Options:
- calendar_add (schedule meeting/shoot/event/reminder with date or time)
- calendar_query (ask about schedule/calendar/events)
- task_add (something user needs to do/buy/finish)
- note_add (save information/idea/note)
- memory_add (user preference/fact to remember)
- web_search (lookup information/news/facts online)
- generate_quote (request quote/invoice)
- server_status (check servers)
- general (casual chat, greeting, question)

Return ONLY the option name string (e.g. calendar_add).`;

    const aiRes = await queryOllama(prompt, 0.1, 25);
    const cleanCategory = aiRes.trim().toLowerCase().replace(/[^a-z_]/g, "");
    const valid = ["calendar_add", "calendar_query", "task_add", "note_add", "memory_add", "web_search", "generate_quote", "server_status", "general"];
    if (valid.includes(cleanCategory)) {
      console.log(`🤖 AI Intent Classifier detected: "${cleanCategory}" for "${message}"`);
      return cleanCategory;
    }
  } catch (e) {
    // Fallback gracefully on LLM timeout or error
  }

  return "general";
}

module.exports = { parseIntent };
