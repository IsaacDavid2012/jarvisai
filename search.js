const axios = require("axios");
const { queryOllama } = require("./ollama");

/**
 * Cleans HTML entities and tags from API responses
 * @param {string} text 
 * @returns {string}
 */
function cleanText(text) {
  if (!text) return "";
  return text
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#0?39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Searches DuckDuckGo Instant Answer API with Wikipedia fallback
 * @param {string} query 
 * @returns {Promise<{ results: Array<{title: string, snippet: string, url: string}>, error?: string }>}
 */
async function searchWeb(query) {
  const cleanQuery = (query || "").trim();
  if (!cleanQuery) {
    return { results: [], error: "EMPTY_QUERY" };
  }

  console.log(`🌐 [WEB SEARCH] Query: "${cleanQuery}"`);
  const results = [];
  let ddgError = null;

  // 1. DuckDuckGo Instant Answer API
  try {
    const ddgUrl = `https://api.duckduckgo.com/?q=${encodeURIComponent(cleanQuery)}&format=json&no_html=1&skip_disambig=1`;
    const ddgRes = await axios.get(ddgUrl, {
      timeout: 5000,
      headers: { "User-Agent": "JARVIS-Assistant/1.0" }
    });

    if (ddgRes.data) {
      // Primary Abstract
      if (ddgRes.data.AbstractText && ddgRes.data.AbstractText.trim()) {
        results.push({
          title: ddgRes.data.Heading || cleanQuery,
          snippet: cleanText(ddgRes.data.AbstractText),
          url: ddgRes.data.AbstractURL || "https://duckduckgo.com/?q=" + encodeURIComponent(cleanQuery)
        });
      }

      // Related Topics
      if (Array.isArray(ddgRes.data.RelatedTopics)) {
        for (const topic of ddgRes.data.RelatedTopics) {
          if (results.length >= 5) break;

          // Direct topic
          if (topic.Text && topic.FirstURL) {
            results.push({
              title: topic.Text.split(" - ")[0] || "Related",
              snippet: cleanText(topic.Text),
              url: topic.FirstURL
            });
          }
          // Sub-topics in Topics array
          else if (Array.isArray(topic.Topics)) {
            for (const sub of topic.Topics) {
              if (results.length >= 5) break;
              if (sub.Text && sub.FirstURL) {
                results.push({
                  title: sub.Text.split(" - ")[0] || "Related",
                  snippet: cleanText(sub.Text),
                  url: sub.FirstURL
                });
              }
            }
          }
        }
      }
    }
  } catch (err) {
    console.warn(`⚠️ DDG Search API failed: ${err.message}`);
    ddgError = err;
  }

  // 2. Wikipedia API Fallback (if DDG returned fewer than 3 results)
  if (results.length < 3) {
    try {
      const wikiUrl = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(cleanQuery)}&format=json&utf8=1`;
      const wikiRes = await axios.get(wikiUrl, {
        timeout: 5000,
        headers: { "User-Agent": "JARVIS-Assistant/1.0 (isaac@personal.assistant)" }
      });

      if (wikiRes.data && wikiRes.data.query && Array.isArray(wikiRes.data.query.search)) {
        for (const item of wikiRes.data.query.search) {
          if (results.length >= 5) break;
          const snippet = cleanText(item.snippet);
          if (snippet) {
            results.push({
              title: item.title,
              snippet: snippet,
              url: `https://en.wikipedia.org/wiki/${encodeURIComponent(item.title.replace(/\s+/g, "_"))}`
            });
          }
        }
      }
    } catch (wikiErr) {
      console.warn(`⚠️ Wikipedia Search API failed: ${wikiErr.message}`);
      if (results.length === 0 && (ddgError?.code === "ECONNABORTED" || wikiErr.code === "ECONNABORTED")) {
        return { results: [], error: "TIMEOUT" };
      }
      if (results.length === 0) {
        return { results: [], error: "UNAVAILABLE" };
      }
    }
  }

  return { results, error: null };
}

/**
 * Generates an executive summary using Ollama (qwen2.5:3b) and formats output for WhatsApp
 * @param {Array<{title: string, snippet: string, url: string}>} results 
 * @param {string} query 
 * @returns {Promise<string>} Formatted WhatsApp message string
 */
async function summarizeResults(results, query) {
  if (!results || results.length === 0) {
    return `🔍 *Results for '${query}':*\n\nNo results found for '${query}'. Try different keywords.`;
  }

  const contextData = results
    .map((r, i) => `[Source ${i + 1}: ${r.title}]\n${r.snippet}`)
    .join("\n\n");

  let summary = "";
  try {
    const prompt = `You are JARVIS AI assistant. Summarize the key facts found for query: "${query}".

Web Search Results:
${contextData}

Instructions:
- Write a clear, factual, and concise summary (2-3 bullet points or a short paragraph).
- Highlight key numbers, facts, definitions, or recent developments using WhatsApp bold (*word*).
- No fluff, no robotic greetings.`;

    summary = await queryOllama(prompt, 0.3, 200);
    summary = summary
      .replace(/^#{1,6}\s*/gm, "")
      .replace(/\*\*(.+?)\*\*/g, "*$1*")
      .replace(/^\s*[-*]\s+/gm, "• ")
      .trim();
  } catch (llmErr) {
    console.warn("LLM summary generation failed, using snippets fallback:", llmErr.message);
    summary = results.map(r => `• *${r.title}*: ${r.snippet}`).join("\n");
  }

  // Format sources list (deduplicated)
  const seenUrls = new Set();
  const validSources = [];
  for (const r of results) {
    if (r.url && !seenUrls.has(r.url)) {
      seenUrls.add(r.url);
      validSources.push(r);
    }
  }

  let sourcesList = "";
  if (validSources.length > 0) {
    sourcesList = "\n\n🔗 *Sources:*\n" + validSources.map((r, idx) => `${idx + 1}. ${r.title} — ${r.url}`).join("\n");
  }

  return `🔍 *Results for '${query}':*\n\n${summary}${sourcesList}`;
}

module.exports = { searchWeb, summarizeResults, cleanText };
