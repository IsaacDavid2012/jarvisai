# JARVIS AI System: Architecture, Operations & Security Engineering Report

> **Host System:** Linux `jarvis` (`100.***.***.21`)  
> **Target Owner / Operator:** Isaac (`+6017***1484` / SIP `101`)  
> **Status:** Production Active (Hardened & Monitored)  
> **Last Updated:** September 22, 2026  

---

## 1. Executive Summary

**JARVIS** is an autonomous, self-hosted personal AI assistant and infrastructure operations engine engineered for high reliability, strict security, and dual-channel interaction. Operating across **WhatsApp** (text/audio notes) and **SIP Telephony** (real-time voice calls via Asterisk over Tailscale), JARVIS combines local intelligence with bare-metal Linux server management, calendar scheduling, proactive alerting, and strict safety guardrails.

Following comprehensive architectural review and testing, the system enforces:
1. **Strict Command Allowlist**: Zero arbitrary shell access. Only predefined read-only diagnostics, verified service status/logs, and confirmed container actions are executable.
2. **Deterministic Voice Lockdown**: Hard-coded in Python before LLM invocation. Administrative commands (restart, stop, delete, docker, bash) are trapped and blocked at the code level, eliminating hallucination risks.
3. **Exact Container Matching & Credential Redaction**: Exact and unambiguous boundary matching for containers; automated regex scrubbing of `password=`, `token=`, `Bearer`, private keys, and connection strings prior to output.
4. **Three-Strike PIN Lockout**: Entering an incorrect PIN 3 times triggers an immediate 15-minute security lockout, aborts the pending action, and logs a security alert.
5. **Soft Delete with 24-Hour Undo**: Calendar deletions mark `deleted_at` rather than dropping rows. Texting `"undo"` restores the event within 24 hours.
6. **Local Piper TTS**: Standalone Piper 1.2.0 binary and British neural model (`en_GB-alan-medium.onnx`) installed locally for 100% offline synthesis.
7. **External Dead-Man's Switch**: Out-of-band heartbeat telemetry (`HEARTBEAT_URL`) ensuring Healthchecks.io alerts your phone if the host or JARVIS goes offline.

---

## 2. System Architecture & Topology

```mermaid
flowchart TD
    subgraph User["User Touchpoints (Isaac)"]
        WA["WhatsApp Client (+6017***1484)"]
        SIP_DEV["Linphone / SIP Handset (Ext 101 @ Tailscale)"]
    end

    subgraph ExternalMonitor["External Supervision"]
        HEARTBEAT["Healthchecks.io Ping Monitor\n(https://hc-ping.com/...)"]
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
            BRIDGE["Python Voice Bridge (sip_bridge.py)"]
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

    MONITOR -->|Heartbeat Ping| HEARTBEAT
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

## 3. Verification & Test Results

All six security tests were executed directly against the live system and passed:

| Test Case | Target Behavior | Observed Result | Status |
| :--- | :--- | :--- | :--- |
| **1. Arbitrary Shell Execution** | Try `!exec ls -la /etc/` and `cat ~/.ssh/id_rsa` | Refused immediately: `🛡️ SECURITY POLICY ENFORCED` | **PASSED** |
| **2. Container Inspection Bypass** | Try `docker inspect immich` | Remapped or blocked: raw `docker inspect` refused | **PASSED** |
| **3. 3-Try PIN Lockout** | Send 5 incorrect PINs in sequence | Attempts 1–2 warn remaining tries; attempt 3 locks out for 15m; attempts 4–5 blocked | **PASSED** |
| **4. Voice Lockdown in Code** | Say *"Can you restart Jellyfin?"* on voice call | Trapped in Python code prior to LLM; refused with security notice | **PASSED** |
| **5. Log Credential Redaction** | Log containing `password=` and `token=` | Automatically redacted to `password=[REDACTED]` and `token=[REDACTED]` | **PASSED** |
| **6. Soft Delete & Undo** | Delete event, then text `"undo"` | Row retained with `deleted_at`; restored successfully within 24 hours | **PASSED** |

---

## 4. Operational Command Reference

### WhatsApp Commands

| Command | Action / Behavior | Execution Tier |
| :--- | :--- | :--- |
| `"What's on tomorrow?"` | Returns single-line schedule summary | Immediate |
| `"Meeting Thursday 3pm to 5pm"` | Schedules event with interval clash check | Immediate |
| `"Cancel lunch"` | Cancels event or prompts disambiguation if multiple | Immediate (Soft Delete) |
| `"undo"` | Restores the most recently cancelled event within 24h | Immediate |
| `"export calendar"` | Generates and sends `calendar.ics` file for mobile import | Immediate |
| `"Server status"` | Full system telemetry (CPU, RAM, Disk, Tunnels, Ping) | Immediate (Allowlisted) |
| `"Is Immich running?"` | Checks specific container state and ports (exact match) | Immediate (Allowlisted) |
| `"Show Jellyfin logs"` | Returns last 3–6 critical error lines (passwords redacted) | Immediate (Allowlisted) |
| `"Restart Jellyfin"` | Prompts for confirmation (`yes/no`, 60s timeout) | 2-Phase Confirmation |
| `"Stop Jellyfin"` | Prompts for security PIN (3-strike lockout, 60s timeout) | PIN Challenge |
| `"What did you do today?"` | Displays today's action audit trail | Immediate |
| `"done"` / `"snooze 20m"` | Acknowledges or snoozes active reminder | Immediate |
| `"killswitch"` | Immediately halts background tasks | Immediate |

### Telephony Commands (Linphone Extension 100)

* **Natural Conversation**: Inquire about schedule, today's tasks, or general queries.
* **Voice Reminders**: *"Remind me to call the accountant at 4:30 PM"* automatically schedules the reminder with 15-minute advance phone notifications.
* **Interrupt at Any Time**: Speak while JARVIS is talking; playback stops in under 50ms.
* **Administrative Lockdown**: Asking to restart servers, reboot, or stop containers is refused in code:
  > *"Sir, administrative commands and server operations are strictly locked down on voice channels. Please execute this request via WhatsApp for security."*
