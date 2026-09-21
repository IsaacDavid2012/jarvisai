# 🤖 JARVIS AI — Autonomous Dual-Channel Executive Assistant & Infrastructure Node

> **Owner:** Isaac David Christopher  
> **Tech Stack:** Node.js (v22+) • WhatsApp Web (`whatsapp-web.js`) • Asterisk PBX (AudioSocket / SIP) • Python 3 (faster-whisper, Edge-TTS, Piper) • Ollama (`qwen2.5:3b`) • SQLite3 • Docker • Tailscale  
> **Timezone:** Asia/Kuala_Lumpur (`UTC+08:00`)  
> **Status:** Production Active (24/7 Operations)

---

## 📌 Project Overview

**JARVIS AI** is an autonomous, self-hosted personal AI assistant and infrastructure operations engine. Operating across **WhatsApp** (text, interactive menus, voice notes) and **SIP Telephony** (real-time voice phone calls with sub-50ms conversational barge-in), JARVIS links local LLM intelligence with bare-metal Linux server management, calendar scheduling, proactive alerting, and strict safety guardrails.

---

## 🏗️ System Architecture

```mermaid
flowchart TD
    subgraph Clients["User Touchpoints (Isaac)"]
        WA["📱 WhatsApp Client (+6017***1484)"]
        SIP_DEV["📞 Linphone / VoIP Handset (SIP Ext 101 @ Tailscale)"]
    end

    subgraph ExternalMonitor["External Supervision"]
        HEARTBEAT["💓 Healthchecks.io Dead-Man's Switch\n(https://hc-ping.com/...)"]
    end

    subgraph Host["Host System: jarvis (Linux x86_64)"]
        subgraph WhatsAppLayer["WhatsApp Service (jarvisai.service)"]
            WWEB["whatsapp-web.js (Puppeteer)"]
            ROUTER["Message Router (main.js / intents.js)"]
            SCHED["15s Dispatcher & Cron Engine"]
            ALLOWLIST["Strict Command Allowlist & PIN Lockout (cmd_runner.js)"]
            REDACTOR["Credential & Token Redactor"]
            MONITOR["Resource & Heartbeat Monitor (system_monitor.js)"]
        end

        subgraph VoiceLayer["VoIP / SIP Service (jarvis-sip.service)"]
            AST["Asterisk PBX (pjsip / AudioSocket)"]
            BRIDGE["Python Neural Voice Bridge (sip_bridge.py)"]
            CODE_LOCK["Code-Level Voice Lockdown Filter"]
            STT["faster-whisper (CPU int8 / base.en)"]
            VAD["Barge-In Energy VAD (<50ms Cutoff)"]
            TTS["Speech Synthesis (Local Piper / Edge-TTS)"]
            DIALER["Outbound Call Dialer (call_isaac.py)"]
        end

        subgraph Storage["Data & Intelligence"]
            OLLAMA["Ollama LLM (qwen2.5:3b)"]
            SQLITE[("personal.db (SQLite)")]
            BACKUP["Automated Daily Backups (backups/)"]
        end

        subgraph Infrastructure["Host Infrastructure"]
            DOCKER["Docker Daemon (Coolify, Immich, Jellyfin, etc.)"]
            TAILSCALE["Tailscale Interface (tailscale0)"]
            CF["Cloudflare Daemon (cloudflared)"]
        end
    end

    WA <-->|End-to-End Encrypted WebSockets| WWEB
    SIP_DEV <-->|SIP Signaling & 16kHz Audio| AST
    AST <-->|AudioSocket TCP (9092)| BRIDGE

    WWEB --> ROUTER
    ROUTER --> ALLOWLIST
    ALLOWLIST --> REDACTOR
    REDACTOR --> DOCKER
    ALLOWLIST --> TAILSCALE
    ALLOWLIST --> CF

    ROUTER <--> OLLAMA
    ROUTER <--> SQLITE
    SCHED <--> SQLITE
    SCHED -->|08:00 Brief / 15m Call| DIALER
    DIALER --> AST

    MONITOR -->|60s Heartbeat Ping| HEARTBEAT
    SCHED -->|04:00 AM Daily Run| BACKUP

    BRIDGE --> CODE_LOCK
    CODE_LOCK -->|Allowed Voice Tasks| STT
    CODE_LOCK -->|Administrative Request Refusal| TTS
    BRIDGE <--> VAD
    BRIDGE <--> TTS
    BRIDGE <--> OLLAMA
    BRIDGE <--> SQLITE
```

---

## 🔥 Key Capabilities

### 1. 📅 Calendar, Scheduling & Proactive Reminders
* **Natural Language Management**: Add, move, and cancel events using conversational language (*"Meeting Thursday 3pm"*, *"Move meeting to Friday 4pm"*).
* **Interval-Based Clash Detection**: Evaluates full meeting time windows (`startA < endB && endA > startB`) to detect overlapping multi-hour meetings and warn before scheduling.
* **Repeating Reminders with 5-Repeat Cap**: Reminders repeat every 15 minutes until acknowledged with `"done"` or `"snooze [Xm]"`. Alerts cap at 5 attempts (75 minutes) to prevent late-night disturbance.
* **15-Minute Advance Phone Notification**: Every scheduled reminder triggers an automated outbound voice call to Linphone (`101`) and a WhatsApp alert 15 minutes before due time.
* **Soft Delete with 24-Hour Undo**: Deleting events sets a `deleted_at` timestamp. Texting `"undo"` instantly restores the most recently cancelled event.
* **Ambiguous Request Disambiguation**: Texting `"Cancel lunch"` with multiple matching events prompts Isaac with numbered choices.
* **Mobile Sync (iCalendar)**: Text `"export calendar"` to receive a standard `calendar.ics` file on WhatsApp that imports directly into Google Calendar, Apple Calendar, or Outlook.
* **1-Line Tomorrow Summary**: Querying *"What's on tomorrow?"* returns an executive single-line recap.

### 2. 🌅 Daily 8:00 AM Walkthrough Call
* Every morning at **08:00:00 (UTC+8)**:
  1. Compiles a concise audio debrief covering today's appointments, open tasks, overdue deadlines, and host health.
  2. Dials extension `101` (Linphone) over Tailscale and speaks the debrief.
  3. Sends a companion overview to WhatsApp.
* **24/7 Operations**: Operates continuously around the clock with zero alert suppression.

### 3. 📞 Full-Duplex Neural Voice Telephony
* **Sub-50ms Conversational Barge-In**: Real-time energy VAD (<40ms detection) halts audio playback immediately when speech is detected so you can interrupt JARVIS naturally.
* **Code-Level Voice Lockdown**: Server administrative commands (restart, reboot, docker stop/rm, bash) are intercepted and rejected directly in Python code before reaching the LLM.
* **Dual TTS Engine (Local Piper + Edge-TTS)**:
  * **Local Piper TTS**: Standalone binary and British neural model (`en_GB-alan-medium.onnx`) running 100% offline (0.22s inference for 4.7s audio).
  * **Edge-TTS**: Cloud neural voice (`en-GB-RyanNeural`).
  * Configurable via `TTS_ENGINE=piper` or `edge` in `.env`.
* **Outbound Disaster Calling**: If CPU > 95%, RAM > 90%, or Disk > 95% is sustained, JARVIS dials Isaac's handset to alert of critical failure.

### 4. 🖥️ Server & Container Management
* **Exact Container Matching**: Queries like *"Is Immich running?"* or *"Is Jellyfin up?"* evaluate exact container names and unambiguous word boundaries.
* **Filtered Error Logs**: Commands like *"Show Jellyfin logs"* extract strictly the last 3–6 critical error lines (`grep -iE 'error|fatal|fail'`), avoiding text spam.
* **Automated Credential Redaction**: All command outputs and logs are sanitized before sending, redacting passwords (`password=[REDACTED]`), API tokens (`token=[REDACTED]`), Bearer tokens, private keys, and database connection strings.
* **Infrastructure Telemetry**: Querying *"Server status"* reports CPU load, RAM allocation, disk usage, Tailscale mesh state, Cloudflare tunnel health, and internet ping.

### 5. 🛡️ Safety & Security Matrix
* **Strict Command Allowlist**: Arbitrary shell execution (`!exec`, `!cmd`, or LLM hallucinated shell commands) is blocked. Only allowlisted diagnostics (`uptime`, `free -h`, `df -h`, `docker ps`, `ip -br a`) are executable.
* **Two-Phase Restart Confirmation**: Service restarts prompt for explicit `"yes"` confirmation with a 60-second auto-expiry window.
* **Three-Strike PIN Lockout**: Sensitive actions (e.g. stopping containers) require security PIN verification. 3 incorrect attempts trigger an immediate **15-minute lockout**, cancel the pending action, and log a security audit entry.
* **Immutable Audit Trail**: All administrative executions, reminder completions, and restarts are logged to SQLite (`action_audit_log`). Text *"What did you do today?"* to review.
* **Emergency Killswitch**: Texting `"killswitch"` immediately terminates running background tasks.

### 6. 💓 External Dead-Man's Switch & Automated Backups
* **Healthchecks.io Telemetry**: `system_monitor.js` dispatches an automated heartbeat ping every 60 seconds (`HEARTBEAT_URL`). If the host loses power or network, Healthchecks.io alerts Isaac's phone.
* **Automated 04:00 AM SQLite Backups**: Creates timestamped backups into `backups/personal_YYYYMMDD_HHMM.db`, maintains a 14-day rolling retention window, and replicates to AWS S3 if `AWS_S3_BACKUP_BUCKET` is configured.

---

## 📋 Command Reference Cheat Sheet

### 📱 WhatsApp Commands

| Command | Action / Behavior | Execution Tier |
| :--- | :--- | :--- |
| `"What's on tomorrow?"` | Returns single-line schedule summary | Immediate |
| `"Meeting Thursday 3pm to 5pm"` | Schedules event with interval clash check | Immediate |
| `"Cancel lunch"` | Cancels event (asks which one if multiple exist) | Soft Delete |
| `"undo"` | Restores the most recently cancelled event within 24h | Immediate |
| `"export calendar"` | Generates and sends `calendar.ics` for mobile import | Immediate |
| `"Remind me to call John at 5pm"` | Schedules reminder with 15m advance phone call | Immediate |
| `"done"` / `"snooze 20m"` | Acknowledges or snoozes active reminder | Immediate |
| `"Server status"` | Full system telemetry (CPU, RAM, Disk, Tunnels, Ping) | Allowlisted |
| `"Is Immich running?"` | Checks container status and ports | Allowlisted |
| `"Show Jellyfin logs"` | Returns last 3–6 critical error lines (redacted) | Allowlisted |
| `"Restart Jellyfin"` | Prompts for confirmation (`yes/no`, 60s timeout) | 2-Phase Confirmation |
| `"Stop Jellyfin"` | Prompts for security PIN (3-strike lockout, 60s timeout) | PIN Challenge |
| `"What did you do today?"` | Displays today's action audit trail | Immediate |
| `"killswitch"` | Immediately halts background tasks | Immediate |

### 📞 Telephony Commands (Linphone Extension 100)

* **Call `100`**: Live voice conversation with JARVIS.
* **Interrupt / Barge-In**: Speak at any time while JARVIS is talking; playback cuts off in under 50ms.
* **Voice Reminders**: *"Remind me about the team demo at 3:30 PM"* during a call schedules the event into SQLite automatically.
* **Administrative Lockdown**: Asking to restart or stop servers over voice is trapped in code and refused.

---

## ⚙️ Configuration & Environment Variables

Key settings in `.env`:

```bash
# Timezone
TZ=Asia/Kuala_Lumpur

# LLM Engines
OLLAMA_URL=http://localhost:11434
OLLAMA_MODEL=qwen2.5:3b
GEMINI_API_KEY=your_gemini_api_key
GEMINI_MODEL=gemini-3.6-flash

# Security & Whitelist
PRIMARY_PHONE=6017*******
PRIMARY_USER_JID=6017*******@c.us
JARVIS_PIN=1234
SUDO_PASSWORD=your_host_sudo_password

# External Telemetry & Cloud Backups
HEARTBEAT_URL=https://hc-ping.com/your-uuid
AWS_S3_BACKUP_BUCKET=your_s3_bucket_name

# Voice Engine Settings
TTS_ENGINE=piper   # Options: 'piper' (100% offline) or 'edge'
```

---

## 🚀 Service Management

JARVIS runs under systemd:

```bash
# Check service status
systemctl status jarvisai.service    # WhatsApp Engine & Scheduler
systemctl status jarvis-sip.service   # Python Neural Voice Bridge
systemctl status asterisk.service     # PBX VoIP Telephony

# Restart services
sudo systemctl restart jarvisai jarvis-sip

# View live logs
tail -f /jarvis/code/jarvisai/jarvisai.log
tail -f /jarvis/code/jarvisai/jarvis_sip.log
```
