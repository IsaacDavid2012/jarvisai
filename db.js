const sqlite3 = require("sqlite3").verbose();
const path = require("path");
require("dotenv").config();

process.env.TZ = process.env.TZ || "Asia/Kuala_Lumpur";

const DB_PATH = path.join(__dirname, "personal.db");
const db = new sqlite3.Database(DB_PATH);

// Helper for local Asia/Kuala_Lumpur (+08:00) YYYY-MM-DD date string
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

// Initialize tables
db.serialize(() => {
  // Calendar Events
  db.run(`
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      event_date TEXT NOT NULL,
      start_time TEXT,
      end_time TEXT,
      description TEXT,
      recipient_phone TEXT,
      reminder_sent INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Migrations
  db.run("ALTER TABLE events ADD COLUMN reminder_sent INTEGER DEFAULT 0", () => {});
  db.run("ALTER TABLE events ADD COLUMN recipient_phone TEXT", () => {});
  db.run("ALTER TABLE events ADD COLUMN reminder_day_sent INTEGER DEFAULT 0", () => {});
  db.run("ALTER TABLE events ADD COLUMN reminder_2h_sent INTEGER DEFAULT 0", () => {});

  // Tasks
  db.run(`
    CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      text TEXT NOT NULL,
      completed INTEGER DEFAULT 0,
      reminder_sent INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Notes
  db.run(`
    CREATE TABLE IF NOT EXISTS notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT,
      content TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Persistent Learning & Memory
  db.run(`
    CREATE TABLE IF NOT EXISTS memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      category TEXT DEFAULT 'general',
      fact TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Performance Indexes
  db.run("CREATE INDEX IF NOT EXISTS idx_events_date ON events(event_date)");
  db.run("CREATE INDEX IF NOT EXISTS idx_tasks_completed ON tasks(completed)");
  db.run("CREATE INDEX IF NOT EXISTS idx_notes_updated ON notes(updated_at)");
  db.run("CREATE INDEX IF NOT EXISTS idx_memories_created ON memories(created_at)");
});

// --- CALENDAR ---
function addEvent({ title, date, startTime, endTime, description, recipientPhone }) {
  return new Promise((resolve, reject) => {
    db.run(
      "INSERT INTO events (title, event_date, start_time, end_time, description, recipient_phone, reminder_sent) VALUES (?, ?, ?, ?, ?, ?, 0)",
      [title, date, startTime || "10:00", endTime || "11:00", description || "", recipientPhone || ""],
      function (err) {
        if (err) reject(err);
        else resolve({ id: this.lastID, title, date, startTime, endTime, description, recipientPhone });
      }
    );
  });
}

function getUpcomingEvents(days = 7) {
  return new Promise((resolve, reject) => {
    const today = getKLDateStr();
    const klNow = getKLDate();
    const future = new Date(klNow.getTime() + days * 24 * 60 * 60 * 1000);
    const futureKL = new Date(future.toLocaleString("en-US", { timeZone: "Asia/Kuala_Lumpur" }));
    const endDate = getKLDateStr(futureKL);
    db.all(
      "SELECT * FROM events WHERE event_date >= ? AND event_date <= ? ORDER BY event_date ASC, start_time ASC",
      [today, endDate],
      (err, rows) => {
        if (err) reject(err);
        else resolve(rows || []);
      }
    );
  });
}

function deleteEvent(id) {
  return new Promise((resolve, reject) => {
    db.run("DELETE FROM events WHERE id = ?", [id], function (err) {
      if (err) reject(err);
      else resolve({ id, changes: this.changes });
    });
  });
}

// --- REMINDERS (MULTI-STAGE) ---
function getDueDayReminders() {
  return new Promise((resolve, reject) => {
    const todayStr = getKLDateStr();
    db.all(
      "SELECT * FROM events WHERE event_date = ? AND (reminder_day_sent IS NULL OR reminder_day_sent = 0)",
      [todayStr],
      (err, rows) => {
        if (err) reject(err);
        else resolve(rows || []);
      }
    );
  });
}

function getDue2HourReminders() {
  return new Promise((resolve, reject) => {
    const klNow = getKLDate();
    const todayStr = getKLDateStr();

    const tomorrowDate = new Date(klNow.getTime() + 24 * 60 * 60 * 1000);
    const tomorrowKL = new Date(tomorrowDate.toLocaleString("en-US", { timeZone: "Asia/Kuala_Lumpur" }));
    const tomorrowStr = getKLDateStr(tomorrowKL);

    db.all(
      "SELECT * FROM events WHERE (reminder_2h_sent IS NULL OR reminder_2h_sent = 0) AND event_date <= ?",
      [tomorrowStr],
      (err, rows) => {
        if (err) return reject(err);
        if (!rows || rows.length === 0) return resolve([]);

        const dueEvents = rows.filter(event => {
          if (!event.start_time) return false;
          const [hours, minutes] = event.start_time.split(":").map(Number);
          const [eYear, eMonth, eDay] = event.event_date.split("-").map(Number);
          const eventTime = new Date(eYear, eMonth - 1, eDay, hours, minutes, 0, 0);

          const diffMs = eventTime.getTime() - klNow.getTime();
          const diffMins = Math.floor(diffMs / 60000);

          // Fire 2-hour reminder if event is within 120 mins (2 hours) and > 30 mins away
          return diffMins <= 120 && diffMins > 30;
        });

        resolve(dueEvents);
      }
    );
  });
}

function getPendingEventReminders(advanceMinutes = 30) {
  return new Promise((resolve, reject) => {
    const klNow = getKLDate();
    const tomorrowDate = new Date(klNow.getTime() + 24 * 60 * 60 * 1000);
    const tomorrowKL = new Date(tomorrowDate.toLocaleString("en-US", { timeZone: "Asia/Kuala_Lumpur" }));
    const tomorrowStr = getKLDateStr(tomorrowKL);

    db.all(
      "SELECT * FROM events WHERE (reminder_sent IS NULL OR reminder_sent = 0) AND event_date <= ?",
      [tomorrowStr],
      (err, rows) => {
        if (err) return reject(err);
        if (!rows || rows.length === 0) return resolve([]);

        const dueEvents = rows.filter(event => {
          if (!event.start_time) return true;

          const [hours, minutes] = event.start_time.split(":").map(Number);
          const [eYear, eMonth, eDay] = event.event_date.split("-").map(Number);
          const eventTime = new Date(eYear, eMonth - 1, eDay, hours, minutes, 0, 0);

          const diffMs = eventTime.getTime() - klNow.getTime();
          const diffMins = Math.floor(diffMs / 60000);

          return diffMins <= advanceMinutes && diffMins >= -30;
        });

        resolve(dueEvents);
      }
    );
  });
}

function markReminderDaySent(id) {
  return new Promise((resolve, reject) => {
    db.run("UPDATE events SET reminder_day_sent = 1 WHERE id = ?", [id], function (err) {
      if (err) reject(err);
      else resolve({ id });
    });
  });
}

function markReminder2HSent(id) {
  return new Promise((resolve, reject) => {
    db.run("UPDATE events SET reminder_2h_sent = 1 WHERE id = ?", [id], function (err) {
      if (err) reject(err);
      else resolve({ id });
    });
  });
}

function markEventReminderSent(id) {
  return new Promise((resolve, reject) => {
    db.run("UPDATE events SET reminder_sent = 1 WHERE id = ?", [id], function (err) {
      if (err) reject(err);
      else resolve({ id });
    });
  });
}

// --- TASKS ---
function addTask(text) {
  return new Promise((resolve, reject) => {
    db.run("INSERT INTO tasks (text) VALUES (?)", [text], function (err) {
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
    db.run("UPDATE tasks SET completed = 1 WHERE id = ?", [id], function (err) {
      if (err) reject(err);
      else resolve({ id, changes: this.changes });
    });
  });
}

function deleteTask(id) {
  return new Promise((resolve, reject) => {
    db.run("DELETE FROM tasks WHERE id = ?", [id], function (err) {
      if (err) reject(err);
      else resolve({ id, changes: this.changes });
    });
  });
}

// --- NOTES ---
function addNote(content, title = "") {
  return new Promise((resolve, reject) => {
    if (!title && content.length > 30) {
      title = content.substring(0, 30) + "...";
    } else if (!title) {
      title = content;
    }
    db.run(
      "INSERT INTO notes (title, content) VALUES (?, ?)",
      [title, content],
      function (err) {
        if (err) reject(err);
        else resolve({ id: this.lastID, title, content });
      }
    );
  });
}

function getNotes() {
  return new Promise((resolve, reject) => {
    db.all("SELECT * FROM notes ORDER BY updated_at DESC", [], (err, rows) => {
      if (err) reject(err);
      else resolve(rows || []);
    });
  });
}

function searchNotes(query) {
  return new Promise((resolve, reject) => {
    const searchTerm = `%${query}%`;
    db.all(
      "SELECT * FROM notes WHERE title LIKE ? OR content LIKE ? ORDER BY updated_at DESC",
      [searchTerm, searchTerm],
      (err, rows) => {
        if (err) reject(err);
        else resolve(rows || []);
      }
    );
  });
}

function deleteNote(id) {
  return new Promise((resolve, reject) => {
    db.run("DELETE FROM notes WHERE id = ?", [id], function (err) {
      if (err) reject(err);
      else resolve({ id, changes: this.changes });
    });
  });
}

// --- MEMORIES ---
function addMemory(fact, category = "general") {
  return new Promise((resolve, reject) => {
    db.run(
      "INSERT INTO memories (fact, category) VALUES (?, ?)",
      [fact, category],
      function (err) {
        if (err) reject(err);
        else resolve({ id: this.lastID, fact, category });
      }
    );
  });
}

function getMemories() {
  return new Promise((resolve, reject) => {
    db.all("SELECT * FROM memories ORDER BY created_at DESC", [], (err, rows) => {
      if (err) reject(err);
      else resolve(rows || []);
    });
  });
}

function deleteMemory(id) {
  return new Promise((resolve, reject) => {
    db.run("DELETE FROM memories WHERE id = ?", [id], function (err) {
      if (err) reject(err);
      else resolve({ id, changes: this.changes });
    });
  });
}

function getNoteById(id) {
  return new Promise((resolve, reject) => {
    db.get("SELECT * FROM notes WHERE id = ?", [id], (err, row) => {
      if (err) reject(err);
      else resolve(row || null);
    });
  });
}

module.exports = {
  addEvent,
  getUpcomingEvents,
  deleteEvent,
  getPendingEventReminders,
  getDueDayReminders,
  getDue2HourReminders,
  markReminderDaySent,
  markReminder2HSent,
  markEventReminderSent,
  addTask,
  getTasks,
  completeTask,
  deleteTask,
  addNote,
  getNotes,
  getNoteById,
  searchNotes,
  deleteNote,
  addMemory,
  getMemories,
  deleteMemory,
  getKLDateStr
};
