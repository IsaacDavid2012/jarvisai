const { exec, execSync } = require("child_process");
const { queryOllama } = require("./ollama");
const { checkServers } = require("./server_health");
const { getSystemStatusReport } = require("./system_monitor");
const db = require("./db");

const SECURITY_PIN = process.env.JARVIS_PIN || "1234";

// Pending confirmations state map: chatId -> { type, target, command, expiresAt }
const pendingConfirmations = new Map();

// PIN attempt tracking: chatId -> { failedAttempts: number, lockedUntil: number }
const pinLockouts = new Map();

/**
 * Redacts passwords, API keys, bearer tokens, and connection strings from output.
 */
function redactSensitiveData(text) {
  if (!text) return "";
  return text
    // Passwords, tokens, keys, secrets
    .replace(/(password|passwd|pass|pwd|secret|token|apikey|api_key|access_token|auth_token|credentials)\s*[:=]\s*['"]?([^\s'"&;,]+)['"]?/gi, '$1=[REDACTED]')
    // Bearer tokens
    .replace(/Bearer\s+[a-zA-Z0-9_\-\.]+/gi, 'Bearer [REDACTED]')
    // Private keys
    .replace(/-----BEGIN[A-Z\s]+PRIVATE KEY-----[\s\S]*?-----END[A-Z\s]+PRIVATE KEY-----/g, '[PRIVATE KEY REDACTED]')
    // Database connection URLs
    .replace(/(https?|postgres|postgresql|mysql|mongodb|redis):\/\/([^:]+):([^@]+)@/gi, '$1://$2:[REDACTED]@');
}

/**
 * Checks if a command attempts to view secrets, keys, or passwords.
 */
function isCredentialPathBlocked(cmd) {
  const lower = cmd.toLowerCase();
  const forbidden = [
    ".env", "id_rsa", "id_ed25519", "/etc/shadow", "vaultwarden/data",
    "wp-config.php", "creds.json"
  ];
  return forbidden.some(f => lower.includes(f));
}

/**
 * Finds matching Docker container with exact matching and unambiguous prefix check.
 */
async function findContainer(query) {
  try {
    const clean = query.toLowerCase().trim().replace(/[^a-z0-9_-]/g, "");
    if (!clean) return null;
    const out = execSync(`docker ps -a --format "{{.ID}}\\t{{.Names}}\\t{{.Status}}\\t{{.Ports}}"`, { timeout: 3000 }).toString().trim();
    if (!out) return null;
    const lines = out.split("\n");
    const containers = lines.map(line => {
      const [id, name, status, ports] = line.split("\t");
      return { id, name, status, ports: ports || "Internal only" };
    });

    // 1. Exact match priority
    const exact = containers.find(c => c.name.toLowerCase() === clean);
    if (exact) return exact;

    // 2. Strict word boundary prefix/suffix match (e.g. "jellyfin" -> "jellyfin-xyz")
    const matches = containers.filter(c => {
      const n = c.name.toLowerCase();
      return n === clean || n.startsWith(`${clean}-`) || n.startsWith(`${clean}_`) || n.endsWith(`-${clean}`) || n.endsWith(`_${clean}`);
    });

    if (matches.length === 1) return matches[0];
    if (matches.length > 1) {
      return { ambiguous: true, matches: matches.map(m => m.name) };
    }

    return null;
  } catch (e) {
    return null;
  }
}

/**
 * Reports status of a specific container in 1 clean line / card.
 */
async function checkContainerStatus(query) {
  const container = await findContainer(query);
  if (!container) {
    return `❌ *CONTAINER NOT FOUND*\n───────────────\nCould not find a container matching \`${query}\`.\nType \`docker ps\` to see all containers.`;
  }
  if (container.ambiguous) {
    return `🤔 *MULTIPLE CONTAINERS MATCH*\n───────────────\nQuery \`${query}\` matched multiple containers:\n${container.matches.map(m => `• \`${m}\``).join("\n")}\n\nPlease specify the exact container name.`;
  }
  const isUp = container.status.toLowerCase().startsWith("up");
  const icon = isUp ? "🟢" : "🔴";
  return `🐳 *CONTAINER STATUS*\n───────────────\n${icon} *${container.name}*\n📊 *State:* \`${container.status}\`\n🔌 *Ports:* \`${container.ports}\``;
}

/**
 * Returns only the last few error lines from a container's log with password/token redaction.
 */
async function getContainerErrorLogs(query) {
  const container = await findContainer(query);
  if (!container) {
    return `❌ *CONTAINER NOT FOUND*\n───────────────\nCould not find a container matching \`${query}\`.`;
  }
  if (container.ambiguous) {
    return `🤔 *MULTIPLE CONTAINERS MATCH*\n───────────────\nQuery \`${query}\` matched multiple containers:\n${container.matches.map(m => `• \`${m}\``).join("\n")}\n\nPlease specify the exact container name.`;
  }

  try {
    const cmd = `docker logs --tail 150 ${container.name} 2>&1 | grep -iE 'error|fatal|fail|exception|panic' | tail -n 6`;
    const rawOut = execSync(cmd, { timeout: 5000 }).toString().trim();
    const redactedOut = redactSensitiveData(rawOut);

    if (!redactedOut) {
      return `🟢 *${container.name.toUpperCase()} LOGS*\n───────────────\nNo recent error entries found in the last 150 log lines.\nService is healthy.`;
    }
    return `⚠️ *${container.name.toUpperCase()} RECENT ERRORS*\n───────────────\n\`\`\`\n${redactedOut}\n\`\`\`\n\n_Showing only error/fatal lines with credential redaction._`;
  } catch (e) {
    return `🟢 *${container.name.toUpperCase()} LOGS*\n───────────────\nNo recent error entries found in the last 150 log lines.`;
  }
}

/**
 * Stages a restart confirmation for a container or service.
 */
function requestRestart(chatId, targetName, fullName) {
  pendingConfirmations.set(chatId, {
    type: "restart",
    target: fullName,
    command: `docker restart ${fullName}`,
    expiresAt: Date.now() + 60000
  });
  return `⚠️ *RESTART CONFIRMATION*\n───────────────\nAre you sure you want to restart *${targetName}* (\`${fullName}\`)?\n\n👉 Reply *yes* within 60 seconds to proceed, or *no* to cancel.\n_Request automatically expires in 60s._`;
}

/**
 * Stages a high-impact operation requiring PIN authorization.
 */
function requestSensitiveAction(chatId, actionName, command) {
  pendingConfirmations.set(chatId, {
    type: "sensitive",
    target: actionName,
    command: command,
    expiresAt: Date.now() + 60000
  });
  return `🔒 *SECURITY PIN REQUIRED*\n───────────────\nAction: *${actionName}*\nThis is a high-impact system operation.\n\n👉 Reply *PIN <your-pin>* within 60 seconds to authorize, or *cancel*.\n_Request automatically expires in 60s._`;
}

/**
 * Evaluates user response against any pending confirmation or PIN challenge.
 * Enforces lockout after 3 failed PIN attempts for 15 minutes.
 */
async function handlePendingConfirmation(chatId, userText) {
  // Check active lockout first
  const lockout = pinLockouts.get(chatId) || { failedAttempts: 0, lockedUntil: 0 };
  if (Date.now() < lockout.lockedUntil) {
    const remainingSec = Math.ceil((lockout.lockedUntil - Date.now()) / 1000);
    const remainingMins = Math.ceil(remainingSec / 60);
    return `🚫 *PIN LOCKOUT ACTIVE*\n───────────────\nToo many failed attempts. PIN authorization is locked for ${remainingMins} more minute(s).\nAll sensitive operations are temporarily frozen.`;
  }

  const pending = pendingConfirmations.get(chatId);
  if (!pending) return null;

  if (Date.now() > pending.expiresAt) {
    pendingConfirmations.delete(chatId);
    return `⏱️ *CONFIRMATION TIMED OUT*\n───────────────\nPrevious pending action for *${pending.target}* has expired.`;
  }

  const clean = userText.trim().toLowerCase();
  if (clean === "no" || clean === "cancel" || clean === "abort") {
    pendingConfirmations.delete(chatId);
    return `🚫 *ACTION CANCELLED*\n───────────────\nOperation for *${pending.target}* has been cancelled.`;
  }

  if (pending.type === "restart") {
    if (clean === "yes" || clean === "confirm" || clean === "y" || clean.startsWith("pin ")) {
      pendingConfirmations.delete(chatId);
      try {
        const sudoPass = process.env.SUDO_PASSWORD || "";
        const runCmd = sudoPass ? `echo ${sudoPass} | sudo -S ${pending.command}` : pending.command;
        execSync(runCmd, { timeout: 20000 });
        await db.logAction("RESTART_SERVICE", pending.target, "SUCCESS");
        return `✅ *SERVICE RESTARTED*\n───────────────\n*${pending.target}* has been restarted successfully.`;
      } catch (err) {
        await db.logAction("RESTART_SERVICE", pending.target, "FAILED");
        return `❌ *RESTART FAILED*\n───────────────\nError restarting *${pending.target}*: ${err.message}`;
      }
    }
  }

  if (pending.type === "sensitive") {
    const pinMatch = userText.match(/(?:pin\s*[:=]?\s*)?(\d{4,8})/i);
    if (pinMatch) {
      const enteredPin = pinMatch[1];
      if (enteredPin === SECURITY_PIN) {
        // Reset failed attempts on success
        lockout.failedAttempts = 0;
        lockout.lockedUntil = 0;
        pinLockouts.set(chatId, lockout);
        pendingConfirmations.delete(chatId);

        try {
          const sudoPass = process.env.SUDO_PASSWORD || "";
          const runCmd = sudoPass ? `echo ${sudoPass} | sudo -S ${pending.command}` : pending.command;
          execSync(runCmd, { timeout: 20000 });
          await db.logAction("SENSITIVE_ACTION", `${pending.target}: ${pending.command}`, "SUCCESS");
          return `✅ *AUTHORIZED ACTION COMPLETED*\n───────────────\nAction *${pending.target}* executed successfully.`;
        } catch (err) {
          await db.logAction("SENSITIVE_ACTION", `${pending.target}: ${pending.command}`, "FAILED");
          return `❌ *ACTION FAILED*\n───────────────\nError executing *${pending.target}*: ${err.message}`;
        }
      } else {
        lockout.failedAttempts += 1;
        if (lockout.failedAttempts >= 3) {
          lockout.lockedUntil = Date.now() + 15 * 60 * 1000; // 15-minute lockout
          lockout.failedAttempts = 0;
          pinLockouts.set(chatId, lockout);
          pendingConfirmations.delete(chatId); // Immediately drop the pending action
          await db.logAction("PIN_SECURITY_LOCKOUT", `Chat ${chatId} locked out after 3 failed PIN attempts`, "FAILED");
          return `🚫 *SECURITY LOCKOUT (3/3 FAILED ATTEMPTS)*\n───────────────\nIncorrect PIN entered 3 times. PIN authorization is locked for 15 minutes.\nPending action for *${pending.target}* has been aborted.\nIncident logged.`;
        } else {
          pinLockouts.set(chatId, lockout);
          const remaining = 3 - lockout.failedAttempts;
          return `❌ *INVALID PIN*\n───────────────\nIncorrect security PIN (${lockout.failedAttempts}/3 attempts).\nYou have ${remaining} attempt(s) remaining before a 15-minute lockout.\nReply with the correct PIN or type *cancel*.`;
        }
      }
    }
  }

  return null;
}

/**
 * Builds a unified, complete Infrastructure Status report.
 */
async function getComprehensiveInfrastructureStatus() {
  const baseReport = getSystemStatusReport();
  let tailscaleNodes = "N/A";
  let tunnelStatus = "N/A";
  let internetPing = "N/A";
  let dockerCount = "0";

  try {
    const out = execSync("tailscale status --peers=false | head -n 1", { timeout: 2000 }).toString().trim();
    tailscaleNodes = out ? "🟢 Connected" : "🔴 Offline";
  } catch (e) {
    tailscaleNodes = "🔴 Offline";
  }

  try {
    const tunnel = execSync("systemctl is-active cloudflared", { timeout: 2000 }).toString().trim();
    tunnelStatus = tunnel === "active" ? "🟢 Active (Online)" : `🔴 ${tunnel}`;
  } catch (e) {
    tunnelStatus = "🔴 Inactive";
  }

  try {
    const pingRes = execSync("ping -c 1 -W 2 1.1.1.1 | grep 'time='", { timeout: 3000 }).toString().trim();
    const timeMatch = pingRes.match(/time=([\d.]+)\s*ms/);
    internetPing = timeMatch ? `🟢 ${timeMatch[1]} ms` : "🟢 Connected";
  } catch (e) {
    internetPing = "🔴 Packet Loss";
  }

  try {
    dockerCount = execSync("docker ps -q | wc -l", { timeout: 2000 }).toString().trim();
  } catch (e) {}

  return `${baseReport}\n\n` +
    `🌐 *NETWORK & TUNNELS:*\n` +
    `• *Tailscale Mesh:* ${tailscaleNodes}\n` +
    `• *Cloudflare Tunnel:* ${tunnelStatus}\n` +
    `• *Internet Latency:* ${internetPing}\n` +
    `• *Docker Active:* \`${dockerCount} containers running\``;
}

/**
 * Maps natural language system requests to shell commands.
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
  if (/^(docker|docker ps|docker containers|containers|running containers|show containers|what containers|check docker|list containers)$/i.test(lower)) {
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
 * Executes a shell command on the host system with safety filters & AI summary.
 */
async function handleExecCommand(userMsg, chatId = "default") {
  if (/(system status|resource status|hardware status|check resources|resource monitor|system health|check system|server status)/i.test(userMsg)) {
    return getComprehensiveInfrastructureStatus();
  }

  if (/(server health|check servers|servers status|ping servers)/i.test(userMsg)) {
    const healthResults = await checkServers();
    let card = `🖥️ *INFRASTRUCTURE HEALTH CHECK*\n───────────────\n`;
    healthResults.forEach((s) => {
      card += `• *${s.name}:* ${s.status}\n`;
    });
    return card.trim();
  }

  const naturalMapping = resolveNaturalCommand(userMsg);
  let command = "";
  let isNaturalQuery = false;
  let queryTitle = "";

  if (naturalMapping && !userMsg.startsWith("!") && !userMsg.startsWith("/")) {
    command = naturalMapping.command;
    isNaturalQuery = true;
    queryTitle = naturalMapping.title;
  } else {
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

  const STRICT_ALLOWLIST = new Map([
    ["uptime", "uptime"],
    ["top", "top -b -n 1 | head -n 25"],
    ["free", "free -h"],
    ["free -m", "free -m"],
    ["free -h", "free -h"],
    ["df", "df -h -x tmpfs -x devtmpfs -x squashfs"],
    ["df -h", "df -h -x tmpfs -x devtmpfs -x squashfs"],
    ["docker ps", "docker ps --format \"table {{.Names}}\\t{{.Status}}\\t{{.Ports}}\""],
    ["docker ps -a", "docker ps -a --format \"table {{.Names}}\\t{{.Status}}\\t{{.Ports}}\""],
    ["ip a", "ip -br a"],
    ["ip addr", "ip -br a"],
    ["ip -br a", "ip -br a"],
    ["lsblk", "lsblk"],
    ["tailscale status", "tailscale status --peers=false"],
    ["systemctl status cloudflared", "systemctl status cloudflared --no-pager -n 5"],
    ["systemctl status ollama", "systemctl status ollama --no-pager -n 5"],
    ["systemctl status jarvisai", "systemctl status jarvisai --no-pager -n 5"],
    ["systemctl status jarvis-sip", "systemctl status jarvis-sip --no-pager -n 5"],
    ["systemctl status asterisk", "systemctl status asterisk --no-pager -n 5"]
  ]);

  const cleanCmd = command.toLowerCase().trim();

  // Intercept Restart commands for Confirmation
  if (/^(docker\s+)?restart\s+([a-zA-Z0-9_-]+)/i.test(command) || /^systemctl\s+restart\s+([a-zA-Z0-9_-]+)/i.test(command)) {
    const match = command.match(/restart\s+([a-zA-Z0-9_-]+)/i);
    const target = match ? match[1] : command;
    const matchedContainer = await findContainer(target);
    if (!matchedContainer) {
      return `❌ *SERVICE NOT FOUND*\n───────────────\nCannot restart unknown service \`${target}\`.`;
    }
    return requestRestart(chatId, target, matchedContainer.name);
  }

  // Intercept Destructive / Stop commands for PIN challenge
  if (/^(docker\s+)?(stop|rm|kill|prune)\b/i.test(command)) {
    const match = command.match(/(?:stop|rm|kill)\s+([a-zA-Z0-9_-]+)/i);
    const target = match ? match[1] : "";
    if (target) {
      const matchedContainer = await findContainer(target);
      if (!matchedContainer) {
        return `❌ *SERVICE NOT FOUND*\n───────────────\nCannot perform action on unknown service \`${target}\`.`;
      }
      return requestSensitiveAction(chatId, `docker stop ${matchedContainer.name}`, `docker stop ${matchedContainer.name}`);
    }
    return requestSensitiveAction(chatId, command, command);
  }

  // If not a pre-resolved natural command and not on the strict allowlist, BLOCK IT
  if (!isNaturalQuery && !STRICT_ALLOWLIST.has(cleanCmd)) {
    return `🛡️ *SECURITY POLICY ENFORCED*\n───────────────\nArbitrary shell execution is disabled to protect system integrity.\n\n✅ *Permitted Commands:*\n• System status / health\n• \`uptime\`, \`free -h\`, \`df -h\`, \`docker ps\`\n• Service checks: \`Is <service> running?\`, \`Show <service> logs\`\n• Restart request: \`Restart <service>\` (requires confirmation)`;
  }

  if (STRICT_ALLOWLIST.has(cleanCmd)) {
    command = STRICT_ALLOWLIST.get(cleanCmd);
  }

  // Credential Protection defense-in-depth
  if (isCredentialPathBlocked(command)) {
    return `🛡️ *ACCESS BLOCKED BY SECURITY POLICY*\n───────────────\nAttempted access to secret keys, credential files, or sensitive vaults was blocked.`;
  }

  // Handle sudo automatically
  let execCommand = command;
  const displayCommand = command;
  const sudoPass = process.env.SUDO_PASSWORD || "";
  if (/\bsudo\s+/i.test(command) && sudoPass) {
    execCommand = command.replace(/\bsudo\s+/gi, `echo ${sudoPass} | sudo -S `);
  }

  const startTime = Date.now();
  const maxBuffer = 1024 * 1024;
  const timeoutMs = 30000;

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
      if (cleanStdout) combinedOutput += cleanStdout;
      if (cleanStderr) {
        if (combinedOutput) combinedOutput += "\n\n--- STDERR ---\n";
        combinedOutput += cleanStderr;
      }
      if (!combinedOutput) combinedOutput = "(No output returned)";
      combinedOutput = redactSensitiveData(combinedOutput);

      // Audit Log
      await db.logAction("EXEC_COMMAND", displayCommand, exitCode === 0 ? "SUCCESS" : "FAILED");

      // Truncate raw output if too long for WhatsApp
      const maxLen = 3000;
      let truncatedNotice = "";
      if (combinedOutput.length > maxLen) {
        const excess = combinedOutput.length - maxLen;
        combinedOutput = combinedOutput.substring(0, maxLen);
        truncatedNotice = `\n\n⚠️ _Raw output truncated (${excess} characters omitted)._`;
      }

      const headerTitle = isNaturalQuery ? `💻 *SYSTEM CHECK: ${queryTitle.toUpperCase()}*` : `💻 *REMOTE EXECUTION*`;
      const queryLine = isNaturalQuery ? `📥 *Request:* "${userMsg}"\n⚙️ *Command:* \`${displayCommand}\`\n` : `📥 *Command:* \`${displayCommand}\`\n`;

      const outputText = `${headerTitle}\n───────────────\n${queryLine}⏱️ *Duration:* \`${formattedDuration}\` | ${statusHeader}\n\n📊 *Output:*\n\`\`\`\n${combinedOutput}\n\`\`\`${truncatedNotice}`;
      resolve(outputText);
    });
  });
}

module.exports = {
  handleExecCommand,
  resolveNaturalCommand,
  checkContainerStatus,
  getContainerErrorLogs,
  requestRestart,
  requestSensitiveAction,
  handlePendingConfirmation,
  getComprehensiveInfrastructureStatus,
  findContainer,
  redactSensitiveData
};
