const { exec } = require("child_process");
const { queryOllama } = require("./ollama");

/**
 * Maps natural language system requests to shell commands.
 * @param {string} msg 
 * @returns {object|null}
 */
function resolveNaturalCommand(msg) {
  const lower = msg.toLowerCase().trim();

  // Storage / Disk Space
  if (/(storage|disk space|disk usage|free space|how much space|hard drive|drive space|how much storage|check storage)/i.test(lower)) {
    return { command: "df -h -x tmpfs -x devtmpfs -x squashfs", title: "Storage Check" };
  }

  // RAM / Memory
  if (/(ram|memory|free ram|free memory|ram usage|memory usage|how much memory|check ram|check memory)/i.test(lower)) {
    return { command: "free -h", title: "RAM / Memory Check" };
  }

  // Docker Containers
  if (/(docker|containers|running containers|show containers|what containers|check docker)/i.test(lower)) {
    return { command: 'docker ps --format "table {{.Names}}\\t{{.Status}}\\t{{.Ports}}"', title: "Docker Containers Check" };
  }

  // CPU / System Load / Uptime
  if (/(cpu|system load|cpu load|cpu usage|how busy|server load|check cpu|uptime)/i.test(lower)) {
    return { command: "uptime", title: "CPU & System Load" };
  }

  // Disk Partitions
  if (/(partitions|list drives|show disks|list disks|block devices|disk partitions|check partitions)/i.test(lower)) {
    return { command: "lsblk", title: "Disk Partitions Check" };
  }

  // Network / IP
  if (/(my ip|ip address|network interfaces|check ip)/i.test(lower)) {
    return { command: "ip -br a", title: "Network Interfaces Check" };
  }

  return null;
}

/**
 * Executes a shell command on the host system and returns formatted WhatsApp response.
 * @param {string} userMsg Full user input message
 * @returns {Promise<string>} Formatted response string for WhatsApp
 */
async function handleExecCommand(userMsg) {
  const naturalMapping = resolveNaturalCommand(userMsg);
  let command = "";
  let isNaturalQuery = false;
  let queryTitle = "";

  if (naturalMapping && !userMsg.startsWith("!") && !userMsg.startsWith("/")) {
    command = naturalMapping.command;
    isNaturalQuery = true;
    queryTitle = naturalMapping.title;
  } else {
    // Strip trigger prefix if present
    command = userMsg
      .replace(/^(!|\/)(exec|cmd|run|bash|sh)\s*/i, "")
      .replace(/^(run command|execute command|run shell|exec command|system command|shell command|run bash)\s*:?\s*/i, "")
      .trim();

    if (!command && userMsg.trim()) {
      command = userMsg.trim();
    }
  }

  if (!command) {
    return `❌ *REMOTE COMMAND EXECUTION*\n───────────────\nPlease specify a command to execute.\n\n💡 *Examples:*\n• \`!exec uptime\`\n• \`!cmd df -h\`\n• \`!exec free -m\`\n• \`!exec docker ps\``;
  }

  // Guard against interactive commands that hang indefinitely without flags
  const lowerCmd = command.toLowerCase().trim();
  if (lowerCmd === "top") {
    command = "top -b -n 1"; // Auto-convert top to batch mode
  } else if (/^(htop|vim|vi|nano|less|more|man)($|\s)/i.test(lowerCmd)) {
    const binary = lowerCmd.split(/\s+/)[0];
    return `⚠️ *INTERACTIVE COMMAND BLOCKED*\n───────────────\nCommand \`${binary}\` requires an interactive TUI terminal and cannot be run via WhatsApp.\n\n💡 Try non-interactive flags or alternative commands (e.g. use \`top -b -n 1\` or \`cat <file>\`).`;
  }

  // Handle sudo automatically if password configured
  let execCommand = command;
  const displayCommand = command;
  const sudoPass = process.env.SUDO_PASSWORD || "";
  if (/\bsudo\s+/i.test(command) && sudoPass) {
    execCommand = command.replace(/\bsudo\s+/gi, `echo ${sudoPass} | sudo -S `);
  }

  const startTime = Date.now();
  const maxBuffer = 1024 * 1024; // 1 MB
  const timeoutMs = 30000; // 30 seconds limit

  return new Promise((resolve) => {
    exec(execCommand, { timeout: timeoutMs, maxBuffer, cwd: process.cwd() }, async (error, stdout, stderr) => {
      const durationMs = Date.now() - startTime;
      const formattedDuration = durationMs > 1000 ? `${(durationMs / 1000).toFixed(2)}s` : `${durationMs}ms`;

      const exitCode = error ? (error.code !== undefined ? error.code : 1) : 0;
      const isTimeout = error && (error.killed || error.signal === "SIGTERM");

      if (isTimeout) {
        return resolve(`⏱️ *COMMAND TIMED OUT*\n───────────────\n📥 *Command:* \`${displayCommand}\`\n⏳ Timed out after 30 seconds.`);
      }

      const cleanStdout = (stdout || "").trim();
      let cleanStderr = (stderr || "")
        .replace(/^\[sudo\] password for [^:]+:\s*/gm, "")
        .replace(/^\[sudo: authenticate\] Password:\s*/gm, "")
        .trim();

      const statusHeader = exitCode === 0 ? `🟢 *Exit Code:* \`0\`` : `🔴 *Exit Code:* \`${exitCode}\``;

      let combinedOutput = "";
      if (cleanStdout) {
        combinedOutput += cleanStdout;
      }
      if (cleanStderr) {
        if (combinedOutput) combinedOutput += "\n\n--- STDERR ---\n";
        combinedOutput += cleanStderr;
      }

      if (!combinedOutput) {
        combinedOutput = "(No output returned)";
      }

      // Generate AI Summary using Ollama if output is informative and exit code is 0
      let aiSummaryText = "";
      if (exitCode === 0 && combinedOutput && combinedOutput !== "(No output returned)" && combinedOutput.length > 30) {
        try {
          const summaryPrompt = `User Command: "${command}"
Command Output:
${combinedOutput.substring(0, 1500)}

Summarize the key facts concisely for the user in 1-2 bullet points. WhatsApp bold format (*word*). No pleasantries.`;

          const summaryPromise = queryOllama(summaryPrompt, 0.2, 100);
          const timeoutPromise = new Promise((res) => setTimeout(() => res(null), 4000));
          const rawSummary = await Promise.race([summaryPromise, timeoutPromise]);

          if (rawSummary && typeof rawSummary === "string" && rawSummary.trim()) {
            let cleanSummary = rawSummary.trim()
              .replace(/^#{1,6}\s*/gm, '')
              .replace(/\*\*(.+?)\*\*/g, '*$1*')
              .replace(/^\s*[-*]\s+/gm, '• ');
            aiSummaryText = `\n\n🧠 *AI Summary:*\n${cleanSummary}`;
          }
        } catch (aiErr) {
          // Graceful fallback if Ollama times out or errors
        }
      }

      // Truncate raw output if too long for WhatsApp (WhatsApp limit ~4096 chars)
      const maxLen = 3000;
      let truncatedNotice = "";
      if (combinedOutput.length > maxLen) {
        const excess = combinedOutput.length - maxLen;
        combinedOutput = combinedOutput.substring(0, maxLen);
        truncatedNotice = `\n\n⚠️ _Raw output truncated (${excess} characters omitted)._`;
      }

      const headerTitle = isNaturalQuery ? `💻 *SYSTEM CHECK: ${queryTitle.toUpperCase()}*` : `💻 *REMOTE EXECUTION*`;
      const queryLine = isNaturalQuery ? `📥 *Request:* "${userMsg}"\n⚙️ *Command:* \`${displayCommand}\`\n` : `📥 *Command:* \`${displayCommand}\`\n`;

      const outputText = `${headerTitle}\n───────────────\n${queryLine}⏱️ *Duration:* \`${formattedDuration}\` | ${statusHeader}${aiSummaryText}\n\n📊 *Output:*\n\`\`\`\n${combinedOutput}\n\`\`\`${truncatedNotice}`;

      resolve(outputText);
    });
  });
}

module.exports = { handleExecCommand, resolveNaturalCommand };
