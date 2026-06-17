# Polar Plaza Multiplayer

A tiny snowy penguin-style multiplayer hangout using Node and WebSockets. It is meant to prove that real-time browser connections work after deploying as a Render Web Service.

The app includes:

- Penguin avatars drawn with CSS
- Snowy rooms: Town, Plaza, Dojo, and Cove
- Private room codes for testing with friends
- Live movement, chat bubbles, emotes, and snowballs
- No external app dependencies

## Run locally

```bash
npm start
```

Open `http://localhost:3000` in two browser tabs, enter the same private room code, and move with WASD, arrow keys, or click/tap.

## Deploy on Render

1. Upload this folder to a GitHub, GitLab, or Bitbucket repository.
2. In Render, create a new Web Service from that repository.
3. Use these settings:
   - Runtime: `Node`
   - Build command: `npm install`
   - Start command: `npm start`
   - Health check path: `/health`
4. After deploy, open the Render URL in two browsers or devices.

The server listens on `process.env.PORT`, which Render sets for Web Services.

## Test

```bash
npm run smoke
```

The smoke test starts the server, opens two WebSocket clients, joins the same room, and verifies both players receive shared state.
