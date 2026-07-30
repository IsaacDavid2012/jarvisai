const http = require("http");
const { exec } = require("child_process");

/**
 * Server & Infrastructure Health Check Module (Optimized Parallel Execution)
 */
async function checkServers() {
  const fridayHost = process.env.FRIDAY_HOST || "127.0.0.1";
  const alphaHost = process.env.ALPHA_HOST || "127.0.0.1";

  const servers = [
    { name: "JARVIS (AI Core Node)", host: "127.0.0.1", port: 11434, type: "http" },
    { name: "Friday (Main Production)", host: fridayHost, type: "ping" },
    { name: "Alpha (Secondary Office)", host: alphaHost, type: "ping" }
  ];

  // Run all health checks concurrently for maximum speed
  const checkPromises = servers.map(async (s) => {
    let isUp = false;
    if (s.type === "http") {
      isUp = await checkHttp(s.host, s.port);
    } else {
      isUp = await pingHost(s.host);
    }
    return { name: s.name, status: isUp ? "🟢 ONLINE" : "🔴 OFFLINE" };
  });

  return await Promise.all(checkPromises);
}

function checkHttp(host, port) {
  return new Promise((resolve) => {
    const req = http.get(`http://${host}:${port}/api/tags`, { timeout: 2500 }, (res) => {
      resolve(res.statusCode === 200);
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
  });
}

function pingHost(host) {
  return new Promise((resolve) => {
    exec(`ping -c 1 -W 2 ${host}`, (err) => {
      resolve(!err);
    });
  });
}

module.exports = { checkServers };
