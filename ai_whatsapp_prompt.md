# AI WhatsApp Assistant with Ollama + Google Calendar

## PROJECT OVERVIEW

Build a personal WhatsApp bot that:
- Connects to local Ollama (neural-chat model)
- Reads your Google Calendar
- Manages tasks (SQLite)
- Responds to natural language queries
- Runs 24/7 on home server
- Only accessible to me (personal business number)

**Tech Stack:** Node.js + OpenWA + Ollama + Google Calendar API + SQLite

---

## ARCHITECTURE

```
WhatsApp (Business Number)
        ↓
   OpenWA Client
        ↓
   Node.js Backend (main.js)
        ↓
   ┌─────────────────────────────────────┐
   │ Intent Parser                       │
   │ ├─ Calendar Query                   │
   │ ├─ Task Management                  │
   │ └─ General Chat                     │
   └─────────────────────────────────────┘
        ↓
   ┌─────────────────────────────────────┐
   │ Data Sources                        │
   │ ├─ Ollama (localhost:11434)          │
   │ ├─ Google Calendar API              │
   │ └─ SQLite Tasks DB                  │
   └─────────────────────────────────────┘
```

---

## FILE STRUCTURE

```
ai-whatsapp-assistant/
├── main.js                    # Entry point + WhatsApp handler
├── ollama.js                  # Ollama API calls
├── calendar.js                # Google Calendar API
├── tasks.js                   # SQLite task management
├── intents.js                 # Intent detection
├── package.json               # Dependencies
├── .env                       # Configuration (create yourself)
├── creds.json                 # Google service account (create yourself)
├── tasks.db                   # SQLite (auto-created)
├── Dockerfile                 # Container config
└── docker-compose.yml         # Full stack deploy
```

---

## COMPLETE CODE

### 1. `package.json`

```json
{
  "name": "ai-whatsapp-assistant",
  "version": "1.0.0",
  "description": "Personal WhatsApp AI assistant with Ollama + Calendar",
  "main": "main.js",
  "scripts": {
    "start": "node main.js",
    "dev": "nodemon main.js"
  },
  "dependencies": {
    "@open-wa/wa-automate": "^4.53.5",
    "axios": "^1.6.0",
    "dotenv": "^16.3.1",
    "sqlite3": "^5.1.6",
    "google-auth-library": "^9.2.0",
    "googleapis": "^118.0.0"
  }
}
```

---

### 2. `main.js` — Core WhatsApp Handler

```javascript
const wa = require("@open-wa/wa-automate");
const fs = require("fs");
const path = require("path");
require("dotenv").config();

const { queryOllama } = require("./ollama");
const { getCalendarEvents, scheduleEvent } = require("./calendar");
const { addTask, getTasks, completeTask } = require("./tasks");
const { parseIntent } = require("./intents");

const SESSION_ID = "isaac_ai_session";

let client;
let conversationHistory = {};

// Main initialization
async function initializeBot() {
  try {
    console.log("🚀 Initializing WhatsApp Bot...");
    
    client = await wa.create({
      sessionId: SESSION_ID,
      headless: true,
      chromeArgs: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage"
      ],
      autoRefresh: true,
      qrTimeout: 0
    });

    console.log("✅ WhatsApp Connected");

    // Message handler
    client.onMessage(async (message) => {
      // Ignore groups and media
      if (message.isGroupMsg || message.hasMedia) return;

      const sender = message.from;
      const userMsg = message.body.trim();

      if (!userMsg) return;

      try {
        console.log(`📨 [${sender}] ${userMsg}`);

        // Show typing
        await client.simulateTyping(sender, true);

        // Process message
        const response = await processMessage(userMsg, sender);

        // Stop typing
        await client.simulateTyping(sender, false);

        // Send response (split if too long)
        const chunks = splitMessage(response, 4096);
        for (const chunk of chunks) {
          await client.sendText(sender, chunk);
          await new Promise(r => setTimeout(r, 500)); // Rate limit
        }

        // Store history
        if (!conversationHistory[sender]) {
          conversationHistory[sender] = [];
        }
        conversationHistory[sender].push({
          user: userMsg,
          assistant: response,
          timestamp: new Date()
        });

        // Keep only last 10 messages
        if (conversationHistory[sender].length > 10) {
          conversationHistory[sender].shift();
        }

      } catch (error) {
        console.error(`❌ Error: ${error.message}`);
        await client.sendText(sender, "❌ Error processing message. Please try again.");
      }
    });

  } catch (error) {
    console.error("Connection error:", error);
    process.exit(1);
  }
}

// Main message processor
async function processMessage(userMsg, sender) {
  try {
    // Detect intent
    const intent = parseIntent(userMsg);

    // Get calendar context for all queries
    let calendarContext = "";
    try {
      const events = await getCalendarEvents();
      calendarContext = events.length > 0 
        ? `\n\nYour upcoming events:\n${events.map(e => `- ${e.summary} at ${e.start}`).join("\n")}`
        : "";
    } catch (e) {
      console.log("Calendar unavailable:", e.message);
    }

    // Route based on intent
    let response = "";

    if (intent === "calendar_query") {
      response = await handleCalendarQuery(userMsg, calendarContext);
    } else if (intent === "calendar_add") {
      response = await handleCalendarAdd(userMsg);
    } else if (intent === "task_add") {
      response = await handleTaskAdd(userMsg);
    } else if (intent === "task_list") {
      response = await handleTaskList();
    } else if (intent === "task_complete") {
      response = await handleTaskComplete(userMsg);
    } else {
      // General chat with Ollama
      response = await handleGeneralChat(userMsg, calendarContext, sender);
    }

    return response || "I didn't understand that. Try asking about your calendar or tasks.";

  } catch (error) {
    console.error("Message processing error:", error);
    throw error;
  }
}

// Intent handlers
async function handleCalendarQuery(userMsg, calendarContext) {
  const prompt = `You are Isaac's personal assistant. Answer questions about his calendar concisely.

${calendarContext || "No upcoming events."}

User: ${userMsg}

Answer in 1-2 sentences. If no relevant event, say so clearly.`;

  return await queryOllama(prompt);
}

async function handleCalendarAdd(userMsg) {
  try {
    // Extract from AI first
    const extractPrompt = `Extract event details from: "${userMsg}"
Return JSON ONLY (no markdown): {"title":"...", "date":"YYYY-MM-DD", "time":"HH:MM", "description":"..."}
If missing date/time, use reasonable defaults.`;

    const extractedJson = await queryOllama(extractPrompt);
    const eventData = JSON.parse(extractedJson);

    const result = await scheduleEvent(eventData);
    return `✅ Scheduled: ${result.summary}`;
  } catch (error) {
    return `❌ Could not schedule: ${error.message}`;
  }
}

async function handleTaskAdd(userMsg) {
  try {
    const taskText = userMsg.replace(/^(add|create)\s+(task|reminder)?\s*:?\s*/i, "").trim();
    const result = addTask(taskText);
    return `✅ Task added: ${taskText}`;
  } catch (error) {
    return `❌ Error: ${error.message}`;
  }
}

async function handleTaskList() {
  const tasks = getTasks();
  if (tasks.length === 0) return "📭 No tasks.";
  return `📋 Your tasks:\n${tasks.map((t, i) => `${i + 1}. ${t.text}`).join("\n")}`;
}

async function handleTaskComplete(userMsg) {
  try {
    const taskNum = parseInt(userMsg.match(/\d+/)[0]);
    const tasks = getTasks();
    if (taskNum > 0 && taskNum <= tasks.length) {
      completeTask(tasks[taskNum - 1].id);
      return `✅ Task completed.`;
    }
    return "❌ Task not found.";
  } catch (error) {
    return "❌ Error completing task.";
  }
}

async function handleGeneralChat(userMsg, calendarContext, sender) {
  // Build context with conversation history
  let history = "";
  if (conversationHistory[sender]) {
    history = conversationHistory[sender]
      .slice(-3) // Last 3 messages
      .map(m => `User: ${m.user}\nAssistant: ${m.assistant}`)
      .join("\n\n");
    history = "\n\nRecent conversation:\n" + history;
  }

  const prompt = `You are Isaac's personal AI assistant. You're helpful, direct, and conversational.

${calendarContext || ""}${history || ""}

User: ${userMsg}

Respond naturally and concisely (1-3 sentences). Be helpful.`;

  return await queryOllama(prompt);
}

// Utility: Split long messages
function splitMessage(msg, maxLength) {
  if (msg.length <= maxLength) return [msg];
  
  const chunks = [];
  let remaining = msg;
  
  while (remaining.length > 0) {
    chunks.push(remaining.substring(0, maxLength));
    remaining = remaining.substring(maxLength);
  }
  
  return chunks;
}

// Start bot
initializeBot().catch(console.error);

// Graceful shutdown
process.on("SIGINT", () => {
  console.log("\n👋 Shutting down...");
  if (client) client.logout();
  process.exit(0);
});
```

---

### 3. `ollama.js` — Ollama Integration

```javascript
const axios = require("axios");

const OLLAMA_URL = process.env.OLLAMA_URL || "http://localhost:11434";
const MODEL = "neural-chat";

async function queryOllama(prompt, temperature = 0.7) {
  try {
    const response = await axios.post(`${OLLAMA_URL}/api/generate`, {
      model: MODEL,
      prompt: prompt,
      stream: false,
      temperature: temperature,
      top_p: 0.9,
      top_k: 40
    }, {
      timeout: 60000
    });

    let text = response.data.response.trim();
    
    // Clean up markdown
    text = text.replace(/^```[\w]*\n?/gm, "").replace(/```$/gm, "");
    
    return text;
  } catch (error) {
    console.error("Ollama error:", error.message);
    throw new Error(`Ollama error: ${error.message}`);
  }
}

module.exports = { queryOllama };
```

---

### 4. `calendar.js` — Google Calendar API

```javascript
const { google } = require("googleapis");
const fs = require("fs");
const path = require("path");

// Load credentials
const CREDS_PATH = path.join(__dirname, "creds.json");
const auth = new google.auth.GoogleAuth({
  keyFile: CREDS_PATH,
  scopes: [
    "https://www.googleapis.com/auth/calendar.readonly",
    "https://www.googleapis.com/auth/calendar"
  ]
});

const calendar = google.calendar({ version: "v3", auth });

async function getCalendarEvents(days = 7) {
  try {
    const now = new Date();
    const later = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);

    const response = await calendar.events.list({
      calendarId: "primary",
      timeMin: now.toISOString(),
      timeMax: later.toISOString(),
      maxResults: 10,
      singleEvents: true,
      orderBy: "startTime"
    });

    const events = response.data.items || [];
    return events.map(event => ({
      id: event.id,
      summary: event.summary,
      start: event.start.dateTime || event.start.date,
      end: event.end.dateTime || event.end.date,
      description: event.description || ""
    }));

  } catch (error) {
    console.error("Calendar error:", error);
    return [];
  }
}

async function scheduleEvent(eventData) {
  try {
    const event = {
      summary: eventData.title,
      description: eventData.description || "",
      start: {
        dateTime: new Date(`${eventData.date}T${eventData.time}`),
        timeZone: "Asia/Kuala_Lumpur"
      },
      end: {
        dateTime: new Date(`${eventData.date}T${incrementTime(eventData.time)}`),
        timeZone: "Asia/Kuala_Lumpur"
      }
    };

    const response = await calendar.events.insert({
      calendarId: "primary",
      resource: event
    });

    return response.data;

  } catch (error) {
    console.error("Schedule error:", error);
    throw error;
  }
}

function incrementTime(time) {
  const [h, m] = time.split(":").map(Number);
  const newHour = h + 1;
  return `${String(newHour).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

module.exports = { getCalendarEvents, scheduleEvent };
```

---

### 5. `tasks.js` — SQLite Task Management

```javascript
const sqlite3 = require("sqlite3").verbose();
const path = require("path");

const DB_PATH = path.join(__dirname, "tasks.db");
const db = new sqlite3.Database(DB_PATH);

// Initialize table
db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      text TEXT NOT NULL,
      completed INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
});

function addTask(text) {
  return new Promise((resolve, reject) => {
    db.run("INSERT INTO tasks (text) VALUES (?)", [text], function(err) {
      if (err) reject(err);
      else resolve({ id: this.lastID, text });
    });
  });
}

function getTasks(completed = false) {
  return new Promise((resolve, reject) => {
    const query = completed 
      ? "SELECT * FROM tasks WHERE completed = 1 ORDER BY created_at DESC"
      : "SELECT * FROM tasks WHERE completed = 0 ORDER BY created_at DESC";
    
    db.all(query, [], (err, rows) => {
      if (err) reject(err);
      else resolve(rows || []);
    });
  });
}

function completeTask(id) {
  return new Promise((resolve, reject) => {
    db.run("UPDATE tasks SET completed = 1 WHERE id = ?", [id], function(err) {
      if (err) reject(err);
      else resolve({ id });
    });
  });
}

function deleteTask(id) {
  return new Promise((resolve, reject) => {
    db.run("DELETE FROM tasks WHERE id = ?", [id], function(err) {
      if (err) reject(err);
      else resolve({ id });
    });
  });
}

module.exports = { addTask, getTasks, completeTask, deleteTask };
```

---

### 6. `intents.js` — Intent Detection

```javascript
function parseIntent(message) {
  const msg = message.toLowerCase();

  // Calendar queries
  if (/what|when|show|list|upcoming|schedule.*\?/.test(msg)) {
    if (/calendar|event|meeting|appointment|busy|free|schedule/.test(msg)) {
      return "calendar_query";
    }
  }

  // Calendar add
  if (/schedule|book|add.*meeting|add.*event|remind.*at|set.*reminder/.test(msg)) {
    return "calendar_add";
  }

  // Task add
  if (/add task|create task|remember|add.*todo|remind.*to/.test(msg)) {
    return "task_add";
  }

  // Task list
  if (/show.*task|list.*task|my task|what.*todo/.test(msg)) {
    return "task_list";
  }

  // Task complete
  if (/done|complete|finish|mark.*task|check|tick/.test(msg)) {
    return "task_complete";
  }

  // Default
  return "general";
}

module.exports = { parseIntent };
```

---

### 7. `.env` (Create this file)

```env
# Ollama
OLLAMA_URL=http://localhost:11434

# Session ID (can be anything)
SESSION_ID=isaac_ai_session

# Google Calendar
GOOGLE_APPLICATION_CREDENTIALS=./creds.json
```

---

### 8. `Dockerfile`

```dockerfile
FROM node:18-slim

WORKDIR /app

# Install dependencies for OpenWA
RUN apt-get update && apt-get install -y \
    chromium-browser \
    libnss3 \
    libxss1 \
    libasound2 \
    && rm -rf /var/lib/apt/lists/*

# Copy app
COPY package.json .
RUN npm install

COPY . .

# Run bot
CMD ["npm", "start"]
```

---

### 9. `docker-compose.yml`

```yaml
version: "3.8"

services:
  ollama:
    image: ollama/ollama:latest
    container_name: ollama-neural-chat
    ports:
      - "11434:11434"
    volumes:
      - ollama_data:/root/.ollama
    environment:
      - OLLAMA_NUM_THREAD=4
    command: serve

  whatsapp-bot:
    build: .
    container_name: ai-whatsapp-assistant
    depends_on:
      - ollama
    volumes:
      - ./creds.json:/app/creds.json:ro
      - ./tasks.db:/app/tasks.db
    environment:
      - OLLAMA_URL=http://ollama:11434
      - NODE_ENV=production
    stdin_open: true
    tty: true
    network_mode: host

volumes:
  ollama_data:
```

---

## SETUP INSTRUCTIONS

### Step 1: Prepare Google Calendar

1. Go to Google Cloud Console: https://console.cloud.google.com
2. Create new project: "AI Assistant"
3. Enable Google Calendar API
4. Create Service Account:
   - Service account name: `ai-assistant`
   - Grant role: Editor
5. Create JSON key → Download as `creds.json`
6. Copy `creds.json` to project root
7. Share your Google Calendar with the service account email

### Step 2: Ollama Setup

```bash
# On your server with Ollama
ollama pull neural-chat

# Verify running
curl http://localhost:11434/api/tags
```

### Step 3: Project Setup

```bash
# Clone/create project
mkdir ai-whatsapp-assistant
cd ai-whatsapp-assistant

# Copy all files above into this directory
# Create .env and creds.json (see above)

# Install dependencies
npm install

# Test locally
npm start

# First run: Scan QR code with WhatsApp
```

### Step 4: First Run

1. Run `npm start`
2. Terminal will show QR code
3. Open WhatsApp on phone
4. Settings → Linked Devices → Link Device
5. Scan QR with business number
6. Bot will start responding

### Step 5: Deploy to FRIDAY Server

```bash
# On FRIDAY
docker-compose up -d

# Verify
docker logs -f ai-whatsapp-assistant

# Check Ollama
docker logs ollama-neural-chat
```

---

## USAGE EXAMPLES

**Calendar:**
- "What's on my calendar today?"
- "Schedule a meeting Tuesday at 2pm"
- "Am I free this week?"

**Tasks:**
- "Add task: finish the CRM"
- "Show my tasks"
- "Complete task 1"

**General:**
- "What time is it?"
- "Tell me about my week"
- "How's the weather?"

---

## TROUBLESHOOTING

### No QR code appearing
```bash
# Reset session
rm -rf ./.wwebjs_auth
npm start
```

### Ollama connection error
```bash
# Verify Ollama running
curl http://localhost:11434/api/tags

# Check if model loaded
ollama list
```

### WhatsApp blocks bot
- Use a dedicated business number
- Don't spam messages
- Add delays between responses (already in code)

### Calendar API errors
- Verify `creds.json` exists
- Check service account has Calendar access
- Confirm calendar is shared with service account email

---

## PRODUCTION CHECKLIST

- [ ] Ollama running 24/7
- [ ] Docker container auto-restart
- [ ] Backup `tasks.db` weekly
- [ ] Monitor logs for errors
- [ ] Test calendar access weekly
- [ ] Update Ollama model monthly

---

## OPTIONAL ENHANCEMENTS

1. **Persistent session** → Save to cloud
2. **Multiple calendars** → Add more sources
3. **Email integration** → Read emails
4. **Weather API** → Add weather queries
5. **News feed** → Daily briefing
6. **Photography reminders** → Auto-schedule shoots

---

## FILES TO CREATE/PROVIDE YOURSELF

1. **`creds.json`** - From Google Cloud Console
2. **`.env`** - Configuration file
3. **`tasks.db`** - Auto-created on first run

---

**This is ready to deploy. Hand to Antigravity or build yourself. Let it run.**
