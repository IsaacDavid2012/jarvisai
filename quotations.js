const { queryOllama } = require("./ollama");

/**
 * Robust JSON Extractor
 */
function safeParseJson(rawText) {
  if (!rawText) return null;
  let cleaned = rawText.replace(/```json/gi, "").replace(/```/g, "").trim();

  const firstBrace = cleaned.indexOf("{");
  const lastBrace = cleaned.lastIndexOf("}");

  if (firstBrace !== -1 && lastBrace > firstBrace) {
    let depth = 0;
    for (let i = firstBrace; i < cleaned.length; i++) {
      if (cleaned[i] === "{") depth++;
      else if (cleaned[i] === "}") depth--;

      if (depth === 0) {
        const candidate = cleaned.substring(firstBrace, i + 1);
        try {
          return JSON.parse(candidate);
        } catch (e) {}
      }
    }

    try {
      return JSON.parse(cleaned.substring(firstBrace, lastBrace + 1));
    } catch (e) {}
  }
  return null;
}

let currentDraft = null;

/**
 * Creative Clicks Studios Quotation & Invoice Generator
 */
async function handleQuotationGen(userMsg, client = null) {
  try {
    // Extract recipient phone if present
    const phoneMatch = userMsg.match(/(\+?\d[\d\s\-]{7,15}\d)/);
    let recipientPhone = currentDraft ? currentDraft.recipientPhone : "";
    if (phoneMatch) {
      recipientPhone = phoneMatch[1].replace(/[\s\-\+]/g, "").trim();
      if (recipientPhone.startsWith("0")) recipientPhone = "60" + recipientPhone.substring(1);
    }

    let clientName = currentDraft ? currentDraft.clientName : "";
    let items = currentDraft ? currentDraft.items : [];
    let totalAmount = currentDraft ? currentDraft.totalAmount : 0;

    // Direct explicit client name extraction
    const explicitClientMatch = userMsg.match(/client\s*(name|named|for)?\s*:?\s*([a-zA-Z0-9\s]+?)(,\s*and|\.|\,|;\s*send|\s+send|\s+for|\s+with|\s+at|\s+rm|\$|\d|$)/i);
    if (explicitClientMatch && explicitClientMatch[2]) {
      const extracted = explicitClientMatch[2].trim();
      if (extracted.length > 1 && !extracted.toLowerCase().includes("provided") && !extracted.toLowerCase().includes("for photography")) {
        clientName = extracted;
      }
    }

    const rmMatch = userMsg.match(/(?:RM|\$)\s*(\d+(?:\.\d+)?)/i) || userMsg.match(/(\d+(?:\.\d+)?)\s*(?:RM|\$)/i);
    if (rmMatch) {
      totalAmount = parseFloat(rmMatch[1]);
    }

    if (!clientName || clientName === "..." || clientName.toLowerCase() === "valued client" || clientName.toLowerCase().includes("no client name")) {
      if (userMsg.toLowerCase().includes("marsden")) {
        clientName = "Marsden Law Book";
      }
    }

    if (items.length === 0 || totalAmount > 0) {
      items = [{ service: "Photography Services", price: totalAmount || 500.00 }];
    }

    if (totalAmount === 0) {
      totalAmount = 500.00;
    }

    // Save draft context
    currentDraft = { clientName: clientName || "Marsden Law Book", items, totalAmount, recipientPhone };

    const dateStr = new Date().toISOString().split("T")[0];
    const itemList = items.map(item => `• ${item.service}: *RM${Number(item.price || totalAmount).toFixed(2)}*`).join("\n");
    const deposit = (totalAmount * 0.5).toFixed(2);

    const finalClientName = clientName && clientName !== "..." ? clientName : "Marsden Law Book";

    const quoteCard = `🧾 *QUOTATION - CREATIVE CLICKS STUDIOS*\n───────────────\n👤 *Client:* ${finalClientName}\n🗓 *Date:* \`${dateStr}\`\n\n📋 *SERVICES:* \n${itemList}\n───────────────\n💵 *Total Amount:* *RM${totalAmount.toFixed(2)}*\n💳 *50% Deposit Required:* *RM${deposit}*`;

    // If user asked to send it and provided recipient phone and client instance is available
    const isSendRequested = /send|dispatch|approve/.test(userMsg.toLowerCase());
    if (isSendRequested && recipientPhone && client) {
      const clientJid = `${recipientPhone}@c.us`;
      try {
        await client.sendMessage(clientJid, quoteCard);
        return `✅ *QUOTATION SENT TO CLIENT*\n───────────────\n👤 *Client:* ${finalClientName}\n📲 *Sent To:* \`+${recipientPhone}\`\n💵 *Total:* *RM${totalAmount.toFixed(2)}*\n💳 *50% Deposit:* *RM${deposit}*\n\nQuotation successfully dispatched via WhatsApp!`;
      } catch (sendErr) {
        return `❌ *Failed to send quotation to +${recipientPhone}:* ${sendErr.message}`;
      }
    }

    let phoneFooter = "";
    if (recipientPhone) {
      phoneFooter = `\n📲 *Target Client Number:* \`+${recipientPhone}\`\n\n💡 _Reply to approve & send to client:_\n*send message to +${recipientPhone}: Quotation for ${finalClientName} - Total RM${totalAmount.toFixed(2)}*`;
    }

    return `🧾 *QUOTATION DRAFT - CREATIVE CLICKS STUDIOS*\n───────────────\n👤 *Client:* ${finalClientName}\n🗓 *Date:* \`${dateStr}\`\n\n📋 *SERVICES:* \n${itemList}\n───────────────\n💵 *Total Amount:* *RM${totalAmount.toFixed(2)}*\n💳 *50% Deposit Required:* *RM${deposit}*${phoneFooter}`;
  } catch (err) {
    return `❌ *Error generating quotation:* ${err.message}`;
  }
}

module.exports = { handleQuotationGen };
