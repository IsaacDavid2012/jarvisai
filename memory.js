const fs = require("fs");
const path = require("path");
const db = require("./db");

const MEMORY_FILE_PATH = path.join(__dirname, "MEMORY.md");

// Initialize MEMORY.md file if it doesn't exist
if (!fs.existsSync(MEMORY_FILE_PATH)) {
  const initialContent = `# 🧠 JARVIS LEARNED MEMORIES & PREFERENCES

This file contains JARVIS's persistent memory. It automatically updates whenever Isaac shares preferences, habits, workflow rules, or explicitly tells JARVIS to remember something.

## 👤 Preferences & Workflows
- Isaac prefers direct, concise responses with zero AI fluff.
- Default timezone: Asia/Kuala_Lumpur (MYT).
`;
  fs.writeFileSync(MEMORY_FILE_PATH, initialContent, "utf8");
}

// Sync MEMORY.md file to SQLite database on startup
async function initMemory() {
  try {
    const dbMemories = await db.getMemories();
    if (dbMemories.length === 0) {
      // Seed DB with initial defaults
      await db.addMemory("Isaac prefers direct, concise responses with zero AI fluff.", "preference");
      await db.addMemory("Default timezone: Asia/Kuala_Lumpur (MYT).", "preference");
    }
    await syncMemoryFile();
  } catch (err) {
    console.error("Memory initialization error:", err.message);
  }
}

// Rebuild MEMORY.md from DB
async function syncMemoryFile() {
  try {
    const memories = await db.getMemories();
    let content = `# 🧠 JARVIS LEARNED MEMORIES & PREFERENCES\n\n`;
    content += `_Last updated: ${new Date().toISOString()}_\n\n`;

    if (memories.length === 0) {
      content += `_No custom memories saved yet._\n`;
    } else {
      memories.forEach(m => {
        content += `- [ID: #${m.id}] ${m.fact}\n`;
      });
    }

    fs.writeFileSync(MEMORY_FILE_PATH, content, "utf8");
  } catch (err) {
    console.error("Error syncing MEMORY.md file:", err.message);
  }
}

// Save a new memory
async function learnMemory(fact, category = "general") {
  try {
    const cleanFact = fact.replace(/^remember\s*(that|to|about)?\s*/i, "").replace(/^learn\s*(that)?\s*/i, "").trim();
    if (!cleanFact) return null;

    const result = await db.addMemory(cleanFact, category);
    await syncMemoryFile();
    console.log(`🧠 [LEARNED]: ${cleanFact}`);
    return result;
  } catch (err) {
    console.error("Error saving memory:", err.message);
    throw err;
  }
}

// Automatically detect preference statements in casual chat and save them silently
async function autoExtractMemory(userMsg) {
  try {
    const msg = userMsg.trim();
    // Patterns indicating Isaac is expressing a preference, rule, habit, or instruction
    const prefPatterns = [
      /^(always|never)\s+/i,
      /^(i prefer|i like|i hate|my preference is)\s+/i,
      /^(when i say|when i ask for|my workflow is)\s+/i,
      /^(for video shoots|for photography|for drum recording)\s+/i,
      /^(my client|my gear|my camera|my software|my server)\s+/i
    ];

    const isMatch = prefPatterns.some(p => p.test(msg));
    if (isMatch && msg.length > 8 && msg.length < 200) {
      await learnMemory(msg, "preference");
      console.log(`💡 Auto-learned preference: "${msg}"`);
    }
  } catch (e) {
    // Non-critical background feature
  }
}

// Load compact memory context for LLM prompt injection (keeps prompts fast)
async function getMemoryContext() {
  try {
    const memories = await db.getMemories();
    if (memories.length === 0) return "";

    const facts = memories.slice(0, 8).map(m => `• ${m.fact}`).join("\n");
    return `\nLearned User Memories & Preferences:\n${facts}\n`;
  } catch (e) {
    return "";
  }
}

// Format memory list for WhatsApp command
async function handleMemoryList() {
  try {
    const memories = await db.getMemories();
    if (memories.length === 0) {
      return "🧠 *JARVIS MEMORY*\n───────────────\n📭 _I haven't learned any custom preferences or facts yet._\n\n💡 _Tip: Reply \"Remember that...\" to teach me anything!_";
    }

    const list = memories.map((m, i) => `${i + 1}️⃣ *${m.fact}* \`[ID: #${m.id}]\``).join("\n");
    return `🧠 *JARVIS LEARNED MEMORIES & PREFERENCES*\n───────────────\n${list}\n\n💡 _Tip: Reply "forget memory <id>" to delete a memory._`;
  } catch (err) {
    return `❌ *Error fetching memories:* ${err.message}`;
  }
}

// Delete memory handler
async function handleMemoryDelete(userMsg) {
  try {
    const match = userMsg.match(/\d+/);
    if (!match) return "❌ Please specify memory ID (e.g. *forget memory 1*).";
    const id = parseInt(match[0]);
    await db.deleteMemory(id);
    await syncMemoryFile();
    return `🗑️ *MEMORY FORGOTTEN*\n───────────────\nRemoved memory \`#${id}\`.`;
  } catch (err) {
    return `❌ *Error removing memory:* ${err.message}`;
  }
}

module.exports = {
  initMemory,
  learnMemory,
  autoExtractMemory,
  getMemoryContext,
  handleMemoryList,
  handleMemoryDelete
};
