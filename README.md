# Pisoy Dos 🃏

A real-time multiplayer Filipino card game for 2–4 players, built with Node.js + Socket.io.

## Features
- 2–4 player support with correct hand sizes (13/17 cards per player)
- Full Pisoy Dos rules: singles, pairs, triples, straights, full houses, four-of-a-kind, straight flushes
- Control system (must lead when all others pass)
- 2-player draw-on-pass rule
- 3-player extra card shown to all
- Live in-game chat
- Mobile-optimized card table UI

---

## 🚀 Deploy to Railway (Free)

### Step 1 — Push to GitHub
```bash
cd pisoy-dos
git init
git add .
git commit -m "Initial Pisoy Dos"
```
Create a new repo on GitHub (github.com/new), then:
```bash
git remote add origin https://github.com/YOUR_USERNAME/pisoy-dos.git
git push -u origin main
```

### Step 2 — Deploy on Railway
1. Go to **https://railway.app** and sign in with GitHub
2. Click **"New Project"** → **"Deploy from GitHub repo"**
3. Select your `pisoy-dos` repo
4. Railway auto-detects Node.js and runs `node server.js`
5. Click **"Generate Domain"** in the Settings tab

That's it! Share the Railway URL with your friends.

---

## 🏠 Run Locally
```bash
npm install
npm start
# Open http://localhost:3000
```

## How to Play
1. Host creates a room → shares the 4-letter code
2. Friends join with the code
3. Host starts the game
4. Player holding 3♣ goes first (must include 3♣ in first move)
5. Play clockwise, beat the previous combination or pass
6. First to shed all cards wins!
