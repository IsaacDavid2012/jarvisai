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

async function getUpcomingEvents(days = 7) {
  const today = getKLDateStr();
  const endDate = new Date(getKLDate().getTime() + days * 24 * 60 * 60 * 1000);
  const endStr = getKLDateStr(endDate);

  const sql = `
    SELECT * FROM events
    WHERE event_date >= ? AND event_date <= ?
    ORDER BY event_date ASC, CASE WHEN start_time IS NULL THEN '00:00' ELSE start_time END ASC
  `;
  return all(sql, [today, endStr]);
}

async function getEventsForDate(dateStr) {
  const sql = `
    SELECT * FROM events
    WHERE event_date = ?
    ORDER BY CASE WHEN start_time IS NULL THEN '00:00' ELSE start_time END ASC
  `;
  return all(sql, [dateStr]);
}

async function getEventById(id) {
  return get("SELECT * FROM events WHERE id = ?", [id]);
}

async function deleteEvent(id) {
  return run("DELETE FROM events WHERE id = ?", [id]);
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

module.exports = {
  db,
  getKLDate,
  getKLDateStr,
  getKLTimeStr,
  getKLDateTimeStr,
  // Events
  addEvent,
  getUpcomingEvents,
  getEventsForDate,
  getEventById,
  deleteEvent,
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
  completeReminder,
  rescheduleReminder,
  deleteReminder
};
