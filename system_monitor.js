const fs = require("fs");
const { exec, execSync } = require("child_process");
const db = require("./db");

/**
 * System Resource Monitoring & Overload Alert Module for JARVIS
 * 
 * Thresholds:
 * - RAM:
 *     Warning: 80%
 *     Critical: 90%
 * - CPU:
 *     Warning: 85% sustained for 5+ min
 *     Critical: 95% sustained for 2+ min
 * - Disk:
 *     Warning: 85% used
 *     Critical: 95% used
 */

const CONFIG = {
  CHECK_INTERVAL_SEC: 15, // Polling interval in seconds
  ALERT_COOLDOWN_MS: 15 * 60 * 1000, // 15-minute cooldown for repeated identical alerts

  RAM: {
    WARNING: 80,
    CRITICAL: 90
  },
  CPU: {
    WARNING: 85,
    WARNING_SUSTAINED_SEC: 300, // 5 minutes
    CRITICAL: 95,
    CRITICAL_SUSTAINED_SEC: 120 // 2 minutes
  },
  DISK: {
    WARNING: 85,
    CRITICAL: 95
  }
};

let previousCpuStat = null;
let cpuWarningDurationSec = 0;
let cpuCriticalDurationSec = 0;

// Track alert state to prevent spam and handle resolution notifications
const alertState = {
  RAM: { active: false, level: null, lastAlertTime: 0 },
  CPU: { active: false, level: null, lastAlertTime: 0 },
  Disk: { active: false, level: null, lastAlertTime: 0 }
};

/**
 * Reads /proc/stat to calculate CPU time deltas
 */
function readCpuStat() {
  try {
    const stat = fs.readFileSync("/proc/stat", "utf8");
    const firstLine = stat.split("\n")[0];
    const parts = firstLine.trim().split(/\s+/).slice(1).map(Number);
    const idle = parts[3] + (parts[4] || 0); // idle + iowait
    const total = parts.reduce((acc, val) => acc + val, 0);
    return { idle, total };
  } catch (err) {
    return null;
  }
}

/**
 * Calculates current CPU usage percentage based on delta from previous read
 */
function getCpuUsagePercent() {
  const currentStat = readCpuStat();
  if (!currentStat) return 0;

  if (!previousCpuStat) {
    previousCpuStat = currentStat;
    return 0;
  }

  const idleDelta = currentStat.idle - previousCpuStat.idle;
  const totalDelta = currentStat.total - previousCpuStat.total;
  previousCpuStat = currentStat;

  if (totalDelta <= 0) return 0;
  const usage = Math.max(0, Math.min(100, (1 - idleDelta / totalDelta) * 100));
  return parseFloat(usage.toFixed(1));
}

/**
 * Reads memory usage from /proc/meminfo
 */
function getMemoryUsage() {
  try {
    const meminfo = fs.readFileSync("/proc/meminfo", "utf8");
    const totalMatch = meminfo.match(/MemTotal:\s+(\d+)/);
    const availMatch = meminfo.match(/MemAvailable:\s+(\d+)/);

    if (!totalMatch || !availMatch) return { percent: 0, usedGb: "0.00", totalGb: "0.00" };

    const totalKb = parseInt(totalMatch[1], 10);
    const availKb = parseInt(availMatch[1], 10);
    const usedKb = totalKb - availKb;
    const percent = parseFloat(((usedKb / totalKb) * 100).toFixed(1));
    const usedGb = (usedKb / 1024 / 1024).toFixed(2);
    const totalGb = (totalKb / 1024 / 1024).toFixed(2);

    return { percent, usedGb, totalGb };
  } catch (err) {
    return { percent: 0, usedGb: "0.00", totalGb: "0.00" };
  }
}

/**
 * Helper to format KB into readable GB/TB
 */
function formatKb(kb) {
  const gb = kb / 1024 / 1024;
  if (gb >= 1000) {
    return (gb / 1024).toFixed(1) + " TB";
  }
  return gb.toFixed(1) + " GB";
}

/**
 * Reads root filesystem disk usage
 */
function getDiskUsage() {
  try {
    const dfOut = execSync("df -Pk /", { timeout: 3000 }).toString().trim().split("\n");
    if (dfOut.length < 2) return { percent: 0, used: "0 GB", size: "0 GB", mount: "/" };

    const parts = dfOut[1].split(/\s+/);
    const totalKb = parseInt(parts[1], 10);
    const usedKb = parseInt(parts[2], 10);
    const percent = parseInt(parts[4].replace("%", ""), 10);

    return {
      percent,
      used: formatKb(usedKb),
      size: formatKb(totalKb),
      mount: "/"
    };
  } catch (err) {
    return { percent: 0, used: "N/A", size: "N/A", mount: "/" };
  }
}

/**
 * Retrieves top resource-consuming processes
 * @param {'cpu'|'mem'} sortBy 
 * @param {number} count 
 */
function getTopProcesses(sortBy = "cpu", count = 6) {
  try {
    const sortFlag = sortBy === "mem" ? "-%mem" : "-%cpu";
    const cmd = `ps -eo pid,user,%cpu,%mem,comm --sort=${sortFlag} | head -n ${count + 1}`;
    const output = execSync(cmd, { timeout: 3000 }).toString().trim();
    return output;
  } catch (err) {
    return "(Unable to retrieve process list)";
  }
}

/**
 * Formats full system status report
 */
function getSystemStatusReport() {
  const ram = getMemoryUsage();
  const disk = getDiskUsage();
  const cpu = getCpuUsagePercent();
  const topProcesses = getTopProcesses("cpu", 6);

  return `🖥️ *JARVIS SYSTEM RESOURCE STATUS*\n` +
    `───────────────\n` +
    `⚡ *CPU Usage:* \`${cpu}%\`\n` +
    `🧠 *RAM Usage:* \`${ram.percent}%\` (${ram.usedGb} GB / ${ram.totalGb} GB)\n` +
    `💾 *Disk (Root):* \`${disk.percent}%\` (${disk.used} / ${disk.size})\n\n` +
    `📋 *TOP RUNNING PROCESSES:*\n\`\`\`\n${topProcesses}\n\`\`\`\n` +
    `───────────────\n` +
    `_Monitoring thresholds: RAM 80%/90% | CPU 85%(5m)/95%(2m) | Disk 85%/95%_`;
}

/**
 * Checks all metrics against thresholds and sends WhatsApp notifications if overloaded.
 */
async function checkSystemHealthAndAlert(whatsappClient, targetJid, recordBotResponse) {
  try {
    if (!whatsappClient) return;

    const ram = getMemoryUsage();
    const disk = getDiskUsage();
    const cpu = getCpuUsagePercent();
    const now = Date.now();

    // ─────────────────────────────────────────────
    // 1. CPU SUSTAINED DURATION TRACKING
    // ─────────────────────────────────────────────
    if (cpu >= CONFIG.CPU.CRITICAL) {
      cpuCriticalDurationSec += CONFIG.CHECK_INTERVAL_SEC;
      cpuWarningDurationSec += CONFIG.CHECK_INTERVAL_SEC;
    } else if (cpu >= CONFIG.CPU.WARNING) {
      cpuWarningDurationSec += CONFIG.CHECK_INTERVAL_SEC;
      cpuCriticalDurationSec = 0;
    } else {
      cpuWarningDurationSec = 0;
      cpuCriticalDurationSec = 0;
    }

    const alertsToTrigger = [];
    const recoveredResources = [];

    // --- RAM Check ---
    let ramLevel = null;
    if (ram.percent >= CONFIG.RAM.CRITICAL) {
      ramLevel = "CRITICAL";
    } else if (ram.percent >= CONFIG.RAM.WARNING) {
      ramLevel = "WARNING";
    }

    if (ramLevel) {
      const state = alertState.RAM;
      const isEscalation = state.active && state.level === "WARNING" && ramLevel === "CRITICAL";
      const isCooldownExpired = (now - state.lastAlertTime) > CONFIG.ALERT_COOLDOWN_MS;

      if (!state.active || isEscalation || isCooldownExpired) {
        state.active = true;
        state.level = ramLevel;
        state.lastAlertTime = now;
        alertsToTrigger.push({
          resource: "RAM",
          level: ramLevel,
          detail: `${ram.percent}% used (${ram.usedGb} GB / ${ram.totalGb} GB)`,
          threshold: ramLevel === "CRITICAL" ? `${CONFIG.RAM.CRITICAL}%` : `${CONFIG.RAM.WARNING}%`,
          sortBy: "mem"
        });
      }
    } else if (alertState.RAM.active) {
      recoveredResources.push(`• *RAM:* normalized to \`${ram.percent}%\` (${ram.usedGb} GB / ${ram.totalGb} GB)`);
      alertState.RAM.active = false;
      alertState.RAM.level = null;
    }

    // --- CPU Check ---
    let cpuLevel = null;
    let cpuDurationText = "";
    if (cpuCriticalDurationSec >= CONFIG.CPU.CRITICAL_SUSTAINED_SEC) {
      cpuLevel = "CRITICAL";
      cpuDurationText = `sustained for ${(cpuCriticalDurationSec / 60).toFixed(1)}+ min`;
    } else if (cpuWarningDurationSec >= CONFIG.CPU.WARNING_SUSTAINED_SEC) {
      cpuLevel = "WARNING";
      cpuDurationText = `sustained for ${(cpuWarningDurationSec / 60).toFixed(1)}+ min`;
    }

    if (cpuLevel) {
      const state = alertState.CPU;
      const isEscalation = state.active && state.level === "WARNING" && cpuLevel === "CRITICAL";
      const isCooldownExpired = (now - state.lastAlertTime) > CONFIG.ALERT_COOLDOWN_MS;

      if (!state.active || isEscalation || isCooldownExpired) {
        state.active = true;
        state.level = cpuLevel;
        state.lastAlertTime = now;
        alertsToTrigger.push({
          resource: "CPU",
          level: cpuLevel,
          detail: `${cpu}% (${cpuDurationText})`,
          threshold: cpuLevel === "CRITICAL" ? `${CONFIG.CPU.CRITICAL}% sustained for 2+ min` : `${CONFIG.CPU.WARNING}% sustained for 5+ min`,
          sortBy: "cpu"
        });
      }
    } else if (alertState.CPU.active) {
      recoveredResources.push(`• *CPU:* normalized to \`${cpu}%\``);
      alertState.CPU.active = false;
      alertState.CPU.level = null;
    }

    // --- Disk Check ---
    let diskLevel = null;
    if (disk.percent >= CONFIG.DISK.CRITICAL) {
      diskLevel = "CRITICAL";
    } else if (disk.percent >= CONFIG.DISK.WARNING) {
      diskLevel = "WARNING";
    }

    if (diskLevel) {
      const state = alertState.Disk;
      const isEscalation = state.active && state.level === "WARNING" && diskLevel === "CRITICAL";
      const isCooldownExpired = (now - state.lastAlertTime) > CONFIG.ALERT_COOLDOWN_MS;

      if (!state.active || isEscalation || isCooldownExpired) {
        state.active = true;
        state.level = diskLevel;
        state.lastAlertTime = now;
        alertsToTrigger.push({
          resource: "Disk",
          level: diskLevel,
          detail: `${disk.percent}% used (${disk.used} / ${disk.size})`,
          threshold: diskLevel === "CRITICAL" ? `${CONFIG.DISK.CRITICAL}%` : `${CONFIG.DISK.WARNING}%`,
          sortBy: "cpu"
        });
      }
    } else if (alertState.Disk.active) {
      recoveredResources.push(`• *Disk:* normalized to \`${disk.percent}%\` (${disk.used} / ${disk.size})`);
      alertState.Disk.active = false;
      alertState.Disk.level = null;
    }

    // ─────────────────────────────────────────────
    // DISPATCH OVERLOAD ALERTS
    // ─────────────────────────────────────────────
    for (const alert of alertsToTrigger) {
      const isCrit = alert.level === "CRITICAL";
      const icon = isCrit ? "🚨" : "⚠️";
      const topProcs = getTopProcesses(alert.sortBy, 6);

      const alertMsg = `${icon} *SERVER OVERLOAD: ${alert.resource.toUpperCase()}*\n` +
        `───────────────\n` +
        `⚠️ *Server (${alert.resource}) is overloading!*\n\n` +
        `📌 *Severity:* *${alert.level}*\n` +
        `📊 *Current Usage:* \`${alert.detail}\`\n` +
        `🎯 *Threshold Limit:* \`${alert.threshold}\`\n\n` +
        `📋 *TOP RUNNING PROCESSES (${alert.sortBy.toUpperCase()}):*\n` +
        `\`\`\`\n${topProcs}\n\`\`\`\n` +
        `───────────────\n` +
        `_JARVIS automated hardware monitor._`;

      console.warn(`🚨 [OVERLOAD ALERT] Server (${alert.resource}) is overloading [${alert.level}]: ${alert.detail}`);

      await db.logAction("OVERLOAD_ALERT", `${alert.resource} ${alert.level}: ${alert.detail}`, "ALERT");

      if (recordBotResponse) {
        recordBotResponse(alertMsg);
      }

      if (targetJid && whatsappClient && whatsappClient.sendMessage) {
        await whatsappClient.sendMessage(targetJid, alertMsg);
      }

      // 📞 Trigger Outbound Phone Call for Level-1 Critical Disasters
      if (isCrit) {
        try {
          const emergencyVoice = `Emergency alert from JARVIS. Critical server breakdown: ${alert.resource} has reached ${alert.detail}. Immediate attention required.`;
          exec(`/usr/bin/python3 /jarvis/code/jarvisai/voice/call_isaac.py "${emergencyVoice.replace(/"/g, '\\"')}"`, (err, stdout) => {
            if (err) console.error("⚠️ Failed to trigger emergency call:", err.message);
            else console.log("📞 Outbound emergency disaster call dispatched to Isaac:", stdout.trim());
          });
        } catch (callErr) {
          console.error("Emergency call error:", callErr);
        }
      }
    }

    // ─────────────────────────────────────────────
    // DISPATCH RECOVERY NOTIFICATIONS
    // ─────────────────────────────────────────────
    if (recoveredResources.length > 0 && alertsToTrigger.length === 0) {
      const recoveryMsg = `✅ *SERVER OVERLOAD RESOLVED*\n` +
        `───────────────\n` +
        `Resource usage returned below alert limits:\n` +
        `${recoveredResources.join("\n")}\n\n` +
        `_JARVIS automated hardware monitor._`;

      console.log(`✅ [RESOLVED] Resource overload resolved: ${recoveredResources.join(", ")}`);

      if (recordBotResponse) {
        recordBotResponse(recoveryMsg);
      }

      if (targetJid && whatsappClient && whatsappClient.sendMessage) {
        await whatsappClient.sendMessage(targetJid, recoveryMsg);
      }
    }
  } catch (err) {
    console.error("Error in checkSystemHealthAndAlert:", err);
  }
}

/**
 * Sends a simulated test overload alert immediately
 */
async function sendTestAlert(whatsappClient, targetJid, recordBotResponse, resource = "RAM") {
  const isRam = resource.toUpperCase() === "RAM";
  const isCpu = resource.toUpperCase() === "CPU";
  const isDisk = resource.toUpperCase() === "DISK";

  const sortBy = isRam ? "mem" : "cpu";
  const topProcs = getTopProcesses(sortBy, 6);

  let detail = "";
  let threshold = "";

  if (isRam) {
    detail = `91.4% used (13.71 GB / 15.00 GB)`;
    threshold = `90% (CRITICAL)`;
  } else if (isCpu) {
    detail = `96.8% (sustained for 2.2 min)`;
    threshold = `95% sustained for 2+ min (CRITICAL)`;
  } else {
    detail = `96.2% used (3.5 TB / 3.6 TB)`;
    threshold = `95% (CRITICAL)`;
  }

  const alertMsg = `🚨 *SERVER OVERLOAD: ${resource.toUpperCase()} (TEST ALERT)*\n` +
    `───────────────\n` +
    `⚠️ *Server (${resource.toUpperCase()}) is overloading!*\n\n` +
    `📌 *Severity:* *CRITICAL [SIMULATED TEST]*\n` +
    `📊 *Current Usage:* \`${detail}\`\n` +
    `🎯 *Threshold Limit:* \`${threshold}\`\n\n` +
    `📋 *TOP RUNNING PROCESSES (${sortBy.toUpperCase()}):*\n` +
    `\`\`\`\n${topProcs}\n\`\`\`\n` +
    `───────────────\n` +
    `_JARVIS automated hardware monitor (Test Dispatch)._`;

  console.log(`🧪 [TEST ALERT] Sending test alert for ${resource} to ${targetJid}`);

  if (recordBotResponse) {
    recordBotResponse(alertMsg);
  }

  if (targetJid && whatsappClient && whatsappClient.sendMessage) {
    await whatsappClient.sendMessage(targetJid, alertMsg);
  }
  return alertMsg;
}

/**
 * Initializes continuous background monitoring
 */
function startSystemMonitor(whatsappClient, getTargetJid, recordBotResponse) {
  console.log(`🛡️ Starting System Resource Monitor (${CONFIG.CHECK_INTERVAL_SEC}s intervals)...`);
  
  // Seed initial CPU stat
  previousCpuStat = readCpuStat();

  // Fast check for manual test trigger file every 2 seconds
  setInterval(async () => {
    try {
      const triggerFile = "/tmp/jarvis_test_alert";
      if (fs.existsSync(triggerFile)) {
        let res = "RAM";
        try {
          const content = fs.readFileSync(triggerFile, "utf8").trim();
          if (content) res = content;
          fs.unlinkSync(triggerFile);
        } catch (e) {}
        const targetJid = typeof getTargetJid === "function" ? getTargetJid() : getTargetJid;
        await sendTestAlert(whatsappClient, targetJid, recordBotResponse, res);
      }
    } catch (e) {}
  }, 2000);

  // ─────────────────────────────────────────────
  // External Heartbeat / Dead-Man's Switch (Healthchecks.io / Uptime Kuma)
  // If the host or JARVIS dies, the external service alerts Isaac.
  // ─────────────────────────────────────────────
  const heartbeatUrl = process.env.HEARTBEAT_URL || process.env.HEALTHCHECKS_URL;
  if (heartbeatUrl) {
    console.log(`💓 External heartbeat monitor active: ${heartbeatUrl.replace(/(\/)[^\/]{6,}$/, "$1******")}`);
    const httpModule = heartbeatUrl.startsWith("https") ? require("https") : require("http");
    // Initial ping on start
    try {
      httpModule.get(heartbeatUrl, (res) => res.resume()).on("error", () => {});
    } catch (e) {}

    setInterval(() => {
      try {
        httpModule.get(heartbeatUrl, (res) => {
          res.resume();
        }).on("error", (e) => {
          console.warn("⚠️ Heartbeat ping failed:", e.message);
        });
      } catch (err) {
        console.warn("⚠️ Heartbeat dispatch error:", err.message);
      }
    }, 60 * 1000);
  }

  setInterval(async () => {
    try {
      const targetJid = typeof getTargetJid === "function" ? getTargetJid() : getTargetJid;
      await checkSystemHealthAndAlert(whatsappClient, targetJid, recordBotResponse);
    } catch (err) {
      console.error("System monitor tick error:", err.message);
    }
  }, CONFIG.CHECK_INTERVAL_SEC * 1000);
}

module.exports = {
  CONFIG,
  startSystemMonitor,
  checkSystemHealthAndAlert,
  sendTestAlert,
  getSystemStatusReport,
  getMemoryUsage,
  getDiskUsage,
  getCpuUsagePercent,
  getTopProcesses,
  alertState
};
