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
      { timeout: 60000 }
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
const db = require("./db");

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-3.6-flash";

/**
 * Query Gemini 3.6 Flash single prompt with Token Saver compression
 */
async function queryGemini(prompt, system = "", maxTokens = 150) {
  if (!GEMINI_API_KEY) return null;
  try {
    const saverSetting = await db.getSetting("token_saver_mode", "enabled");
    const isSaver = saverSetting !== "disabled";

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
    const generationConfig = {
      temperature: 0.6,
      maxOutputTokens: isSaver ? Math.min(maxTokens, 150) : maxTokens
    };
    if (isSaver) {
      generationConfig.thinkingConfig = { thinkingBudget: 0 };
    }

    const payload = {
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig
    };
    if (system) {
      payload.systemInstruction = { parts: [{ text: system }] };
    }

    const resp = await axios.post(url, payload, { timeout: 15000 });
    const candidate = resp.data?.candidates?.[0];

    // Record token usage and savings
    const usage = resp.data?.usageMetadata;
    if (usage) {
      const promptTokens = usage.promptTokenCount || 0;
      const completionTokens = usage.candidatesTokenCount || 0;
      const totalTokens = usage.totalTokenCount || 0;
      const savedTokens = isSaver ? 600 : 0;
      db.recordTokenUsage({
        source: "whatsapp_query",
        model: GEMINI_MODEL,
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: totalTokens,
        saved_tokens: savedTokens
      }).catch(() => {});
    }

    if (candidate?.content?.parts?.[0]?.text) {
      let text = candidate.content.parts[0].text.trim();
      text = text.replace(/^```[\w]*\n?/gm, "").replace(/```$/gm, "").trim();
      return text;
    }
    return null;
  } catch (err) {
    console.warn(`⚠️ Gemini API error (${err.response?.status || err.message}), falling back to local Ollama...`);
    return null;
  }
}

/**
 * Multi-turn Chat with Gemini 3.6 Flash in Token Saver mode
 */
async function chatGemini(messages, temperature = 0.7, maxTokens = 200) {
  if (!GEMINI_API_KEY) return null;
  try {
    const saverSetting = await db.getSetting("token_saver_mode", "enabled");
    const isSaver = saverSetting !== "disabled";

    let systemInstruction = "";
    const nonSystem = [];
    for (const m of messages) {
      if (m.role === "system") {
        systemInstruction += (systemInstruction ? "\n" : "") + m.content;
      } else {
        nonSystem.push(m);
      }
    }

    // Token Saver: Prune context window to last 4 turns to prevent prompt token bloat
    const turnsToKeep = isSaver ? 4 : 10;
    const trimmed = nonSystem.slice(-turnsToKeep);

    // Format for Gemini API (must alternate user/model and start with user)
    const contents = [];
    for (const msg of trimmed) {
      const role = (msg.role === "assistant" || msg.role === "model") ? "model" : "user";
      if (contents.length > 0 && contents[contents.length - 1].role === role) {
        contents[contents.length - 1].parts[0].text += `\n${msg.content}`;
      } else {
        contents.push({ role, parts: [{ text: msg.content }] });
      }
    }

    // Must start with user
    if (contents.length > 0 && contents[0].role !== "user") {
      contents.shift();
    }
    if (contents.length === 0) return null;

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
    const generationConfig = {
      temperature,
      maxOutputTokens: isSaver ? Math.min(maxTokens, 180) : maxTokens
    };
    if (isSaver) {
      // Zero thought tokens = ~85% token reduction & instant response (<0.4s)
      generationConfig.thinkingConfig = { thinkingBudget: 0 };
    }

    const payload = {
      contents,
      generationConfig
    };
    if (systemInstruction) {
      payload.systemInstruction = { parts: [{ text: systemInstruction }] };
    }

    const resp = await axios.post(url, payload, { timeout: 15000 });
    const candidate = resp.data?.candidates?.[0];

    // Log token stats to database
    const usage = resp.data?.usageMetadata;
    if (usage) {
      const promptTokens = usage.promptTokenCount || 0;
      const completionTokens = usage.candidatesTokenCount || 0;
      const totalTokens = usage.totalTokenCount || 0;
      // Estimated savings: 600 thought tokens + pruned context savings
      const savedTokens = isSaver ? (600 + Math.max(0, nonSystem.length - turnsToKeep) * 80) : 0;
      db.recordTokenUsage({
        source: "whatsapp_chat",
        model: GEMINI_MODEL,
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: totalTokens,
        saved_tokens: savedTokens
      }).catch(() => {});
    }

    if (candidate?.content?.parts?.[0]?.text) {
      let text = candidate.content.parts[0].text.trim();
      text = text.replace(/^```[\w]*\n?/gm, "").replace(/```$/gm, "").trim();
      return text;
    }
    return null;
  } catch (err) {
    console.warn(`⚠️ Gemini Chat API error (${err.response?.status || err.message}), falling back to Ollama...`);
    return null;
  }
}

/**
 * Query AI Brain (Gemini 3.6 Flash if key available, else Ollama)
 */
async function queryOllama(prompt, temperature = 0.7, maxTokens = 250, system = "") {
  // Token Saver Mode: Attempt Gemini first
  if (GEMINI_API_KEY) {
    const geminiReply = await queryGemini(prompt, system, maxTokens);
    if (geminiReply) return geminiReply;
  }

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
    text = text.replace(/^```[\w]*\n?/gm, "").replace(/```$/gm, "").trim();
    return text;
  } catch (error) {
    console.error("Ollama query error:", error.message);
    throw new Error(`AI generation error: ${error.message}`);
  }
}

/**
 * Chat with Gemini 3.6 Flash (Token Saver) with Ollama fallback
 */
async function chatOllama(messages, temperature = 0.7, maxTokens = 400) {
  // 1. Try Gemini 3.6 Flash in Token Saver mode
  if (GEMINI_API_KEY) {
    const geminiChatReply = await chatGemini(messages, temperature, maxTokens);
    if (geminiChatReply) {
      return geminiChatReply;
    }
  }

  // 2. Fallback to local Ollama /api/chat
  try {
    const payload = {
      model: MODEL,
      messages: messages,
      stream: false,
      keep_alive: "60m",
      options: {
        num_predict: maxTokens,
        temperature: temperature,
        top_p: 0.9,
        top_k: 40
      }
    };

    const response = await axios.post(`${OLLAMA_URL}/api/chat`, payload, {
      timeout: 60000
    });

    let text = response.data.message && response.data.message.content ? response.data.message.content.trim() : "";
    text = text.replace(/^```[\w]*\n?/gm, "").replace(/```$/gm, "").trim();
    return text;
  } catch (error) {
    console.error("Ollama chat error:", error.message);
    throw new Error(`Ollama error: ${error.message}`);
  }
}

module.exports = { queryOllama, chatOllama, queryGemini, chatGemini, warmModel };

