# 🤖 JARVIS AI — Autonomous WhatsApp Executive Assistant & Infrastructure Control Node

> **Owner:** Isaac David Christopher | **Business:** Creative Clicks Studios  
> **Tech Stack:** Node.js (v22+) • WhatsApp Web.js • Ollama (`neural-chat`) • SQLite3 • Puppeteer Core (Chromium) • Google Calendar API • Docker & Systemd  
> **Timezone:** Asia/Kuala_Lumpur (`UTC+08:00`)

---

## 📌 Project Overview

**JARVIS AI** is a 24/7 self-hosted, autonomous personal assistant and executive control system operating over WhatsApp. Designed specifically for Isaac's daily workflow as an IT student, media producer, head of Creative Clicks Studios, and drummer, JARVIS connects local LLM intelligence with real-world infrastructure, sqlite databases, live web scraping, remote command execution, proactive message scheduling, and multi-stage notification crons.

---

## 🏗️ System Architecture

```mermaid
flowchart TD
    A[📱 WhatsApp User / Isaac] -->|Message / Voice Note / Command| B[🤖 main.js - WhatsApp Web.js Client]
    B -->|Security Whitelist Check| C[🛡️ Security Guard & Anti-Loop Cache]
    C -->|Auto Memory Extraction| D[🧠 memory.js & SQLite Memories]
    C -->|Parse Input| E[⚡ intents.js - Hybrid Intent Parser]
    
    E -->|Tier 1 Regex / Tier 2 AI Fallback| F{Intent Classifier}
    
    F -->|show_menu / hi / menu| G[📱 messaging.js - Interactive Control Menu]
    F -->|draft_message / refine / send| H[📝 messaging.js - LLM Draft & Dispatch Engine]
    F -->|schedule_message| I[📅 messaging.js & db.js - Scheduled Messages Queue]
    F -->|set_followup_reminder| J[⏰ messaging.js & db.js - Auto-Followup Tracker]
    F -->|contact_add / list / delete| K[👤 messaging.js & db.js - Contact Aliases]
    F -->|template_save / use / list| L[📋 messaging.js & db.js - Message Templates]
    F -->|calendar_add / query| M[📅 db.js - SQLite Events & Reminders]
    F -->|task_add / list / complete| N[📋 db.js - SQLite Tasks]
    F -->|note_add / view / list| O[📝 db.js - SQLite Notes]
    F -->|web_search| P[🌐 search.js - Puppeteer Headless DDG + Wiki]
    F -->|server_status| Q[🖥️ server_health.js - Tailscale / Local Ping]
    F -->|generate_quote| R[📄 quotations.js - PDF / Text Invoice Drafts]
    F -->|remote_command (!exec)| S[⚡ cmd_runner.js - System Shell Runner]
    F -->|general| T[💬 ollama.js - Neural-Chat Executive Persona]

    G --> U[📤 Response Formatter formatForWhatsApp]
    H --> U
    I --> U
    J --> U
    K --> U
    L --> U
    M --> U
    N --> U
    O --> U
    P --> U
    Q --> U
    R --> U
    S --> U
    T --> U

    U -->|Dispatched via WhatsApp| A

    subgraph Cron Engine (main.js)
      V[⏰ 60s Scheduler] -->|Dispatch Due Messages| I
      V -->|Check Unanswered Followups| J
      V -->|3-Stage Event Reminders| M
      W[☀️ 8:00 AM Cron] -->|Executive Morning Digest| A
    end
```

---

## 🔥 Key Features & System Capabilities

### 1. 🤖 Interactive Clickable Menu & Guided Flows (`whatsapp-web.js` List Messages)
- **Interactive List Trigger**: Texting `"hi"`, `"hello"`, `"menu"`, `"help"`, `"commands"`, or `"features"` dispatches an interactive WhatsApp List Message with structured sections (`MESSAGING`, `SYSTEM`, `SERVER`).
- **Seamless Text Fallback**: Automatically provides rich-formatted WhatsApp text menu if client does not support interactive list widgets.
- **Guided Multi-Step Input Engine**: Clicking any option initiates a stateful conversation flow stored in SQLite (`menu_sessions` table):
  - **📝 Draft Message**: Asks *Who to send to?* → *What about?* → drafts via Ollama LLM → asks *Send? (yes/no/refine)* → dispatches on confirmation.
  - **📅 Schedule Message**: Asks *When to send? (e.g. 3pm tomorrow)* → *Who?* → *Message text?* → adds to queue.
  - **📋 Use Template**: Displays numbered template catalog → asks *Pick template* → *Send to who?* → auto-populates placeholders into active draft.
  - **👤 Add Contact**: Asks *Contact name?* → *Phone number?* → saves alias to `contacts` table.
  - **📆 Add Event**: Asks *Event title?* → *Date?* → *Time?* → schedules in calendar with 3-stage reminders.
  - **✅ Add Task**: Asks *Task description?* → stores pending todo item.
  - **📝 Add Note**: Asks *Note title?* → *Content?* → saves note to catalog.
  - **🌐 Search Web**: Asks *Search for what?* → scrapes live web and returns AI executive summary.
  - **🖥️ Server Status & ☀️ Morning Digest**: Executes immediately with zero prompts.
- **Cancellation & Safety**: Typing `cancel`, `abort`, `exit`, or `stop` at any point cleanly cancels the active flow. Uncompleted flows automatically expire safely.

### 2. 📝 Intelligent Messaging, Scheduling & Auto-Followup Engine (`messaging.js`)
- **Natural Language Message Drafting**: Drafts humanlike, articulate WhatsApp texts matching Isaac's executive persona via local Ollama LLM (`handleDraftMessage`). Auto-enriches content with contacts directory and calendar events.
* **Iterative Refinement**: Refines active drafts dynamically (`"change to more casual"`, `"add detail..."`, `"make it shorter"`).
* **Relative Date-Time Scheduling Engine**: Parses relative expressions (`"send this at 3pm tomorrow"`, `"send at 2pm next Monday"`, `"send in 6 hours"`) into exact MYT timestamps (`YYYY-MM-DD HH:MM:SS`).
* **Automated Cron Queue Dispatcher**: `main.js` checks `scheduled_messages` every 60 seconds, dispatches due messages via WhatsApp, logs outbound entries, and alerts Isaac upon delivery.
* **Auto-Followup Tracking & Escalation**: Monitors sent messages (`"remind me if Mark doesn't reply in 24 hours"`). If recipient remains silent after threshold, fires auto-followups to client and alerts Isaac (`⏰ AUTO-FOLLOWUP ALERT`). Auto-resolves when recipient replies.
* **Contact Aliases & Templates**: Name-to-phone mapping (`add contact Mark +60176001484`) and reusable templates (`save template quote_followup ...`, `use template quote_followup for Mark`).

### 3. ⚡ Remote Shell Command Execution (`cmd_runner.js`)
- **Direct Terminal Execution**: Run shell commands directly over WhatsApp using prefix triggers (`!exec`, `!cmd`, `!run`).
- **Interactive TUI Protection**: Automatically blocks interactive tools (`htop`, `vim`, `nano`, `less`) to prevent process hangs.
- **Output Sanitization**: Truncates long outputs to stay within WhatsApp message size limits.

### 4. 📅 Multi-Stage Event Calendar & Proactive Reminders (`db.js`)
- **Relative Date Engine**: Resolves natural relative dates (`"tuesday next week"`, `"This Sunday"`, `"tomorrow"`, `"day after tomorrow"`, `"in 3 days"`, `YYYY-MM-DD`, `DD/MM/YYYY`) without UTC day shifting.
- **3-Stage Proactive Reminders**:
  - **Stage 1 (Day-Of Morning)**: Fires on the day of the event (`☀️ TODAY'S EVENT REMINDER`).
  - **Stage 2 (2 Hours Before)**: Fires 120 minutes in advance (`⏳ STARTING IN ~2 HOURS`). Notifies clients automatically if contact number provided.
  - **Stage 3 (Imminent Start)**: Fires 15–30 minutes before start time (`🔴 STARTING NOW / SOON`).

### 5. 🌐 Puppeteer Live Web Search Engine (`search.js`)
- **Headless Chromium Primary Engine**: Bypasses bot/CAPTCHA blocks using headless Google Chrome/Chromium to scrape real-time DuckDuckGo HTML.
- **Organic Extraction & AI Summary**: Extracts titles, snippets, unescaped target URLs, and generates executive summaries via Ollama with clickable sources (`🔗 Top Sources`).

### 6. 🖥️ Infrastructure Health & Morning Digest
- **Server Health**: Pings multi-server architecture (`Friday` main production server, `Alpha` office server, `JARVIS` AI node).
- **Morning Digest**: Automated cron at 8:00 AM MYT summarizing today's events, pending tasks, and server statuses.

---

## 📁 File Structure & Component Map

| File / Folder | Role & Description |
| :--- | :--- |
| **`main.js`** | Core WhatsApp Web.js client entrypoint, message listener, typing indicators, anti-loop guards, reminder scheduler cron, morning digest cron. |
| **`messaging.js`** | Core messaging module (drafting, refinement, scheduling, auto-followup tracking, contacts, templates, history, menu). |
| **`intents.js`** | Hybrid Intent Classifier (Tier 1 Expanded Regex + Tier 2 Ollama AI Intent Fallback). |
| **`cmd_runner.js`** | Remote system shell command execution engine with formatting, timeout guards, and TUI protections. |
| **`search.js`** | Multi-provider web search module (Puppeteer Chromium primary + DDG API + Wikipedia API). |
| **`db.js`** | SQLite database module (`personal.db`), schema migrations, KL timezone helpers, query functions. |
| **`calendar.js`** | Google Calendar API integration module. |
| **`memory.js`** | Auto-extraction memory learning engine, preference manager, `MEMORY.md` sync. |
| **`ollama.js`** | Axios interface to local Ollama API (`neural-chat` model). |
| **`quotations.js`** | Quotation and invoice generation module for Creative Clicks Studios. |
| **`server_health.js`** | Infrastructure monitoring & Tailscale ICMP/HTTP server status checker. |
| **`AGENT.md`** | Complete profile documentation for Isaac & JARVIS tone guidelines. |
| **`MEMORY.md`** | Human-readable log of learned memories & preferences. |
| **`personal.db`** | SQLite database storing events, tasks, notes, memories, contacts, templates, scheduled messages, message log, followups. |
| **`prepare_dataset.py`** | PyTorch / HuggingFace dataset preparation script for model fine-tuning. |
| **`train.py`** | Training script for fine-tuning custom JARVIS boss-secretary LLM checkpoint. |
| **`Modelfile.jarvis`** | Ollama Modelfile configuration for JARVIS custom executive assistant model. |

---

## 🗄️ Database Schema (`personal.db`)

### `contacts` Table
```sql
CREATE TABLE contacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL,
  phone TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

### `message_templates` Table
```sql
CREATE TABLE message_templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL,
  template_text TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

### `scheduled_messages` Table
```sql
CREATE TABLE scheduled_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  recipient TEXT NOT NULL,
  message_text TEXT NOT NULL,
  scheduled_at DATETIME NOT NULL,
  sent_at DATETIME,
  status TEXT DEFAULT 'pending',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

### `message_log` Table
```sql
CREATE TABLE message_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  direction TEXT NOT NULL,
  sender TEXT,
  recipient TEXT,
  message_text TEXT NOT NULL,
  timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

### `message_followups` Table
```sql
CREATE TABLE message_followups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  original_message_id INTEGER,
  recipient TEXT NOT NULL,
  followup_triggered_at DATETIME NOT NULL,
  threshold_hours INTEGER DEFAULT 24,
  auto_reply_sent INTEGER DEFAULT 0,
  status TEXT DEFAULT 'pending',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

### `events` Table
```sql
CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  event_date TEXT NOT NULL,
  start_time TEXT,
  end_time TEXT,
  description TEXT,
  recipient_phone TEXT,
  reminder_sent INTEGER DEFAULT 0,
  reminder_day_sent INTEGER DEFAULT 0,
  reminder_2h_sent INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

### `tasks` Table
```sql
CREATE TABLE tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  text TEXT NOT NULL,
  completed INTEGER DEFAULT 0,
  reminder_sent INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

### `notes` Table
```sql
CREATE TABLE notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT,
  content TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

### `memories` Table
```sql
CREATE TABLE memories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  category TEXT DEFAULT 'general',
  fact TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

---

## 💬 Command & Natural Phrase Reference

| Category | Natural Phrasing / Command Example | Resulting Action |
| :--- | :--- | :--- |
| **Control Menu** | `"hi"`, `"hello"`, `"menu"`, `"help"` | Returns structured interactive WhatsApp Executive Control Menu. |
| **Draft Message** | `"draft message for Mark about photo shoot"` | Generates Ollama LLM draft enriched with contact & calendar info. |
| **Refine Draft** | `"make it more casual"` or `"add detail..."` | Rewrites active draft based on instructions. |
| **Send Message** | `"send"` or `"send to Mark"` | Dispatches message via WhatsApp Web.js and logs in `message_log`. |
| **Schedule Message** | `"send this at 3pm tomorrow"` | Queues message to send automatically at `15:00 MYT` next day. |
| **Auto-Followup** | `"remind me if Mark doesn't reply in 24 hours"` | Monitors recipient silence and alerts Isaac if unanswered after threshold. |
| **Contact Alias** | `"add contact Sarah +60123456789"` | Saves contact mapping for instant resolution by name. |
| **Message Template** | `"save template avail Hi [Name], available at 3pm"` | Saves reusable template text for client communications. |
| **Use Template** | `"use template avail for Sarah"` | Fills template placeholders and loads draft. |
| **Message History** | `"chat log"` or `"history with Mark"` | Retrieves searchable message log history. |
| **Remote Shell** | `"!exec uptime"` or `"!cmd df -h"` | Executes shell command on server and returns formatted output. |
| **Add Event** | `"Got a photo shoot with Sarah on Saturday at 3pm"` | Schedules event on calendar with 3-stage reminders. |
| **Add Task** | `"I need to buy new drumsticks tomorrow"` | Adds pending task to SQLite DB. |
| **Add Note** | `"Save note named Mistral AI: [content]"` | Saves note titled `Mistral AI`. |
| **Web Search** | `"Search web for latest AI news 2026"` | Scrapes organic web, synthesizes summary & source links. |
| **Server Health** | `"server status"` | Returns health status of Friday, Alpha, and JARVIS nodes. |
| **Morning Digest** | `"morning digest"` | Generates immediate executive briefing. |

---

## ⚙️ Environment & Running the System

### `.env` File Setup
```env
SESSION_ID=isaac_ai_session
PRIMARY_PHONE=60176001484
PRIMARY_USER_JID=60176001484@c.us
OLLAMA_URL=http://localhost:11434
TZ=Asia/Kuala_Lumpur
GOOGLE_APPLICATION_CREDENTIALS=./creds.json
```

### Running Locally
```bash
npm install
npm start
```

### Running via Systemd Daemon
```bash
sudo cp jarvisai.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now jarvisai
```
