// ============================================================
// PISOY DOS — Room Manager
// ============================================================

const { Redis } = require('@upstash/redis');

const {
  dealCards, findStartingPlayer, detectCombination, beatsCombo, sortCards
} = require('./gameLogic');

// ---- Redis Persistence ----
const redis = new Redis({
  url:   process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const REDIS_KEY = 'pisoy-dos:rooms';

async function saveRooms() {
  try {
    const serialisable = {};
    for (const [code, room] of Object.entries(rooms)) {
      serialisable[code] = {
        ...room,
        playAgainVotes: [...(room.playAgainVotes || [])],
        extraCardAcks:  [...(room.extraCardAcks  || [])],
      };
    }
    await redis.set(REDIS_KEY, JSON.stringify(serialisable));
  } catch (e) {
    console.error('Redis save failed:', e.message);
  }
}

async function loadRooms() {
  try {
    const data = await redis.get(REDIS_KEY);
    if (!data) { console.log('📂 No saved rooms found in Redis'); return; }
    const parsed = typeof data === 'string' ? JSON.parse(data) : data;
    for (const [code, room] of Object.entries(parsed)) {
      room.playAgainVotes = new Set(room.playAgainVotes || []);
      room.extraCardAcks  = new Set(room.extraCardAcks  || []);
      // Mark all players disconnected — they'll rejoin themselves
      room.players = (room.players || []).map(p => ({ ...p, connected: false }));
      if (room.phase === 'revealing') room.phase = 'lobby';
      rooms[code] = room;
    }
    console.log(`📂 Loaded ${Object.keys(rooms).length} room(s) from Redis`);
  } catch (e) {
    console.error('Redis load failed:', e.message);
  }
}

// Debounced save — write to Redis at most once per second
let saveTimer = null;
function queueSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(saveRooms, 1000);
}

const rooms = {}; // roomCode -> RoomState (in-memory, backed by Redis)

function generateCode() {
  return Math.random().toString(36).substring(2, 6).toUpperCase();
}

function createRoom(hostName, hostSocketId) {
  let code;
  do { code = generateCode(); } while (rooms[code]);

  rooms[code] = {
    code,
    host: hostSocketId,
    phase: 'lobby',       // lobby | playing | finished
    players: [{ id: hostSocketId, name: hostName, connected: true }],
    hands: {},
    cardCounts: {},
    currentCombo: null,
    controlPlayer: null,
    currentPlayerIdx: 0,
    turnOrder: [],
    placements: [],
    passCount: 0,
    passesNeeded: 0,
    extraCard: null,
    drawPile: [],
    chat: [],
    playAgainVotes: new Set(),
    extraCardAcks: new Set(),
    firstPlayDone: false,
    openingCard: null,
  };

  queueSave();
  return rooms[code];
}

function joinRoom(code, playerName, socketId) {
  const room = rooms[code.toUpperCase()];
  if (!room) return { error: 'Room not found' };
  if (room.phase !== 'lobby') return { error: 'Game already in progress' };
  if (room.players.length >= 4) return { error: 'Room is full' };
  if (room.players.find(p => p.id === socketId)) return { error: 'Already in room' };

  room.players.push({ id: socketId, name: playerName, connected: true });
  queueSave();
  return { room };
}

// Called when a player reconnects with a known name+code during a game
function rejoinRoom(code, playerName, newSocketId) {
  const room = rooms[code.toUpperCase()];
  if (!room) return { error: 'Room not found' };

  const existing = room.players.find(p => p.name === playerName);
  if (!existing) {
    // Not a known player — treat as new join if lobby
    if (room.phase === 'lobby') return joinRoom(code, playerName, newSocketId);
    return { error: 'Game in progress — player not found' };
  }

  const oldId = existing.id;
  existing.id = newSocketId;
  existing.connected = true;

  // Rebuild the entire hands map from the name-keyed source of truth.
  // This fixes stale socket IDs after server restarts or multiple reconnects.
  if (room.handByName) {
    const newHands = {};
    const newCounts = {};
    for (const player of room.players) {
      if (room.handByName[player.name] !== undefined) {
        newHands[player.id] = room.handByName[player.name];
        newCounts[player.id] = room.handByName[player.name].length;
      }
    }
    room.hands = newHands;
    room.cardCounts = newCounts;
  } else {
    // Fallback: remap old socket ID to new one
    if (room.hands[oldId] !== undefined) {
      room.hands[newSocketId] = room.hands[oldId];
      delete room.hands[oldId];
    }
    if (room.cardCounts[oldId] !== undefined) {
      room.cardCounts[newSocketId] = room.cardCounts[oldId];
      delete room.cardCounts[oldId];
    }
  }

  if (room.host === oldId) room.host = newSocketId;
  if (room.controlPlayer === oldId) room.controlPlayer = newSocketId;
  if (room.currentCombo?.playerId === oldId) room.currentCombo.playerId = newSocketId;

  // Fix turnOrder — rebuild from current player order to avoid stale IDs
  room.turnOrder = room.turnOrder.map(id => {
    const p = room.players.find(pl => pl.id === id || (id === oldId && pl.id === newSocketId));
    return p ? p.id : id;
  });

  room.placements = room.placements.map(p =>
    p.socketId === oldId ? { ...p, socketId: newSocketId } : p
  );

  if (room.playAgainVotes.has(oldId)) {
    room.playAgainVotes.delete(oldId);
    room.playAgainVotes.add(newSocketId);
  }
  if (room.extraCardAcks.has(oldId)) {
    room.extraCardAcks.delete(oldId);
    room.extraCardAcks.add(newSocketId);
  }

  queueSave();
  return { room, wasRejoining: true, oldId };
}

function removePlayer(socketId) {
  for (const code of Object.keys(rooms)) {
    const room = rooms[code];
    const player = room.players.find(p => p.id === socketId);
    if (player) {
      if (room.phase === 'lobby') {
        room.players = room.players.filter(p => p.id !== socketId);
        if (room.host === socketId && room.players.length > 0) {
          room.host = room.players[0].id;
        }
        if (room.players.length === 0) {
          delete rooms[code];
          queueSave();
          return { code, room: null, removed: true };
        }
      } else {
        player.connected = false;
      }
      queueSave();
      return { code, room, playerName: player.name };
    }
  }
  return null;
}

function startGame(code) {
  const room = rooms[code];
  if (!room) return { error: 'Room not found' };
  const n = room.players.length;
  if (n < 2) return { error: 'Need at least 2 players' };

  const { hands, extraCard, openingCard } = dealCards(n);
  room.extraCard = extraCard;
  room.openingCard = openingCard;
  room.placements = [];
  room.passCount = 0;
  room.currentCombo = null;
  room.firstPlayDone = false;
  room.playAgainVotes = new Set();
  room.extraCardAcks = new Set();
  room.passesNeeded = 0;

  const handMap = {};
  const handByName = {};
  for (let i = 0; i < n; i++) {
    const pid = room.players[i].id;
    const pname = room.players[i].name;
    handMap[pid] = sortCards(hands[i]);
    handByName[pname] = sortCards(hands[i]);
  }
  room.hands = handMap;
  room.handByName = handByName; // name-keyed copy that survives socket ID changes
  room.cardCounts = Object.fromEntries(Object.entries(handMap).map(([k,v]) => [k, v.length]));

  if (n === 3 && extraCard) {
    room.phase = 'revealing';
    room._pendingHands = hands;
    queueSave();
    return { room, needsReveal: true };
  }

  room.phase = 'playing';
  const startIdx = findStartingPlayer(hands, openingCard);
  room.turnOrder = room.players.map(p => p.id);
  room.currentPlayerIdx = startIdx;
  room.controlPlayer = room.turnOrder[startIdx];

  if (n === 2) {
    const dealt = new Set([...hands[0], ...hands[1]]);
    const { createDeck, shuffle } = require('./gameLogic');
    const full = createDeck();
    room.drawPile = shuffle(full.filter(c => !dealt.has(c)));
  }

  queueSave();
  return { room, needsReveal: false };
}

// Called when a player confirms they've seen the extra card (3-player only)
function ackExtraCard(code, socketId) {
  const room = rooms[code];
  if (!room || room.phase !== 'revealing') return { error: 'Not in reveal phase' };

  room.extraCardAcks.add(socketId);
  const allAcked = room.players.every(p => room.extraCardAcks.has(p.id));

  if (allAcked) {
    // Give the extra card to the right player, then start the game.
    const hands = room._pendingHands;
    delete room._pendingHands;

    let recipientIdx;
    if (room.extraCard === '3C') {
      // Special case: 52nd card is 3♣ → give it to the holder of 3♠
      recipientIdx = hands.findIndex(h => h.includes('3S'));
    } else {
      // Normal case: give the extra card to whoever holds 3♣ in hand
      recipientIdx = hands.findIndex(h => h.includes('3C'));
    }

    if (recipientIdx >= 0) {
      const recipientId = room.players[recipientIdx].id;
      const recipientName = room.players[recipientIdx].name;
      room.hands[recipientId] = sortCards([...room.hands[recipientId], room.extraCard]);
      room.cardCounts[recipientId] = room.hands[recipientId].length;
      if (room.handByName) room.handByName[recipientName] = room.hands[recipientId];
    }

    // Rebuild full handByName from current hands
    room.handByName = {};
    for (const player of room.players) {
      if (room.hands[player.id]) room.handByName[player.name] = room.hands[player.id];
    }

    room.phase = 'playing';
    const startIdx = findStartingPlayer(
      room.players.map(p => room.hands[p.id]),
      room.openingCard
    );
    room.turnOrder = room.players.map(p => p.id);
    room.currentPlayerIdx = startIdx;
    room.controlPlayer = room.turnOrder[startIdx];
    room.extraCardAcks = new Set();

    queueSave();
    return { room, allAcked: true, ackCount: room.players.length };
  }

  return { room, allAcked: false, ackCount: room.extraCardAcks.size };
}

// Reset game state for a rematch — players stay, host can restart
function resetGame(code) {
  const room = rooms[code];
  if (!room) return { error: 'Room not found' };
  room.phase = 'lobby';
  room.hands = {};
  room.cardCounts = {};
  room.currentCombo = null;
  room.firstPlayDone = false;
  room.openingCard = null;
  room.extraCardAcks = new Set();
  room.controlPlayer = null;
  room.currentPlayerIdx = 0;
  room.turnOrder = [];
  room.placements = [];
  room.passCount = 0;
  room.passesNeeded = 0;
  room.extraCard = null;
  room.drawPile = [];
  room.playAgainVotes = new Set();
  queueSave();
  return { room };
}

// Vote to play again — returns { room, allVoted }
function votePlayAgain(code, socketId) {
  const room = rooms[code];
  if (!room) return { error: 'Room not found' };
  room.playAgainVotes.add(socketId);
  queueSave();
  const allVoted = room.players.every(p => room.playAgainVotes.has(p.id));
  return { room, allVoted, voteCount: room.playAgainVotes.size, total: room.players.length };
}

function playCards(code, socketId, cardCodes) {
  const room = rooms[code];
  if (!room || room.phase !== 'playing') return { error: 'No active game' };

  const currentPid = room.turnOrder[room.currentPlayerIdx];
  if (socketId !== currentPid) return { error: 'Not your turn' };

  const hand = room.hands[socketId];
  if (!hand) return { error: 'No hand found' };

  for (const c of cardCodes) {
    if (!hand.includes(c)) return { error: `Card ${c} not in hand` };
  }

  // Only the very first play of the entire game must include the opening card
  if (!room.firstPlayDone) {
    const opening = room.openingCard;
    if (!cardCodes.includes(opening)) {
      const suit = opening.slice(-1);
      const face = opening.slice(0, -1);
      const sym = { C: '♣', S: '♠', H: '♥', D: '♦' }[suit];
      return { error: `First move must include ${face}${sym} (your lowest card)` };
    }
  }

  const combo = detectCombination(cardCodes);
  if (!combo) return { error: 'Invalid combination' };

  if (room.currentCombo && !beatsCombo(combo, room.currentCombo)) {
    return { error: 'Does not beat current combination' };
  }

  const newHand = hand.filter(c => !cardCodes.includes(c));
  room.hands[socketId] = newHand;
  room.cardCounts[socketId] = newHand.length;
  // Keep name-keyed copy in sync
  const pname = playerName(room, socketId);
  if (room.handByName) room.handByName[pname] = newHand;

  room.firstPlayDone = true;  // opening move complete — 3C rule no longer applies
  room.currentCombo = { ...combo, playerId: socketId };
  room.passCount = 0;
  room.controlPlayer = null;

  if (newHand.length === 0) {
    // Player went out — record placement
    room.placements.push({ socketId, name: playerName(room, socketId), place: room.placements.length + 1 });
    const activePlayers = room.turnOrder.filter(pid => room.hands[pid]?.length > 0);

    if (activePlayers.length <= 1) {
      if (activePlayers.length === 1) {
        const lastPid = activePlayers[0];
        room.placements.push({ socketId: lastPid, name: playerName(room, lastPid), place: room.placements.length + 1 });
      }
      room.phase = 'finished';
      queueSave();
      return { room, event: 'gameOver' };
    }

    room.passesNeeded = activePlayers.length;
    advanceTurn(room);

    if (activePlayers.length === 1) {
      const controlId = activePlayers[0];
      room.controlPlayer = controlId;
      room.currentCombo = null;
      room.passCount = 0;
      room.passesNeeded = 0;
      room.currentPlayerIdx = room.turnOrder.indexOf(controlId);
    }

    queueSave();
    return { room, event: 'playerOut', outPlayer: socketId };
  }

  room.passesNeeded = countActivePLayersAfter(room, socketId);
  advanceTurn(room);
  queueSave();
  return { room, event: 'played' };
}

function passTurn(code, socketId) {
  const room = rooms[code];
  if (!room || room.phase !== 'playing') return { error: 'No active game' };

  const currentPid = room.turnOrder[room.currentPlayerIdx];
  if (socketId !== currentPid) return { error: 'Not your turn' };

  if (room.controlPlayer === socketId) return { error: 'You are in control — you must lead' };

  let drawnCard = null;
  if (room.turnOrder.filter(pid => room.hands[pid]?.length > 0).length === 2 && room.drawPile.length > 0) {
    drawnCard = room.drawPile.pop();
    room.hands[socketId].push(drawnCard);
    room.hands[socketId] = sortCards(room.hands[socketId]);
    room.cardCounts[socketId] = room.hands[socketId].length;
    // Keep name-keyed copy in sync
    const pname = playerName(room, socketId);
    if (room.handByName) room.handByName[pname] = room.hands[socketId];
  }

  room.passCount++;

  // All players who had a chance to beat the last combo have passed
  if (room.passCount >= room.passesNeeded) {
    const lastPlayerId = room.currentCombo?.playerId;
    let controlId;

    if (lastPlayerId && room.hands[lastPlayerId]?.length > 0) {
      // Last player still has cards — they get control back
      controlId = lastPlayerId;
    } else {
      // Last player went out — control to next active after them
      const startIdx = lastPlayerId
        ? room.turnOrder.indexOf(lastPlayerId)
        : room.currentPlayerIdx;
      controlId = nextActiveAfter(room, startIdx);
    }

    room.controlPlayer = controlId;
    room.currentCombo = null;
    room.passCount = 0;
    room.passesNeeded = 0;
    room.currentPlayerIdx = room.turnOrder.indexOf(controlId);
    queueSave();
    return { room, event: 'control', controlPlayer: controlId, drawnCard };
  }

  advanceTurn(room);
  queueSave();
  return { room, event: 'passed', drawnCard };
}

// For a normal play: passesNeeded = all other active players.
// The turn will rotate through them; once all have passed, the player
// who played gets control (advanceTurn would land on them, but passCount
// fires first and grants them control automatically).
function countActivePLayersAfter(room, socketId) {
  return room.turnOrder.filter(
    pid => pid !== socketId && room.hands[pid]?.length > 0
  ).length;
}

// Find the next active player (with cards) after a given turn-order index
function nextActiveAfter(room, fromIdx) {
  const n = room.turnOrder.length;
  for (let i = 1; i <= n; i++) {
    const pid = room.turnOrder[(fromIdx + i) % n];
    if (room.hands[pid]?.length > 0) return pid;
  }
  return null; // shouldn't happen if game isn't over
}

function advanceTurn(room) {
  const activePlayers = new Set(room.turnOrder.filter(pid => room.hands[pid]?.length > 0));
  let idx = room.currentPlayerIdx;
  do {
    idx = (idx + 1) % room.turnOrder.length;
  } while (!activePlayers.has(room.turnOrder[idx]));
  room.currentPlayerIdx = idx;
}

function playerName(room, socketId) {
  return room.players.find(p => p.id === socketId)?.name || 'Unknown';
}

function addChat(code, socketId, message) {
  const room = rooms[code];
  if (!room) return null;
  const name = playerName(room, socketId);
  const entry = { name, message, ts: Date.now() };
  room.chat.push(entry);
  if (room.chat.length > 100) room.chat.shift();
  return entry;
}

function deleteRoom(code) {
  delete rooms[code?.toUpperCase()];
  queueSave();
}

function getRoom(code) { return rooms[code?.toUpperCase()]; }

module.exports = {
  createRoom, joinRoom, rejoinRoom, removePlayer, deleteRoom,
  startGame, resetGame, votePlayAgain, ackExtraCard,
  playCards, passTurn, addChat, getRoom, loadRooms
};
