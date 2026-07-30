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
