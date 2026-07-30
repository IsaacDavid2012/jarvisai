const axios = require("axios");

const OLLAMA_URL = process.env.OLLAMA_URL || "http://localhost:11434";
const MODEL = process.env.OLLAMA_MODEL || "qwen2.5:3b";

// Pre-warm the model on startup so the first message isn't slow
let modelWarmed = false;
async function warmModel() {
  if (modelWarmed) return;
  try {
    console.log(`🔥 Pre-warming model: ${MODEL}...`);
    await axios.post(`${OLLAMA_URL}/api/generate`, {
      model: MODEL,
      prompt: "hi",
      stream: false,
      keep_alive: "30m",
      options: { num_predict: 1 }
    }, { timeout: 120000 });
    modelWarmed = true;
    console.log(`✅ Model ${MODEL} warmed and loaded into memory`);
  } catch (err) {
    console.warn(`⚠️ Model warm-up failed: ${err.message}`);
  }
}

async function queryOllama(prompt, temperature = 0.7, maxTokens = 150) {
  try {
    const response = await axios.post(`${OLLAMA_URL}/api/generate`, {
      model: MODEL,
      prompt: prompt,
      stream: false,
      keep_alive: "30m",
      options: {
        num_predict: maxTokens,
        temperature: temperature,
        top_p: 0.9,
        top_k: 40
      }
    }, {
      timeout: 120000
    });

    let text = response.data.response.trim();
    
    // Clean up markdown code blocks if present
    text = text.replace(/^```[\w]*\n?/gm, "").replace(/```$/gm, "");
    
    return text;
  } catch (error) {
    console.error("Ollama error:", error.message);
    throw new Error(`Ollama error: ${error.message}`);
  }
}

module.exports = { queryOllama, warmModel };
