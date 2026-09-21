#!/usr/bin/env python3
"""
JARVIS Real-Time SIP AudioSocket Voice Bridge
Features:
- Studio-grade British Neural Voice via Edge-TTS (en-GB-RyanNeural / J.A.R.V.I.S. style) with Piper fallback
- Multi-turn rolling conversation memory (remembers context, never repeats)
- Smart Brain: Google Gemini (Google Auth / API Key) + Local Ollama fallback
- Live personal.db Calendar & Task database awareness
- AudioSocket 8kHz/16kHz linear PCM streaming
"""

import socket
import struct
import time
import os
import sys
import subprocess
import json
import urllib.request
import threading
import datetime
import sqlite3
import numpy as np
import asyncio
import re
from faster_whisper import WhisperModel

# Load .env variables
env_file = "/jarvis/code/jarvisai/.env"
if os.path.exists(env_file):
    with open(env_file, "r") as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                os.environ.setdefault(k.strip(), v.strip())

PORT = 9092
PIPER_BIN = "/jarvis/code/jarvisai/voice/bin/piper/piper"
PIPER_MODEL = "/jarvis/code/jarvisai/voice/models/en_GB-alan-medium.onnx"
OLLAMA_URL = os.environ.get("OLLAMA_URL", "http://127.0.0.1:11434/api/generate")
MODEL_NAME = os.environ.get("OLLAMA_MODEL", "qwen2.5:3b")
GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY", "")
GEMINI_MODEL = os.environ.get("GEMINI_MODEL", "gemini-3.6-flash")
GOOGLE_CREDS_PATH = os.environ.get("GOOGLE_APPLICATION_CREDENTIALS", "/jarvis/code/jarvisai/creds.json")

# Voice & VAD Parameters
VOICE_NAME = "en-GB-RyanNeural"  # Refined, soothing British butler voice (Paul Bettany style)
BYTES_PER_CHUNK = 320            # 20ms at 8000Hz 16-bit mono
SILENCE_THRESHOLD = 320.0        # RMS energy threshold for speech vs silence
INTERRUPT_THRESHOLD = 420.0      # RMS energy threshold to trigger voice cut-off (barge-in)
INTERRUPT_CHUNKS_LIMIT = 2       # ~40ms (2 chunks of 20ms) of user voice to halt playback immediately
SILENCE_CHUNKS_LIMIT = 28        # ~560ms of silence to trigger end of user speech
MIN_SPEECH_CHUNKS = 12           # ~240ms minimum speech to avoid stray clicks

SYSTEM_PROMPT = (
    "You are J.A.R.V.I.S., Isaac's sophisticated, loyal British AI butler from Iron Man. "
    "You are speaking live on a telephone voice link with Isaac. "
    "Tone: Calm, cultured, warm British butler with understated dry wit. "
    "Style: Concise, natural, human conversational speech (1 to 2 short sentences maximum). "
    "CRITICAL CONVERSATIONAL RULES: "
    "1. DO NOT repeat greetings, pleasantries, or salutations in every response. Address him as 'Sir' or 'Isaac' naturally and sparingly, never in every single sentence. "
    "2. DO NOT recite or volunteer upcoming calendar events or tasks unless Isaac specifically asks for his schedule or what is coming up. "
    "3. NEVER repeat what you already stated earlier in the call. If Isaac acknowledges or says 'okay' or 'good', reply with a brief, natural conversational reply (e.g., 'Splendid, sir.', 'Very good.', 'Understood.'). "
    "4. When Isaac asks you to perform an action (like adding an event, updating schedule, or sending a WhatsApp note), confirm concisely and smoothly without extra fluff. "
    "5. Absolutely NO markdown, asterisks, hashtags, emojis, or bullet points, as your response is converted directly to audio speech. "
    "6. Server Administrative Safety: Server restarts, shutdowns, and container modifications are strictly prohibited over telephone calls. If Isaac requests server restarts or modifications over voice, politely reply: 'Sir, server administrative actions cannot be executed over voice. Please confirm via WhatsApp for security.'"
)

GREETING_TEXT = "At your service, sir. JARVIS voice link operational. How may I be of assistance today?"

print("⏳ Initializing faster-whisper base.en model on CPU...")
whisper_model = WhisperModel("base.en", device="cpu", compute_type="int8")
print("✅ faster-whisper base.en ready!")

INITIAL_WHISPER_PROMPT = "Isaac, JARVIS, Singapore, October, August, September, calendar, schedule, mission, trip, Maths, test, event"

# Google Auth Setup for Vertex AI (if creds.json exists)
google_creds = None
google_project_id = None
if os.path.exists(GOOGLE_CREDS_PATH):
    try:
        import google.auth
        from google.oauth2 import service_account
        from google.auth.transport.requests import Request as GoogleRequest
        google_creds = service_account.Credentials.from_service_account_file(
            GOOGLE_CREDS_PATH,
            scopes=["https://www.googleapis.com/auth/cloud-platform"]
        )
        with open(GOOGLE_CREDS_PATH, "r") as f:
            creds_data = json.load(f)
            google_project_id = creds_data.get("project_id")
        print(f"✅ Google Cloud Authentication loaded for project: {google_project_id}")
    except Exception as gErr:
        print(f"⚠️ Google Auth load error: {gErr}", file=sys.stderr)

def get_daily_context():
    """Retrieves upcoming calendar events and tasks from personal.db for live phone calls."""
    try:
        conn = sqlite3.connect("/jarvis/code/jarvisai/personal.db")
        c = conn.cursor()
        today = datetime.datetime.now().strftime("%Y-%m-%d")
        c.execute("SELECT title, event_date, start_time, end_time FROM events WHERE event_date >= ? ORDER BY event_date ASC, start_time ASC LIMIT 6", (today,))
        events = c.fetchall()
        c.execute("SELECT text FROM tasks WHERE completed = 0 LIMIT 5")
        tasks = [t[0] for t in c.fetchall()]
        conn.close()

        ctx = []
        if events:
            ev_list = []
            for e in events:
                date_str = f"{e[1]} to {e[3]}" if e[3] and "-" in str(e[3]) else e[1]
                time_str = f" at {e[2]}" if e[2] else ""
                ev_list.append(f"{e[0]} ({date_str}{time_str})")
            ctx.append(f"Upcoming Schedule: {', '.join(ev_list)}.")
        if tasks:
            ctx.append(f"Pending tasks: {', '.join(tasks)}.")

        context_body = " ".join(ctx) if ctx else "No upcoming events or pending tasks."
        return f"[BACKGROUND REFERENCE ONLY - NEVER volunteer or recite this unless Isaac explicitly asks for his schedule or what is coming up]: {context_body}"
    except Exception:
        return ""

def synthesize_edge_tts_pcm8k(text):
    """Generates studio-grade British neural speech via Edge-TTS, converted to 8kHz 16-bit PCM."""
    import edge_tts
    async def _gen():
        comm = edge_tts.Communicate(text, VOICE_NAME, rate="+0%", pitch="+0Hz")
        p = subprocess.Popen(
            ["ffmpeg", "-i", "pipe:0", "-ar", "8000", "-ac", "1", "-f", "s16le", "pipe:1"],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL
        )
        mp3_chunks = []
        async for chunk in comm.stream():
            if chunk["type"] == "audio":
                mp3_chunks.append(chunk["data"])
        raw_pcm, _ = p.communicate(input=b"".join(mp3_chunks))
        return raw_pcm

    try:
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        pcm = loop.run_until_complete(_gen())
        loop.close()
        if pcm and len(pcm) > 0:
            return pcm
    except Exception as e:
        print(f"⚠️ Edge-TTS error, falling back to Piper: {e}", file=sys.stderr)

    # Fallback to local Piper TTS
    return fallback_piper_pcm8k(text)

def fallback_piper_pcm8k(text):
    """Fallback local offline Piper TTS conversion."""
    if not text or not text.strip():
        return b""
    try:
        p1 = subprocess.Popen(
            [PIPER_BIN, "--model", PIPER_MODEL, "--output-raw"],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL
        )
        p2 = subprocess.Popen(
            ["ffmpeg", "-f", "s16le", "-ar", "22050", "-ac", "1", "-i", "pipe:0",
             "-ar", "8000", "-f", "s16le", "pipe:1"],
            stdin=p1.stdout, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL
        )
        p1.stdin.write(text.strip().encode("utf-8"))
        p1.stdin.close()
        raw_pcm = p2.stdout.read()
        p1.wait()
        p2.wait()
        return raw_pcm
    except Exception as e:
        print(f"⚠️ Piper TTS error: {e}", file=sys.stderr)
        return b""

TTS_ENGINE = os.getenv("TTS_ENGINE", "edge").lower()

def tts_to_pcm8k(text):
    """Public TTS wrapper selecting configured engine with fallback."""
    if TTS_ENGINE == "piper":
        pcm = fallback_piper_pcm8k(text)
        if pcm and len(pcm) > 0:
            return pcm
        print("⚠️ Piper output empty, falling back to Edge-TTS")
    return synthesize_edge_tts_pcm8k(text)

print("⏳ Pre-rendering soothing greeting audio into RAM...")
PRE_RENDERED_GREETING = tts_to_pcm8k(GREETING_TEXT)
print(f"✅ Greeting pre-rendered ({len(PRE_RENDERED_GREETING)} bytes)!")

def query_gemini_vertex(prompt_text, conversation_history):
    """Queries Google Gemini on Vertex AI using Google Service Account OAuth2 token."""
    global google_creds, google_project_id
    from google.auth.transport.requests import Request as GoogleRequest
    google_creds.refresh(GoogleRequest())
    token = google_creds.token

    location = "us-central1"
    url = f"https://{location}-aiplatform.googleapis.com/v1/projects/{google_project_id}/locations/{location}/publishers/google/models/gemini-1.5-flash:generateContent"

    contents = []
    for h in conversation_history[-6:]:
        contents.append({
            "role": "user" if h["role"] == "user" else "model",
            "parts": [{"text": h["content"]}]
        })
    contents.append({
        "role": "user",
        "parts": [{"text": prompt_text}]
    })

    payload = {
        "systemInstruction": {
            "parts": [{"text": f"{SYSTEM_PROMPT}\nReal-time Database Context: {get_daily_context()}"}]
        },
        "contents": contents,
        "generationConfig": {
            "temperature": 0.5,
            "maxOutputTokens": 100
        }
    }

    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {token}"
        }
    )
    with urllib.request.urlopen(req, timeout=10) as resp:
        res = json.loads(resp.read().decode("utf-8"))
        return res["candidates"][0]["content"]["parts"][0]["text"].strip()

def is_token_saver_enabled():
    """Checks personal.db for dynamic Token Saver Mode setting."""
    try:
        conn = sqlite3.connect("/jarvis/code/jarvisai/personal.db")
        c = conn.cursor()
        c.execute("SELECT value FROM system_settings WHERE key = 'token_saver_mode'")
        row = c.fetchone()
        conn.close()
        if row and row[0] == "disabled":
            return False
        return True
    except Exception:
        return True

def record_token_stats(source, model, prompt_tokens, completion_tokens, total_tokens, saved_tokens):
    """Logs token usage and estimated token savings to personal.db."""
    try:
        conn = sqlite3.connect("/jarvis/code/jarvisai/personal.db")
        c = conn.cursor()
        today = datetime.datetime.now().strftime("%Y-%m-%d")
        c.execute("""
            INSERT INTO token_stats (date, source, model, prompt_tokens, completion_tokens, total_tokens, saved_tokens)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        """, (today, source, model, prompt_tokens, completion_tokens, total_tokens, saved_tokens))
        conn.commit()
        conn.close()
    except Exception:
        pass

def query_gemini_api(prompt_text, conversation_history):
    """Queries Google Gemini API with API key in Token Saver mode."""
    saver = is_token_saver_enabled()
    turns_to_keep = 4 if saver else 8
    max_tokens = 100 if saver else 250

    url = f"https://generativelanguage.googleapis.com/v1beta/models/{GEMINI_MODEL}:generateContent?key={GEMINI_API_KEY}"
    contents = []
    for h in conversation_history[-turns_to_keep:]:
        contents.append({
            "role": "user" if h["role"] == "user" else "model",
            "parts": [{"text": h["content"]}]
        })
    contents.append({
        "role": "user",
        "parts": [{"text": prompt_text}]
    })

    gen_config = {
        "temperature": 0.5,
        "maxOutputTokens": max_tokens
    }
    if saver:
        # Zero thought tokens = ~85% token reduction & instant response (<0.4s)
        gen_config["thinkingConfig"] = {"thinkingBudget": 0}

    payload = {
        "systemInstruction": {
            "parts": [{"text": f"{SYSTEM_PROMPT}\nReal-time Database Context: {get_daily_context()}"}]
        },
        "contents": contents,
        "generationConfig": gen_config
    }
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"}
    )
    with urllib.request.urlopen(req, timeout=10) as resp:
        res = json.loads(resp.read().decode("utf-8"))

        # Record usage
        usage = res.get("usageMetadata", {})
        prompt_tokens = usage.get("promptTokenCount", 0)
        completion_tokens = usage.get("candidatesTokenCount", 0)
        total_tokens = usage.get("totalTokenCount", 0)
        saved_tokens = 600 if saver else 0
        record_token_stats("voice_call", GEMINI_MODEL, prompt_tokens, completion_tokens, total_tokens, saved_tokens)

        return res["candidates"][0]["content"]["parts"][0]["text"].strip()

def query_ollama(prompt_text, conversation_history):
    """Queries local Ollama qwen2.5:3b with rolling multi-turn memory."""
    context_str = get_daily_context()

    # Build conversation thread
    history_str = ""
    for h in conversation_history[-6:]:
        role = "Isaac" if h["role"] == "user" else "JARVIS"
        history_str += f"{role}: {h['content']}\n"

    full_prompt = (
        f"{SYSTEM_PROMPT}\n"
        f"Real-time Context: {context_str}\n\n"
        f"Conversation History:\n{history_str}"
        f"Isaac: {prompt_text}\n"
        f"JARVIS:"
    )

    payload = {
        "model": MODEL_NAME,
        "prompt": full_prompt,
        "stream": False,
        "keep_alive": "24h",
        "options": {
            "temperature": 0.5,
            "top_p": 0.9,
            "num_predict": 120
        }
    }
    req = urllib.request.Request(
        OLLAMA_URL,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"}
    )
    with urllib.request.urlopen(req, timeout=15) as resp:
        data = json.loads(resp.read().decode("utf-8"))
        return data.get("response", "").strip()

def query_brain(user_text, conversation_history):
    """Routes query to Gemini (Google Auth / API) or local Ollama with multi-turn memory."""
    reply = None
    # 1. Try Google Cloud Vertex AI (Google Auth Service Account)
    if google_creds and google_project_id:
        try:
            reply = query_gemini_vertex(user_text, conversation_history)
            if reply:
                return clean_reply(reply)
        except Exception as e:
            print(f"⚠️ Gemini Vertex AI query error: {e}", file=sys.stderr)

    # 2. Try Gemini API key
    if GEMINI_API_KEY:
        try:
            reply = query_gemini_api(user_text, conversation_history)
            if reply:
                return clean_reply(reply)
        except Exception as e:
            print(f"⚠️ Gemini API query error: {e}", file=sys.stderr)

    # 3. Fallback to local Ollama (warm in memory)
    try:
        reply = query_ollama(user_text, conversation_history)
        if reply:
            return clean_reply(reply)
    except Exception as e:
        print(f"⚠️ Ollama query error: {e}", file=sys.stderr)

    return "At your service, sir. How may I assist you?"

def clean_reply(text):
    """Sanitizes AI text for phone call speech."""
    cleaned = text.replace("*", "").replace("#", "").replace("_", "").replace("~", "").replace("`", "")
    # Remove any leading "JARVIS:" or "Sir:" repetitions
    if cleaned.lower().startswith("jarvis:"):
        cleaned = cleaned[7:].strip()
    return cleaned.strip()

def drain_socket(conn):
    """Flushes any buffered audio packets from the socket (e.g. during LLM/TTS generation)."""
    conn.setblocking(False)
    try:
        while True:
            data = conn.recv(4096)
            if not data:
                break
    except (BlockingIOError, socket.error):
        pass
    finally:
        conn.setblocking(True)
        conn.settimeout(90.0)

def stream_audio_with_barge_in(conn, raw_pcm, stop_evt, playing_evt):
    """Streams 8kHz PCM to Asterisk in 20ms chunks, stopping immediately if stop_evt is set."""
    chunk_size = 320  # 20ms at 8000Hz 16-bit mono
    try:
        for i in range(0, len(raw_pcm), chunk_size):
            if stop_evt.is_set():
                print("⏹️ [BARGE-IN] Outgoing playback cut off immediately.")
                break
            chunk = raw_pcm[i:i + chunk_size]
            if len(chunk) < chunk_size:
                chunk = chunk.ljust(chunk_size, b"\x00")
            header = b"\x10" + struct.pack(">H", len(chunk))
            conn.sendall(header + chunk)
            time.sleep(0.019)
    except Exception as e:
        print(f"⚠️ Audio streaming error: {e}", file=sys.stderr)
    finally:
        playing_evt.clear()

def send_audio_chunks(conn, raw_pcm):
    """Fallback legacy synchronous audio streaming."""
    chunk_size = 320
    for i in range(0, len(raw_pcm), chunk_size):
        chunk = raw_pcm[i:i + chunk_size]
        if len(chunk) < chunk_size:
            chunk = chunk.ljust(chunk_size, b"\x00")
        header = b"\x10" + struct.pack(">H", len(chunk))
        try:
            conn.sendall(header + chunk)
            time.sleep(0.019)
        except Exception:
            break

def dispatch_whatsapp_note(text):
    """Queues a WhatsApp message into reminders table for immediate delivery by main.js."""
    try:
        conn = sqlite3.connect("/jarvis/code/jarvisai/personal.db")
        c = conn.cursor()
        now_str = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:00")
        c.execute("INSERT INTO reminders (text, remind_at, completed) VALUES (?, ?, 0)", (text, now_str))
        conn.commit()
        conn.close()
        print(f"📱 Dispatched WhatsApp note to Isaac: \"{text[:50]}...\"")
    except Exception as e:
        print(f"⚠️ Failed to queue WhatsApp message: {e}", file=sys.stderr)

def is_administrative_voice_command(text):
    """Hard code-level enforcement: Detects administrative/server commands to block on voice calls."""
    if not text:
        return False
    lower = text.lower()
    patterns = [
        r"\brestart\b", r"\breboot\b", r"\bshutdown\b", r"\bpoweroff\b",
        r"\bdocker\s+(stop|rm|restart|kill|prune|exec|run)\b",
        r"\bstop\s+(the\s+)?(container|server|service|docker|jellyfin|immich|coolify|vaultwarden)\b",
        r"\bkill\s+(the\s+)?(container|server|service|docker|process)\b",
        r"\bdelete\s+(the\s+)?(server|database|container|volume)\b",
        r"\bsystemctl\b", r"\bsudo\b", r"\bbash\b", r"\bshell\b", r"\bexec\b"
    ]
    return any(re.search(p, lower) for p in patterns)

def execute_voice_actions(user_text, ai_reply, conversation_history):
    """Executes real-time database modifications or WhatsApp dispatches triggered by voice commands during phone calls."""
    try:
        if is_administrative_voice_command(user_text):
            print(f"🛡️ [HARD ENFORCEMENT] Dropped voice action due to administrative lockdown: \"{user_text}\"")
            return

        lower = user_text.lower()
        action_keywords = ["event", "schedule", "calendar", "trip", "task", "whatsapp", "text", "remind", "reschedule", "add", "change", "cancel", "delete", "october", "singapore"]
        if not any(k in lower for k in action_keywords):
            return

        now = datetime.datetime.now()
        prompt = (
            f"Current Date: {now.strftime('%Y-%m-%d')} (Year {now.year})\n"
            f"User spoken input: '{user_text}'\n"
            f"AI spoken reply: '{ai_reply}'\n"
            f"Recent conversation turns: {json.dumps(conversation_history[-4:])}\n\n"
            f"Analyze if the user intended to add an event, update an event, add a task, set a reminder, or requested a WhatsApp update/recap.\n"
            f"Respond ONLY with a JSON object in this schema:\n"
            f"{{\n"
            f"  \"action\": \"add_event\" | \"update_event\" | \"add_task\" | \"add_reminder\" | \"send_whatsapp\" | \"none\",\n"
            f"  \"title\": \"title of event, task, or reminder topic\",\n"
            f"  \"date\": \"YYYY-MM-DD or null\",\n"
            f"  \"end_date\": \"YYYY-MM-DD or null\",\n"
            f"  \"time\": \"HH:MM or null\",\n"
            f"  \"whatsapp_summary\": \"Clean 1-sentence recap for WhatsApp message\"\n"
            f"}}"
        )
        url = f"https://generativelanguage.googleapis.com/v1beta/models/{GEMINI_MODEL}:generateContent?key={GEMINI_API_KEY}"
        payload = {
            "contents": [{"role": "user", "parts": [{"text": prompt}]}],
            "generationConfig": {"temperature": 0.1, "maxOutputTokens": 180, "thinkingConfig": {"thinkingBudget": 0}}
        }
        req = urllib.request.Request(url, data=json.dumps(payload).encode("utf-8"), headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=5) as resp:
            res = json.loads(resp.read().decode("utf-8"))
            txt = res["candidates"][0]["content"]["parts"][0]["text"].strip()
            txt = txt.replace("```json", "").replace("```", "").strip()
            data = json.loads(txt)

        action = data.get("action")
        title = data.get("title")
        date = data.get("date")
        end_date = data.get("end_date")
        time_str = data.get("time")
        summary = data.get("whatsapp_summary")

        conn = sqlite3.connect("/jarvis/code/jarvisai/personal.db")
        c = conn.cursor()

        if action == "add_event" and title and date:
            desc = f"{title} added via voice call"
            c.execute("INSERT INTO events (title, event_date, end_time, start_time, description, reminder_sent, reminder_day_sent, reminder_2h_sent) VALUES (?, ?, ?, ?, ?, 0, 0, 0)",
                      (title, date, end_date, time_str, desc))
            conn.commit()
            print(f"✅ Calendar event added from call: {title} on {date}")
            date_display = f"{date} to {end_date}" if end_date else date
            dispatch_whatsapp_note(f"📅 *EVENT SCHEDULED (VIA CALL)*\n───────────────\n📌 *{title}*\n🗓️ Date: `{date_display}`{f'\n🕒 Time: `{time_str}`' if time_str else ''}\n\n_Confirmed and recorded in your calendar, Sir._")

        elif action == "update_event" and title:
            if date:
                c.execute("UPDATE events SET event_date = ?, end_time = COALESCE(?, end_time), reminder_sent = 0, reminder_day_sent = 0, reminder_2h_sent = 0 WHERE title LIKE ?",
                          (date, end_date, f"%{title}%"))
                if c.rowcount > 0:
                    conn.commit()
                    print(f"✅ Calendar event updated from call: {title} to {date}")
                    date_display = f"{date} to {end_date}" if end_date else date
                    dispatch_whatsapp_note(f"📅 *CALENDAR UPDATED (VIA CALL)*\n───────────────\n📌 *{title}*\n🗓️ New Date: `{date_display}`\n\n_Updated per our voice call, Sir._")

        elif action == "add_task" and title:
            c.execute("INSERT INTO tasks (text, completed) VALUES (?, 0)", (title,))
            conn.commit()
            print(f"✅ Task created from call: {title}")
            dispatch_whatsapp_note(f"📋 *TASK ADDED (VIA CALL)*\n───────────────\n📌 *{title}*\n\n_Recorded in tasks list, Sir._")

        elif action == "add_reminder" and title:
            remind_date = date if date else now.strftime("%Y-%m-%d")
            remind_time = time_str if time_str else (now + datetime.timedelta(hours=1)).strftime("%H:%M")
            remind_at_str = f"{remind_date} {remind_time}:00"
            c.execute("INSERT INTO reminders (text, remind_at, call_15m_sent, completed) VALUES (?, ?, 0, 0)", (title, remind_at_str))
            conn.commit()
            print(f"✅ Reminder scheduled from call: {title} at {remind_at_str}")
            dispatch_whatsapp_note(f"⏰ *REMINDER SCHEDULED (VIA CALL)*\n───────────────\n🔔 *{title}*\n🗓️ Scheduled For: `{remind_at_str}`\n\n_I will ring your extension 15 minutes prior to remind you, Sir._")

        elif action == "send_whatsapp" or any(w in lower for w in ["send me a whatsapp", "whatsapp me", "send whatsapp", "send to my whatsapp"]):
            recap_content = summary if summary else ai_reply
            dispatch_whatsapp_note(f"📞 *JARVIS CALL RECAP*\n───────────────\nSir, as discussed on our voice call:\n\n• {recap_content}")

        conn.close()
    except Exception as err:
        print(f"⚠️ Voice action error: {err}", file=sys.stderr)

def handle_call(conn, addr):
    print(f"📞 New call connected from Asterisk ({addr})")
    conn.settimeout(90.0)
    conversation_history = []

    stop_playback = threading.Event()
    is_playing = threading.Event()

    try:
        # Read initial packet (UUID from Asterisk: Type 0x01)
        header = conn.recv(3)
        if len(header) < 3:
            return
        pkt_type, pkt_len = header[0], struct.unpack(">H", header[1:3])[0]
        payload = conn.recv(pkt_len) if pkt_len > 0 else b""
        uuid_str = payload.hex()
        print(f"🔗 AudioSocket session UUID: {uuid_str} (Type: {pkt_type:#x})")

        # Check if an outbound automated event notification message is pending
        outbound_file = "/tmp/jarvis_outbound_msg.txt"
        greeting_text = GREETING_TEXT
        greeting_audio = PRE_RENDERED_GREETING

        if os.path.exists(outbound_file):
            try:
                mtime = os.path.getmtime(outbound_file)
                if time.time() - mtime < 120:
                    with open(outbound_file, "r") as f:
                        custom_msg = f.read().strip()
                    if custom_msg:
                        greeting_text = custom_msg
                        print(f"📣 Outbound event alert detected: \"{greeting_text}\"")
                        greeting_audio = tts_to_pcm8k(greeting_text)
                os.remove(outbound_file)
            except Exception as ex:
                print(f"⚠️ Outbound file error: {ex}", file=sys.stderr)

        # Start initial greeting or outbound alert playback in background with instant Barge-In!
        print(f"🗣️ Speaking initial audio: \"{greeting_text}\"")
        conversation_history.append({"role": "assistant", "content": greeting_text})
        stop_playback.clear()
        is_playing.set()
        threading.Thread(
            target=stream_audio_with_barge_in,
            args=(conn, greeting_audio, stop_playback, is_playing),
            daemon=True
        ).start()

        audio_buffer = bytearray()
        speaking = False
        silence_count = 0
        speech_chunks = 0
        barge_in_chunks = 0

        while True:
            hdr = conn.recv(3)
            if not hdr or len(hdr) < 3:
                break

            p_type, p_len = hdr[0], struct.unpack(">H", hdr[1:3])[0]
            if p_type == 0x00:  # AST_AUDIOSOCKET_KIND_HANGUP
                print("📴 Call hangup received from Asterisk.")
                stop_playback.set()
                is_playing.clear()
                break

            payload = bytearray()
            while len(payload) < p_len:
                chunk = conn.recv(p_len - len(payload))
                if not chunk:
                    break
                payload.extend(chunk)

            # 0x10 = AST_AUDIOSOCKET_KIND_AUDIO (SLIN 8kHz), 0x12 = SLIN16
            if p_type not in (0x10, 0x12) or len(payload) == 0:
                continue

            # Process incoming audio via VAD
            samples = np.frombuffer(payload, dtype=np.int16)
            rms = np.sqrt(np.mean(samples.astype(np.float32) ** 2)) if len(samples) > 0 else 0.0

            # ─────────────────────────────────────────────────────────────
            # CASE 1: JARVIS IS ACTIVELY SPEAKING (BARGE-IN CUT-OFF DETECTION)
            # ─────────────────────────────────────────────────────────────
            if is_playing.is_set():
                if rms > INTERRUPT_THRESHOLD:
                    barge_in_chunks += 1
                    if barge_in_chunks >= INTERRUPT_CHUNKS_LIMIT:
                        print(f"🛑 [BARGE-IN TRIGGERED] Speech detected (RMS={rms:.1f} > {INTERRUPT_THRESHOLD}). Halting playback!")
                        stop_playback.set()
                        is_playing.clear()
                        # Immediately capture user voice without losing initial syllables
                        speaking = True
                        silence_count = 0
                        speech_chunks = barge_in_chunks
                        audio_buffer = bytearray()
                        audio_buffer.extend(payload)
                        barge_in_chunks = 0
                else:
                    barge_in_chunks = 0
                continue

            # ─────────────────────────────────────────────────────────────
            # CASE 2: JARVIS IS LISTENING (STANDARD VAD RECORDING)
            # ─────────────────────────────────────────────────────────────
            if rms > SILENCE_THRESHOLD:
                speaking = True
                silence_count = 0
                speech_chunks += 1
                audio_buffer.extend(payload)
            elif speaking:
                silence_count += 1
                audio_buffer.extend(payload)

                if silence_count >= SILENCE_CHUNKS_LIMIT:
                    # End of user speech detected!
                    if speech_chunks >= MIN_SPEECH_CHUNKS:
                        print(f"🎙️ User finished speaking ({len(audio_buffer)} bytes, {speech_chunks * 20}ms)")
                        # Resample 8kHz to 16kHz for Whisper
                        pcm_8k = np.frombuffer(audio_buffer, dtype=np.int16).astype(np.float32) / 32768.0
                        pcm_16k = np.repeat(pcm_8k, 2)

                        t0 = time.time()
                        segments, _ = whisper_model.transcribe(pcm_16k, beam_size=1, initial_prompt=INITIAL_WHISPER_PROMPT)
                        user_text = "".join([s.text for s in segments]).strip()
                        print(f"📝 Transcribed ({time.time() - t0:.2f}s): \"{user_text}\"")

                        noise_phrases = ["", "thank you.", "bye.", "you", "thanks for watching.", "so"]
                        if user_text and user_text.lower() not in noise_phrases and len(user_text) > 2:
                            # Add user input to conversation history
                            conversation_history.append({"role": "user", "content": user_text})

                            # Hard code-level enforcement: Block administrative operations on voice calls
                            if is_administrative_voice_command(user_text):
                                print(f"🛡️ [HARD ENFORCEMENT] Refusing administrative command on voice: \"{user_text}\"")
                                ai_reply = "Sir, administrative commands and server operations are strictly locked down on voice channels. Please execute this request via WhatsApp for security."
                                conversation_history.append({"role": "assistant", "content": ai_reply})
                            else:
                                # Query Brain with memory
                                t_brain = time.time()
                                ai_reply = query_brain(user_text, conversation_history)
                                conversation_history.append({"role": "assistant", "content": ai_reply})
                                print(f"🤖 JARVIS ({time.time() - t_brain:.2f}s): \"{ai_reply}\"")

                                # Execute voice-triggered actions concurrently (strictly calendar/reminders)
                                threading.Thread(target=execute_voice_actions, args=(user_text, ai_reply, list(conversation_history)), daemon=True).start()

                            # Synthesize speech
                            t_tts = time.time()
                            reply_pcm = tts_to_pcm8k(ai_reply)
                            print(f"🔊 Generated Neural Speech ({time.time() - t_tts:.2f}s, {len(reply_pcm)} bytes), streaming to call...")

                            # Drain any stale packets buffered in TCP socket during LLM/TTS generation
                            drain_socket(conn)

                            # Start streaming with instant Barge-In detection enabled
                            stop_playback.clear()
                            is_playing.set()
                            threading.Thread(
                                target=stream_audio_with_barge_in,
                                args=(conn, reply_pcm, stop_playback, is_playing),
                                daemon=True
                            ).start()

                    # Reset VAD for next turn
                    audio_buffer = bytearray()
                    speaking = False
                    silence_count = 0
                    speech_chunks = 0
                    barge_in_chunks = 0

    except Exception as err:
        print(f"⚠️ Call error: {err}", file=sys.stderr)
    finally:
        stop_playback.set()
        is_playing.clear()
        conn.close()
        print("📞 Call session ended.")

def start_server():
    server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    server.bind(("127.0.0.1", PORT))
    server.listen(5)
    print(f"🚀 JARVIS Voice Bridge (Neural + Multi-turn Memory) listening on 127.0.0.1:{PORT}...")

    while True:
        try:
            conn, addr = server.accept()
            client_thread = threading.Thread(target=handle_call, args=(conn, addr), daemon=True)
            client_thread.start()
        except KeyboardInterrupt:
            break
        except Exception as e:
            print(f"Server loop error: {e}", file=sys.stderr)

if __name__ == "__main__":
    start_server()
