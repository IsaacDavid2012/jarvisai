const sqlite3 = require("sqlite3").verbose();
const path = require("path");
require("dotenv").config();

process.env.TZ = process.env.TZ || "Asia/Kuala_Lumpur";

const DB_PATH = path.join(__dirname, "personal.db");
const db = new sqlite3.Database(DB_PATH);

// Helper for local Asia/Kuala_Lumpur (+08:00) Date object
function getKLDate() {
  const now = new Date();
  return new Date(now.toLocaleString("en-US", { timeZone: "Asia/Kuala_Lumpur" }));
}

function getKLDateStr(dateObj) {
  const kl = dateObj || getKLDate();
  const year = kl.getFullYear();
  const month = String(kl.getMonth() + 1).padStart(2, "0");
  const day = String(kl.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function getKLTimeStr(dateObj) {
  const kl = dateObj || getKLDate();
  const hours = String(kl.getHours()).padStart(2, "0");
  const minutes = String(kl.getMinutes()).padStart(2, "0");
  return `${hours}:${minutes}`;
}

function getKLDateTimeStr(dateObj) {
  return `${getKLDateStr(dateObj)} ${getKLTimeStr(dateObj)}:00`;
}

// Database Promise wrappers
function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) return reject(err);
      resolve({ id: this.lastID, changes: this.changes });
    });
  });
}

function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) return reject(err);
      resolve(row);
    });
  });
}

function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) return reject(err);
      resolve(rows || []);
    });
  });
}

// Initialize database schema
db.serialize(() => {
  // 1. Calendar Events Table
  db.run(`
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      event_date TEXT NOT NULL,
      start_time TEXT,
      end_time TEXT,
      description TEXT,
      reminder_sent INTEGER DEFAULT 0,
      reminder_day_sent INTEGER DEFAULT 0,
      reminder_2h_sent INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Ensure reminder columns exist on existing events table
  db.run("ALTER TABLE events ADD COLUMN reminder_day_sent INTEGER DEFAULT 0", () => {});
  db.run("ALTER TABLE events ADD COLUMN reminder_2h_sent INTEGER DEFAULT 0", () => {});
  db.run("ALTER TABLE events ADD COLUMN reminder_sent INTEGER DEFAULT 0", () => {});
  db.run("ALTER TABLE events ADD COLUMN deleted_at DATETIME", () => {});

  // 2. Tasks Table
  db.run(`
    CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      text TEXT NOT NULL,
      completed INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // 3. Notes Table
  db.run(`
    CREATE TABLE IF NOT EXISTS notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT,
      content TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // 4. Reminders Table
  db.run(`
    CREATE TABLE IF NOT EXISTS reminders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      text TEXT NOT NULL,
      remind_at TEXT NOT NULL,
      recurring TEXT,
      completed INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run("ALTER TABLE reminders ADD COLUMN recurring TEXT", () => {});
  db.run("ALTER TABLE reminders ADD COLUMN repeat_count INTEGER DEFAULT 0", () => {});

  // 5. Memories Table (for persistent preference learning)
  db.run(`
    CREATE TABLE IF NOT EXISTS memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      fact TEXT NOT NULL,
      category TEXT DEFAULT 'general',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // 6. Token Stats Table (Data-Saving Mode monitoring)
  db.run(`
    CREATE TABLE IF NOT EXISTS token_stats (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL,
      source TEXT NOT NULL,
      model TEXT NOT NULL,
      prompt_tokens INTEGER DEFAULT 0,
      completion_tokens INTEGER DEFAULT 0,
      total_tokens INTEGER DEFAULT 0,
      saved_tokens INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // 7. System Settings Table (Dynamic configuration toggles)
  db.run(`
    CREATE TABLE IF NOT EXISTS system_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Default Token Saver Mode active
  db.run(`
    INSERT OR IGNORE INTO system_settings (key, value)
    VALUES ('token_saver_mode', 'enabled')
  `);

  // 8. Action Audit Log Table
  db.run(`
    CREATE TABLE IF NOT EXISTS action_audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      action TEXT NOT NULL,
      detail TEXT NOT NULL,
      status TEXT DEFAULT 'SUCCESS',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
});

// ==========================================
// 1. CALENDAR EVENTS
// ==========================================

async function addEvent({ title, event_date, start_time = null, end_time = null, description = "" }) {
  const sql = `
    INSERT INTO events (title, event_date, start_time, end_time, description, reminder_sent, reminder_day_sent, reminder_2h_sent)
    VALUES (?, ?, ?, ?, ?, 0, 0, 0)
  `;
  const result = await run(sql, [title, event_date, start_time, end_time, description]);
  return { id: result.id, title, event_date, start_time, end_time, description };
}

async function getUpcomingEvents(days = 60) {
  const today = getKLDateStr();
  const endDate = new Date(getKLDate().getTime() + days * 24 * 60 * 60 * 1000);
  const endStr = getKLDateStr(endDate);

  const sql = `
    SELECT * FROM events
    WHERE event_date >= ? AND event_date <= ? AND (deleted_at IS NULL)
    ORDER BY event_date ASC, CASE WHEN start_time IS NULL THEN '00:00' ELSE start_time END ASC
    LIMIT 25
  `;
  return all(sql, [today, endStr]);
}

async function getAllUpcomingEvents() {
  const today = getKLDateStr();
  const sql = `
    SELECT * FROM events
    WHERE event_date >= ? AND (deleted_at IS NULL)
    ORDER BY event_date ASC, CASE WHEN start_time IS NULL THEN '00:00' ELSE start_time END ASC
    LIMIT 30
  `;
  return all(sql, [today]);
}

async function getEventsForDate(dateStr) {
  const sql = `
    SELECT * FROM events
    WHERE event_date = ? AND (deleted_at IS NULL)
    ORDER BY CASE WHEN start_time IS NULL THEN '00:00' ELSE start_time END ASC
  `;
  return all(sql, [dateStr]);
}

async function getEventById(id) {
  return get("SELECT * FROM events WHERE id = ? AND (deleted_at IS NULL)", [id]);
}

/**
 * Soft deletes an event by setting deleted_at timestamp (supports 24h undo).
 */
async function deleteEvent(id) {
  return run("UPDATE events SET deleted_at = datetime('now', '+8 hours') WHERE id = ?", [id]);
}

/**
 * Restores the most recently deleted event within the last 24 hours.
 */
async function undoLastEventDelete() {
  const sql = `
    SELECT * FROM events
    WHERE deleted_at IS NOT NULL
      AND deleted_at >= datetime('now', '+8 hours', '-24 hours')
    ORDER BY deleted_at DESC
    LIMIT 1
  `;
  const event = await get(sql);
  if (!event) return null;

  await run("UPDATE events SET deleted_at = NULL WHERE id = ?", [event.id]);
  return event;
}

function timeToMins(t) {
  if (!t || typeof t !== "string" || !t.includes(":")) return null;
  const [h, m] = t.split(":").map(Number);
  if (isNaN(h) || isNaN(m)) return null;
  return h * 60 + m;
}

/**
 * Checks for interval overlaps with existing events.
 * Overlap formula: (startA < endB && endA > startB)
 */
async function checkEventConflict(eventDate, startTime, endTime = null) {
  if (!startTime) return [];
  const startMins = timeToMins(startTime);
  if (startMins === null) return [];
  let endMins = (endTime && timeToMins(endTime) !== null) ? timeToMins(endTime) : startMins + 60;
  if (endMins <= startMins) endMins += 24 * 60; // Handle midnight wrap

  const existing = await all(
    "SELECT * FROM events WHERE event_date = ? AND start_time IS NOT NULL AND (deleted_at IS NULL)",
    [eventDate]
  );

  return existing.filter((e) => {
    const eStart = timeToMins(e.start_time);
    if (eStart === null) return false;
    let eEnd = (e.end_time && timeToMins(e.end_time) !== null) ? timeToMins(e.end_time) : (eStart + 60);
    if (eEnd <= eStart) eEnd += 24 * 60;

    return startMins < eEnd && endMins > eStart;
  });
}

async function rescheduleEvent(identifier, newDate, newTime = null) {
  let event = null;
  if (/^\d+$/.test(String(identifier).trim())) {
    event = await getEventById(parseInt(identifier, 10));
  } else {
    event = await get("SELECT * FROM events WHERE title LIKE ? ORDER BY id DESC LIMIT 1", [`%${identifier}%`]);
  }

  if (!event) return null;

  const sql = `
    UPDATE events
    SET event_date = ?,
        start_time = COALESCE(?, start_time),
        reminder_sent = 0,
        reminder_day_sent = 0,
        reminder_2h_sent = 0
    WHERE id = ?
  `;
  await run(sql, [newDate, newTime, event.id]);
  return getEventById(event.id);
}

// 3-Stage Reminder Queries
async function getEventsForDayReminder(todayStr) {
  const sql = `
    SELECT * FROM events
    WHERE event_date = ? AND reminder_day_sent = 0
  `;
  return all(sql, [todayStr]);
}

async function getEventsFor2hReminder(todayStr) {
  const sql = `
    SELECT * FROM events
    WHERE event_date = ? AND start_time IS NOT NULL AND reminder_2h_sent = 0
  `;
  return all(sql, [todayStr]);
}

async function getEventsFor15mReminder(todayStr) {
  const sql = `
    SELECT * FROM events
    WHERE event_date = ? AND start_time IS NOT NULL AND reminder_sent = 0
  `;
  return all(sql, [todayStr]);
}

async function updateEventReminderFlag(id, stage) {
  if (stage === "day") {
    return run("UPDATE events SET reminder_day_sent = 1 WHERE id = ?", [id]);
  } else if (stage === "2h") {
    return run("UPDATE events SET reminder_2h_sent = 1 WHERE id = ?", [id]);
  } else if (stage === "15m") {
    return run("UPDATE events SET reminder_sent = 1 WHERE id = ?", [id]);
  }
}

// ==========================================
// 2. NOTES
// ==========================================

async function addNote({ title = null, content }) {
  const sql = `
    INSERT INTO notes (title, content, created_at, updated_at)
    VALUES (?, ?, datetime('now', '+8 hours'), datetime('now', '+8 hours'))
  `;
  const result = await run(sql, [title, content]);
  return { id: result.id, title, content };
}

async function getNoteById(id) {
  return get("SELECT * FROM notes WHERE id = ?", [id]);
}

async function getNoteByTitle(title) {
  return get("SELECT * FROM notes WHERE LOWER(title) = LOWER(?) ORDER BY updated_at DESC LIMIT 1", [title]);
}

async function searchNotes(query) {
  const pattern = `%${query}%`;
  const sql = `
    SELECT * FROM notes
    WHERE title LIKE ? OR content LIKE ?
    ORDER BY updated_at DESC
  `;
  return all(sql, [pattern, pattern]);
}

async function getAllNotes() {
  return all("SELECT * FROM notes ORDER BY updated_at DESC");
}

async function updateNote(id, { title, content }) {
  let sql = "";
  let params = [];

  if (title !== undefined && content !== undefined) {
    sql = "UPDATE notes SET title = ?, content = ?, updated_at = datetime('now', '+8 hours') WHERE id = ?";
    params = [title, content, id];
  } else if (content !== undefined) {
    sql = "UPDATE notes SET content = ?, updated_at = datetime('now', '+8 hours') WHERE id = ?";
    params = [content, id];
  } else if (title !== undefined) {
    sql = "UPDATE notes SET title = ?, updated_at = datetime('now', '+8 hours') WHERE id = ?";
    params = [title, id];
  }

  if (!sql) return { changes: 0 };
  return run(sql, params);
}

async function deleteNote(id) {
  return run("DELETE FROM notes WHERE id = ?", [id]);
}

// ==========================================
// 3. TASKS
// ==========================================

async function addTask(text) {
  const sql = `
    INSERT INTO tasks (text, completed, created_at)
    VALUES (?, 0, datetime('now', '+8 hours'))
  `;
  const result = await run(sql, [text]);
  return { id: result.id, text, completed: 0 };
}

async function getTasks(onlyPending = true) {
  if (onlyPending) {
    return all("SELECT * FROM tasks WHERE completed = 0 ORDER BY id ASC");
  }
  return all("SELECT * FROM tasks ORDER BY completed ASC, id ASC");
}

async function getTaskById(id) {
  return get("SELECT * FROM tasks WHERE id = ?", [id]);
}

async function completeTask(id) {
  return run("UPDATE tasks SET completed = 1 WHERE id = ?", [id]);
}

async function deleteTask(id) {
  return run("DELETE FROM tasks WHERE id = ?", [id]);
}

// ==========================================
// 4. REMINDERS
// ==========================================

async function addReminder({ text, remind_at, recurring = null }) {
  const sql = `
    INSERT INTO reminders (text, remind_at, recurring, completed, created_at)
    VALUES (?, ?, ?, 0, datetime('now', '+8 hours'))
  `;
  const result = await run(sql, [text, remind_at, recurring]);
  return { id: result.id, text, remind_at, recurring, completed: 0 };
}

async function getPendingReminders() {
  return all("SELECT * FROM reminders WHERE completed = 0 ORDER BY remind_at ASC");
}

async function getDueReminders(currentDateTimeStr) {
  const sql = `
    SELECT * FROM reminders
    WHERE completed = 0 AND remind_at <= ?
    ORDER BY remind_at ASC
  `;
  return all(sql, [currentDateTimeStr]);
}

async function completeReminder(id) {
  return run("UPDATE reminders SET completed = 1 WHERE id = ?", [id]);
}

async function rescheduleReminder(id, nextRemindAt) {
  return run("UPDATE reminders SET remind_at = ? WHERE id = ?", [nextRemindAt, id]);
}

async function deleteReminder(id) {
  return run("DELETE FROM reminders WHERE id = ?", [id]);
}

async function getPending15mReminderCalls(todayStr) {
  const sql = `
    SELECT * FROM reminders
    WHERE remind_at LIKE ? AND completed = 0 AND (call_15m_sent IS NULL OR call_15m_sent = 0)
    ORDER BY remind_at ASC
  `;
  return all(sql, [`${todayStr}%`]);
}

async function markReminder15mCallSent(id) {
  return run("UPDATE reminders SET call_15m_sent = 1 WHERE id = ?", [id]);
}

// ==========================================
// 5. MEMORIES (Learned Preferences)
// ==========================================

async function getMemories() {
  return all("SELECT * FROM memories ORDER BY id ASC");
}

async function addMemory(fact, category = "general") {
  const sql = `
    INSERT INTO memories (fact, category, created_at)
    VALUES (?, ?, datetime('now', '+8 hours'))
  `;
  const result = await run(sql, [fact, category]);
  return { id: result.id, fact, category };
}

async function deleteMemory(id) {
  return run("DELETE FROM memories WHERE id = ?", [id]);
}

// ==========================================
// 6. SYSTEM SETTINGS & TOKEN SAVER
// ==========================================

async function getSetting(key, defaultValue = null) {
  const row = await get("SELECT value FROM system_settings WHERE key = ?", [key]);
  return row ? row.value : defaultValue;
}

async function setSetting(key, value) {
  const sql = `
    INSERT INTO system_settings (key, value, updated_at)
    VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
  `;
  return run(sql, [key, String(value)]);
}

async function recordTokenUsage({ date, source, model, prompt_tokens, completion_tokens, total_tokens, saved_tokens }) {
  const dateStr = date || getKLDateStr();
  const sql = `
    INSERT INTO token_stats (date, source, model, prompt_tokens, completion_tokens, total_tokens, saved_tokens)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `;
  return run(sql, [
    dateStr,
    source || "unknown",
    model || "gemini-3.6-flash",
    prompt_tokens || 0,
    completion_tokens || 0,
    total_tokens || 0,
    saved_tokens || 0
  ]);
}

async function getTodayTokenStats(dateStr) {
  const d = dateStr || getKLDateStr();
  const sql = `
    SELECT 
      COUNT(*) as total_queries,
      COALESCE(SUM(prompt_tokens), 0) as total_prompt_tokens,
      COALESCE(SUM(completion_tokens), 0) as total_completion_tokens,
      COALESCE(SUM(total_tokens), 0) as total_tokens,
      COALESCE(SUM(saved_tokens), 0) as total_saved_tokens
    FROM token_stats
    WHERE date = ?
  `;
  return get(sql, [d]);
}

// ==========================================
// 8. AUDIT LOG & SNOOZE HELPERS
// ==========================================

async function snoozeReminder(id, minutes = 15) {
  const rem = id ? await get("SELECT * FROM reminders WHERE id = ?", [id]) : await getLastActiveReminder();
  if (!rem) return null;
  const now = getKLDate();
  const nextDate = new Date(now.getTime() + minutes * 60 * 1000);
  const nextDateStr = `${getKLDateStr(nextDate)} ${getKLTimeStr(nextDate)}:00`;
  await run("UPDATE reminders SET remind_at = ?, call_15m_sent = 0, completed = 0 WHERE id = ?", [nextDateStr, rem.id]);
  return { id: rem.id, text: rem.text, remind_at: nextDateStr, minutes };
}

async function getLastActiveReminder() {
  return get("SELECT * FROM reminders ORDER BY id DESC LIMIT 1");
}

async function logAction(action, detail, status = "SUCCESS") {
  try {
    const sql = `
      INSERT INTO action_audit_log (action, detail, status, created_at)
      VALUES (?, ?, ?, datetime('now', '+8 hours'))
    `;
    return await run(sql, [action, detail, status]);
  } catch (e) {
    return null;
  }
}

async function getReminderById(id) {
  return get("SELECT * FROM reminders WHERE id = ?", [id]);
}

async function incrementReminderRepeat(id) {
  return run("UPDATE reminders SET repeat_count = COALESCE(repeat_count, 0) + 1 WHERE id = ?", [id]);
}

/**
 * Creates a timestamped local SQLite backup and uploads to AWS S3 if configured.
 * Retains 14 most recent backups locally.
 */
async function backupDatabase() {
  const fs = require("fs");
  const backupDir = path.join(__dirname, "backups");
  if (!fs.existsSync(backupDir)) {
    fs.mkdirSync(backupDir, { recursive: true });
  }

  const d = getKLDate();
  const dateStr = getKLDateStr(d).replace(/-/g, "");
  const timeStr = getKLTimeStr(d).replace(/:/g, "");
  const backupFileName = `personal_${dateStr}_${timeStr}.db`;
  const backupFilePath = path.join(backupDir, backupFileName);

  try {
    fs.copyFileSync(DB_PATH, backupFilePath);
    console.log(`💾 Database backed up: ${backupFilePath}`);

    // Offsite cloud backup if AWS_S3_BACKUP_BUCKET is configured
    const s3Bucket = process.env.AWS_S3_BACKUP_BUCKET;
    if (s3Bucket) {
      const { exec } = require("child_process");
      exec(`aws s3 cp "${backupFilePath}" "s3://${s3Bucket}/jarvis_backups/${backupFileName}"`, (err, stdout) => {
        if (err) console.warn("⚠️ S3 backup warning:", err.message);
        else console.log("☁️ S3 cloud backup completed:", stdout.trim());
      });
    }

    // Local rotation (retain last 14 backups)
    const files = fs.readdirSync(backupDir)
      .filter(f => f.startsWith("personal_") && f.endsWith(".db"))
      .sort();
    while (files.length > 14) {
      const oldest = files.shift();
      try {
        fs.unlinkSync(path.join(backupDir, oldest));
      } catch (e) {}
    }

    return backupFilePath;
  } catch (err) {
    console.error("Backup failed:", err.message);
    return null;
  }
}

/**
 * Exports all upcoming and current calendar events to standard iCalendar (.ics) format.
 */
async function exportCalendarICS() {
  const events = await all("SELECT * FROM events ORDER BY event_date ASC, start_time ASC");
  const icsLines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//JARVIS AI//Personal Calendar//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH"
  ];

  for (const e of events) {
    const dStr = e.event_date.replace(/-/g, "");
    const startTime = (e.start_time || "09:00").replace(/:/g, "") + "00";
    let endTime = e.end_time && e.end_time.includes(":") ? e.end_time.replace(/:/g, "") + "00" : null;
    if (!endTime) {
      const [h, m] = (e.start_time || "09:00").split(":").map(Number);
      const endH = String((h + 1) % 24).padStart(2, "0");
      endTime = `${endH}${String(m).padStart(2, "0")}00`;
    }

    icsLines.push(
      "BEGIN:VEVENT",
      `UID:jarvis-event-${e.id}@jarvis.local`,
      `DTSTAMP:${dStr}T000000Z`,
      `DTSTART:${dStr}T${startTime}`,
      `DTEND:${dStr}T${endTime}`,
      `SUMMARY:${e.title.replace(/[,;]/g, " ")}`,
      `DESCRIPTION:${(e.description || "").replace(/[,;\n]/g, " ")}`,
      "STATUS:CONFIRMED",
      "END:VEVENT"
    );
  }

  icsLines.push("END:VCALENDAR");
  return icsLines.join("\r\n");
}

async function getTodayActions() {
  const today = getKLDateStr();
  const sql = `
    SELECT * FROM action_audit_log
    WHERE created_at LIKE ?
    ORDER BY id ASC
  `;
  return all(sql, [`${today}%`]);
}

module.exports = {
  db,
  backupDatabase,
  exportCalendarICS,
  getKLDate,
  getKLDateStr,
  getKLTimeStr,
  getKLDateTimeStr,
  // Events
  addEvent,
  getUpcomingEvents,
  getAllUpcomingEvents,
  getEventsForDate,
  getEventById,
  deleteEvent,
  undoLastEventDelete,
  checkEventConflict,
  rescheduleEvent,
  getEventsForDayReminder,
  getEventsFor2hReminder,
  getEventsFor15mReminder,
  updateEventReminderFlag,
  // Notes
  addNote,
  getNoteById,
  getNoteByTitle,
  searchNotes,
  getAllNotes,
  updateNote,
  deleteNote,
  // Tasks
  addTask,
  getTasks,
  getTaskById,
  completeTask,
  deleteTask,
  // Reminders
  addReminder,
  getPendingReminders,
  getDueReminders,
  getPending15mReminderCalls,
  markReminder15mCallSent,
  completeReminder,
  rescheduleReminder,
  deleteReminder,
  snoozeReminder,
  getLastActiveReminder,
  getReminderById,
  incrementReminderRepeat,
  // Audit Log & Activity
  logAction,
  getTodayActions,
  // Memories
  getMemories,
  addMemory,
  deleteMemory,
  // Settings & Token Saver
  getSetting,
  setSetting,
  recordTokenUsage,
  getTodayTokenStats
};

