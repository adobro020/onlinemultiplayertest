import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PORT = process.env.PORT || 3000;
const HOST = "0.0.0.0";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "public");
const rooms = new Map();
const clients = new Set();

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8"
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === "/health") {
    const body = JSON.stringify({ ok: true, rooms: rooms.size });
    res.writeHead(200, {
      "content-type": "application/json; charset=utf-8",
      "content-length": Buffer.byteLength(body)
    });
    res.end(body);
    return;
  }

  const requestedPath = url.pathname === "/" ? "/index.html" : url.pathname;
  const filePath = path.normalize(path.join(publicDir, requestedPath));

  if (!filePath.startsWith(publicDir)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  fs.stat(filePath, (error, stats) => {
    if (error || !stats.isFile()) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }

    res.writeHead(200, {
      "content-type": mimeTypes[path.extname(filePath)] || "application/octet-stream"
    });
    fs.createReadStream(filePath).pipe(res);
  });
});

function getRoom(roomCode) {
  const code = String(roomCode || "lobby").slice(0, 24) || "lobby";
  if (!rooms.has(code)) {
    rooms.set(code, new Map());
  }
  return { code, players: rooms.get(code) };
}

function broadcast(roomCode, message) {
  const room = rooms.get(roomCode);
  if (!room) return;

  const body = JSON.stringify(message);
  for (const player of room.values()) {
    if (player.socket.isOpen) {
      player.socket.send(body);
    }
  }
}

function roomSnapshot(roomCode) {
  const room = rooms.get(roomCode);
  return Array.from(room?.values() || []).map(({ id, name, color, x, y, score }) => ({
    id,
    name,
    color,
    x,
    y,
    score
  }));
}

function removePlayer(roomCode, playerId) {
  const room = rooms.get(roomCode);
  if (!room) return;

  room.delete(playerId);
  if (room.size === 0) {
    rooms.delete(roomCode);
    return;
  }

  broadcast(roomCode, {
    type: "state",
    players: roomSnapshot(roomCode)
  });
}

class WebSocketClient {
  constructor(socket) {
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.isAlive = true;
    this.isOpen = true;
    this.onMessage = () => {};
    this.onClose = () => {};

    socket.on("data", (chunk) => this.handleData(chunk));
    socket.on("close", () => this.close());
    socket.on("error", () => this.close());
  }

  handleData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);

    while (this.buffer.length >= 2) {
      const firstByte = this.buffer[0];
      const secondByte = this.buffer[1];
      const opcode = firstByte & 0x0f;
      const masked = Boolean(secondByte & 0x80);
      let length = secondByte & 0x7f;
      let offset = 2;

      if (length === 126) {
        if (this.buffer.length < offset + 2) return;
        length = this.buffer.readUInt16BE(offset);
        offset += 2;
      } else if (length === 127) {
        if (this.buffer.length < offset + 8) return;
        const bigLength = this.buffer.readBigUInt64BE(offset);
        if (bigLength > BigInt(Number.MAX_SAFE_INTEGER)) {
          this.close();
          return;
        }
        length = Number(bigLength);
        offset += 8;
      }

      const maskOffset = masked ? 4 : 0;
      if (this.buffer.length < offset + maskOffset + length) return;

      let payload = this.buffer.subarray(offset + maskOffset, offset + maskOffset + length);
      if (masked) {
        const mask = this.buffer.subarray(offset, offset + 4);
        payload = Buffer.from(payload.map((byte, index) => byte ^ mask[index % 4]));
      }

      this.buffer = this.buffer.subarray(offset + maskOffset + length);

      if (opcode === 0x8) {
        this.close();
        return;
      }

      if (opcode === 0x9) {
        this.writeFrame(0xA, payload);
        continue;
      }

      if (opcode === 0xA) {
        this.isAlive = true;
        continue;
      }

      if (opcode === 0x1) {
        this.onMessage(payload.toString("utf8"));
      }
    }
  }

  send(text) {
    this.writeFrame(0x1, Buffer.from(text));
  }

  ping() {
    this.writeFrame(0x9, Buffer.alloc(0));
  }

  writeFrame(opcode, payload) {
    if (!this.isOpen || this.socket.destroyed) return;

    let header;
    if (payload.length < 126) {
      header = Buffer.from([0x80 | opcode, payload.length]);
    } else if (payload.length < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 126;
      header.writeUInt16BE(payload.length, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(payload.length), 2);
    }

    this.socket.write(Buffer.concat([header, payload]));
  }

  close() {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.socket.destroy();
    this.onClose();
  }
}

function handleConnection(socket) {
  const id = crypto.randomUUID();
  let roomCode = null;
  const client = new WebSocketClient(socket);

  clients.add(client);

  client.onMessage = (rawMessage) => {
    let message;
    try {
      message = JSON.parse(rawMessage);
    } catch {
      return;
    }

    if (message.type === "join") {
      if (roomCode) {
        removePlayer(roomCode, id);
      }

      const { code, players } = getRoom(message.room || "town");
      roomCode = code;

      const player = {
        id,
        socket: client,
        name: String(message.name || "Penguin").slice(0, 18),
        color: String(message.color || "#4f46e5").slice(0, 16),
        x: Math.max(45, Math.min(755, Number(message.x) || 160 + Math.floor(Math.random() * 360))),
        y: Math.max(70, Math.min(430, Number(message.y) || 260 + Math.floor(Math.random() * 120))),
        score: 0
      };

      players.set(id, player);
      client.send(JSON.stringify({ type: "welcome", id, room: roomCode }));
      broadcast(roomCode, { type: "state", players: roomSnapshot(roomCode) });
      return;
    }

    if (message.type === "move") {
      const room = rooms.get(roomCode);
      const player = room?.get(id);
      if (!player) return;

      player.x = Math.max(12, Math.min(788, Number(message.x) || player.x));
      player.y = Math.max(12, Math.min(448, Number(message.y) || player.y));
      broadcast(roomCode, { type: "state", players: roomSnapshot(roomCode) });
      return;
    }

    if (message.type === "tag" || message.type === "snowball") {
      const room = rooms.get(roomCode);
      const player = room?.get(id);
      if (!player) return;

      player.score += 1;
      broadcast(roomCode, {
        type: "snowball",
        id: crypto.randomUUID(),
        playerId: id,
        name: player.name,
        color: player.color,
        x: player.x,
        y: player.y,
        targetX: Math.max(12, Math.min(788, Number(message.targetX) || player.x + 80)),
        targetY: Math.max(12, Math.min(448, Number(message.targetY) || player.y - 40))
      });
      broadcast(roomCode, { type: "state", players: roomSnapshot(roomCode) });
      return;
    }

    if (message.type === "emote") {
      const room = rooms.get(roomCode);
      const player = room?.get(id);
      const emote = String(message.emote || "wave").slice(0, 16);
      if (!player) return;

      broadcast(roomCode, {
        type: "emote",
        playerId: id,
        name: player.name,
        emote
      });
      return;
    }

    if (message.type === "chat") {
      const room = rooms.get(roomCode);
      const player = room?.get(id);
      const text = String(message.text || "").trim().slice(0, 120);
      if (!player || !text) return;

      broadcast(roomCode, {
        type: "chat",
        playerId: id,
        name: player.name,
        color: player.color,
        text
      });
    }
  };

  client.onClose = () => {
    clients.delete(client);
    removePlayer(roomCode, id);
  };
}

const heartbeat = setInterval(() => {
  for (const client of clients) {
    if (!client.isAlive) {
      client.close();
      continue;
    }
    client.isAlive = false;
    client.ping();
  }
}, 30000);

server.on("upgrade", (req, socket) => {
  if (req.headers.upgrade?.toLowerCase() !== "websocket") {
    socket.destroy();
    return;
  }

  const key = req.headers["sec-websocket-key"];
  if (!key) {
    socket.destroy();
    return;
  }

  const accept = crypto
    .createHash("sha1")
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest("base64");

  socket.write(
    [
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${accept}`,
      "",
      ""
    ].join("\r\n")
  );

  handleConnection(socket);
});

server.on("close", () => clearInterval(heartbeat));

server.listen(PORT, HOST, () => {
  console.log(`Multiplayer test running on http://${HOST}:${PORT}`);
});
