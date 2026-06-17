import { spawn } from "node:child_process";

const PORT = 4100;
const server = spawn(process.execPath, ["server.js"], {
  cwd: new URL("..", import.meta.url),
  env: { ...process.env, PORT: String(PORT) },
  stdio: ["ignore", "pipe", "pipe"]
});

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForServer() {
  for (let i = 0; i < 40; i += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/health`);
      if (response.ok) return;
    } catch {
      await wait(100);
    }
  }
  throw new Error("Server did not become healthy");
}

function openClient(name) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
    const timeout = setTimeout(() => reject(new Error(`${name} timed out`)), 4000);

    ws.addEventListener("open", () => {
      ws.send(JSON.stringify({ type: "join", room: "smoke", name, color: "#2563eb" }));
    });

    ws.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.type === "welcome") {
        clearTimeout(timeout);
        resolve(ws);
      }
    });

    ws.addEventListener("error", reject);
  });
}

function waitForTwoPlayers(ws) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Did not receive two-player state")), 4000);

    ws.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.type === "state" && message.players.length === 2) {
        clearTimeout(timeout);
        resolve();
      }
    });
  });
}

try {
  await waitForServer();
  const one = await openClient("One");
  const sawTwoPlayers = waitForTwoPlayers(one);
  const two = await openClient("Two");

  one.send(JSON.stringify({ type: "move", x: 320, y: 180 }));
  await sawTwoPlayers;

  one.close();
  two.close();
  console.log("Smoke test passed");
} finally {
  server.kill("SIGTERM");
}
