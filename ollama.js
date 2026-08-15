const axios = require("axios");

const OLLAMA_URL = process.env.OLLAMA_URL || "http://localhost:11434";
const MODEL = process.env.OLLAMA_MODEL || "qwen2.5:3b";

let modelWarmed = false;

/**
 * Pre-warms the Ollama model into memory on startup
 */
async function warmModel() {
  if (modelWarmed) return;
  try {
    console.log(`🔥 Pre-warming Ollama model: ${MODEL}...`);
    await axios.post(
      `${OLLAMA_URL}/api/generate`,
      {
        model: MODEL,
        prompt: "hi",
        stream: false,
        keep_alive: "60m",
        options: { num_predict: 1 }
      },
      { timeout: 30000 }
    );
    modelWarmed = true;
    console.log(`✅ Ollama model (${MODEL}) warmed and active in memory`);
  } catch (err) {
    console.warn(`⚠️ Ollama model warm-up skipped / failed: ${err.message}`);
  }
}

/**
 * Query Ollama with system prompt and user prompt
 * @param {string} prompt 
 * @param {number} temperature 
 * @param {number} maxTokens 
 * @param {string} system 
 * @returns {Promise<string>}
 */
async function queryOllama(prompt, temperature = 0.7, maxTokens = 250, system = "") {
  try {
    const payload = {
      model: MODEL,
      prompt: prompt,
      stream: false,
      keep_alive: "60m",
      options: {
        num_predict: maxTokens,
        temperature: temperature,
        top_p: 0.9,
        top_k: 40
      }
    };

    if (system) {
      payload.system = system;
    }

    const response = await axios.post(`${OLLAMA_URL}/api/generate`, payload, {
      timeout: 60000
    });

    let text = response.data.response ? response.data.response.trim() : "";
    // Clean markdown code blocks wrappers if entire response is enclosed
    text = text.replace(/^```[\w]*\n?/gm, "").replace(/```$/gm, "").trim();
    return text;
  } catch (error) {
    console.error("Ollama query error:", error.message);
    throw new Error(`Ollama error: ${error.message}`);
  }
}

module.exports = { queryOllama, warmModel };
