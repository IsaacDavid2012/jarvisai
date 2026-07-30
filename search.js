const axios = require("axios");
const fs = require("fs");

let puppeteerCore = null;
try {
  puppeteerCore = require("puppeteer-core");
} catch (e) {
  // Option fallback if puppeteer-core not directly top-level
}

/**
 * Fine-tuned Multi-provider Web Search Module
 * Priority: Puppeteer Headless DDG (Primary Organic) > DDG Instant Answer API > Wikipedia
 */
async function searchWeb(query, client = null) {
  console.log(`🌐 Searching web for: "${query}"`);
  const results = [];
  const cleanQuery = query.trim();
  if (!cleanQuery) return results;

  // 1. PRIMARY: Puppeteer Headless Browser Search on DuckDuckGo HTML
  try {
    let browser = null;
    let shouldCloseBrowser = false;

    if (client && client.pupBrowser && client.pupBrowser.isConnected && typeof client.pupBrowser.newPage === "function") {
      browser = client.pupBrowser;
    } else if (puppeteerCore) {
      const chromePath = process.env.PUPPETEER_EXECUTABLE_PATH || (
        fs.existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : (
          fs.existsSync("/usr/bin/chromium-browser") ? "/usr/bin/chromium-browser" : "/usr/bin/google-chrome-stable"
        )
      );

      if (fs.existsSync(chromePath)) {
        browser = await puppeteerCore.launch({
          executablePath: chromePath,
          headless: "new",
          args: [
            "--no-sandbox",
            "--disable-setuid-sandbox",
            "--disable-dev-shm-usage",
            "--disable-accelerated-2d-canvas",
            "--no-first-run",
            "--no-zygote",
            "--disable-gpu"
          ]
        });
        shouldCloseBrowser = true;
      }
    }

    if (browser) {
      const page = await browser.newPage();
      await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36");

      await page.goto("https://html.duckduckgo.com/html/?q=" + encodeURIComponent(cleanQuery), {
        waitUntil: "domcontentloaded",
        timeout: 10000
      });

      const items = await page.evaluate(() => {
        const parsed = [];
        const blocks = document.querySelectorAll(".result");
        blocks.forEach((block) => {
          const titleEl = block.querySelector(".result__title");
          const snippetEl = block.querySelector(".result__snippet");
          const urlEl = block.querySelector(".result__url");
          if (titleEl && snippetEl) {
            let title = titleEl.innerText.trim();
            let snippet = snippetEl.innerText.trim();
            let rawUrl = urlEl ? (urlEl.getAttribute("href") || urlEl.innerText.trim()) : "";

            // Exclude ads
            if (!title.endsWith(" AD") && !rawUrl.includes("ad_domain")) {
              parsed.push({ title, snippet, rawUrl });
            }
          }
        });
        return parsed;
      });

      await page.close();
      if (shouldCloseBrowser && browser.close) {
        await browser.close();
      }

      for (const item of items) {
        let cleanUrl = item.rawUrl;
        const match = item.rawUrl.match(/uddg=([^&]+)/);
        if (match) {
          cleanUrl = decodeURIComponent(match[1]);
        }
        const title = cleanText(item.title);
        const snippet = cleanText(item.snippet);
        if (title && snippet) {
          results.push({ title, snippet, url: cleanUrl });
        }
        if (results.length >= 5) break;
      }

      if (results.length > 0) {
        console.log(`🌐 Puppeteer web search returned ${results.length} organic results`);
      }
    }
  } catch (e) {
    console.warn("Puppeteer web search fallback notice:", e.message);
  }

  // 2. FALLBACK 1: DuckDuckGo Instant Answer API (For quick facts / entity summaries)
  if (results.length === 0) {
    try {
      const ddgRes = await axios.get(`https://api.duckduckgo.com/?q=${encodeURIComponent(cleanQuery)}&format=json&no_html=1`, { timeout: 5000 });
      if (ddgRes.data && ddgRes.data.AbstractText) {
        results.push({
          title: ddgRes.data.Heading || cleanQuery,
          snippet: cleanText(ddgRes.data.AbstractText),
          url: ddgRes.data.AbstractURL || ""
        });
      }
      if (ddgRes.data && ddgRes.data.RelatedTopics && Array.isArray(ddgRes.data.RelatedTopics)) {
        ddgRes.data.RelatedTopics.slice(0, 3).forEach(t => {
          if (t.Text && typeof t.Text === "string") {
            results.push({
              title: "Related Result",
              snippet: cleanText(t.Text),
              url: t.FirstURL || ""
            });
          }
        });
      }
    } catch (e) {
      // Silently proceed
    }
  }

  // 3. FALLBACK 2: Wikipedia API (For background facts, history, definitions)
  if (results.length < 2) {
    try {
      const wikiRes = await axios.get(
        `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(cleanQuery)}&format=json`,
        {
          headers: { "User-Agent": "JarvisAI/1.0 (isaac@creativeclicks.local)" },
          timeout: 5000
        }
      );
      if (wikiRes.data && wikiRes.data.query && wikiRes.data.query.search) {
        wikiRes.data.query.search.slice(0, 4 - results.length).forEach(item => {
          const cleanSnippet = cleanText(item.snippet);
          if (cleanSnippet) {
            results.push({
              title: `Wikipedia: ${item.title}`,
              snippet: cleanSnippet,
              url: `https://en.wikipedia.org/wiki/${encodeURIComponent(item.title.replace(/\s+/g, "_"))}`
            });
          }
        });
      }
    } catch (e) {
      // Silently proceed
    }
  }

  return results;
}

function cleanText(text) {
  if (!text) return "";
  return text
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

module.exports = { searchWeb };
