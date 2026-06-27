// ============================================================
// PISOY DOS — Server
// ============================================================

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const {
  createRoom, joinRoom, rejoinRoom, removePlayer, deleteRoom,
  startGame, resetGame, votePlayAgain, ackExtraCard,
  playCards, passTurn, addChat, getRoom, loadRooms
} = require('./src/roomManager');

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: '*' },
  // ---- No-timeout config ----
  // Give players a very long window before the server considers them gone.
  // This means someone can put their phone down, switch apps, etc. and come back.
  pingTimeout: 120000,       // 2 min before socket is considered dead
  pingInterval: 25000,       // heartbeat every 25s
  connectTimeout: 60000,     // allow slow connects
  // Allow clients to reconnect and resume seamlessly
  allowEIO3: true,
});

app.use(express.static(path.join(__dirname, 'public')));

// socketId -> setTimeout handle — gives players 30s to reconnect before removal
const disconnectTimers = {};

function scheduleRemoval(socketId, meta, io) {
  // Cancel any existing timer for this socket
  if (disconnectTimers[socketId]) {
    clearTimeout(disconnectTimers[socketId]);
    delete disconnectTimers[socketId];
  }

  disconnectTimers[socketId] = setTimeout(() => {
    delete disconnectTimers[socketId];
    const result = removePlayer(socketId);
    if (result) {
      const { code, room, playerName: name } = result;
      if (!room) return;
      io.to(code).emit('playerLeft', {
        name,
        lobby: lobbyState(room),
        duringGame: room.phase === 'playing',
      });
    }
  }, 86400000); // 24 hour grace period
}

function cancelRemoval(socketId) {
  if (disconnectTimers[socketId]) {
    clearTimeout(disconnectTimers[socketId]);
    delete disconnectTimers[socketId];
  }
}

// socketId -> { code, name }
const socketMeta = {};

io.on('connection', (socket) => {
  console.log('🟢 connected:', socket.id);

  // ---- LOBBY ----

  socket.on('createRoom', ({ name }) => {
    if (!name?.trim()) return socket.emit('error', 'Name required');
    cancelRemoval(socket.id);
    const room = createRoom(name.trim(), socket.id);
    socketMeta[socket.id] = { code: room.code, name: name.trim() };
    socket.join(room.code);
    socket.emit('roomCreated', { code: room.code, room: sanitize(room, socket.id) });
    io.to(room.code).emit('lobbyUpdate', lobbyState(room));
  });

  socket.on('joinRoom', ({ code, name }) => {
    if (!name?.trim() || !code?.trim()) return socket.emit('error', 'Name and code required');
    cancelRemoval(socket.id);
    const result = joinRoom(code.trim(), name.trim(), socket.id);
    if (result.error) return socket.emit('error', result.error);
    socketMeta[socket.id] = { code: result.room.code, name: name.trim() };
    socket.join(result.room.code);
    socket.emit('roomJoined', { code: result.room.code, room: sanitize(result.room, socket.id) });
    io.to(result.room.code).emit('lobbyUpdate', lobbyState(result.room));
  });

  socket.on('rejoinRoom', ({ code, name }) => {
    if (!name?.trim() || !code?.trim()) return socket.emit('error', 'Name and code required');
    cancelRemoval(socket.id);
    const result = rejoinRoom(code.trim(), name.trim(), socket.id);
    if (result.error) return socket.emit('error', result.error);

    const room = result.room;
    socketMeta[socket.id] = { code: room.code, name: name.trim() };
    socket.join(room.code);

    if (room.phase === 'playing') {
      // ID remap is done — now grab the hand using the NEW socket ID
      const hand = room.hands[socket.id] || [];
      const state = sanitize(room, socket.id);

      socket.emit('gameStarted', {
        hand,
        extraCard: room.extraCard,
        playerCount: room.players.length,
        gameState: state,
        isRejoin: true,
      });

      // Broadcast updated state to all other players so their screens sync
      for (const player of room.players) {
        if (player.id === socket.id) continue;
        io.to(player.id).emit('gameState', {
          event: 'playerRejoined',
          state: sanitize(room, player.id),
        });
      }
      socket.to(room.code).emit('playerRejoined', { name: name.trim() });

    } else if (room.phase === 'finished') {
      socket.emit('gameOver', { placements: room.placements, state: sanitize(room, socket.id) });
    } else if (room.phase === 'revealing') {
      // Player rejoined during the extra card reveal — send them back to the reveal screen
      socket.emit('revealExtraCard', {
        hand: room.hands[socket.id] || [],
        extraCard: room.extraCard,
        playerCount: room.players.length,
        players: room.players.map(p => ({ id: p.id, name: p.name })),
      });
      // Update ack count for everyone
      io.to(room.code).emit('extraCardAckUpdate', {
        ackCount: room.extraCardAcks.size,
        total: room.players.length,
      });
    } else {
      socket.emit('roomJoined', { code: room.code, room: sanitize(room, socket.id) });
      io.to(room.code).emit('lobbyUpdate', lobbyState(room));
    }
  });

  socket.on('startGame', () => {
    const meta = socketMeta[socket.id];
    if (!meta) return;
    const room = getRoom(meta.code);
    if (!room) return;
    if (room.host !== socket.id) return socket.emit('error', 'Only the host can start');

    const result = startGame(meta.code);
    if (result.error) return socket.emit('error', result.error);

    if (result.needsReveal) {
      // 3-player: show everyone the face-up extra card before game begins
      for (const player of result.room.players) {
        io.to(player.id).emit('revealExtraCard', {
          hand: result.room.hands[player.id],
          extraCard: result.room.extraCard,
          playerCount: result.room.players.length,
          players: result.room.players.map(p => ({ id: p.id, name: p.name })),
        });
      }
    } else {
      for (const player of result.room.players) {
        const pid = player.id;
        io.to(pid).emit('gameStarted', {
          hand: result.room.hands[pid],
          extraCard: result.room.extraCard,
          playerCount: result.room.players.length,
          gameState: sanitize(result.room, pid),
        });
      }
    }
  });

  // Player taps "OK, I saw it" for the extra card reveal (3-player only)
  socket.on('sawExtraCard', () => {
    const meta = socketMeta[socket.id];
    if (!meta) return;
    const result = ackExtraCard(meta.code, socket.id);
    if (result.error) return socket.emit('error', result.error);

    io.to(meta.code).emit('extraCardAckUpdate', {
      ackCount: result.ackCount,
      total: result.room.players.length,
    });

    if (result.allAcked) {
      for (const player of result.room.players) {
        const pid = player.id;
        io.to(pid).emit('gameStarted', {
          hand: result.room.hands[pid],
          extraCard: result.room.extraCard,
          playerCount: result.room.players.length,
          gameState: sanitize(result.room, pid),
        });
      }
    }
  });

  // ---- PLAY AGAIN ----

  // Any player votes to play again
  socket.on('votePlayAgain', () => {
    const meta = socketMeta[socket.id];
    if (!meta) return;
    const result = votePlayAgain(meta.code, socket.id);
    if (result.error) return socket.emit('error', result.error);

    // Broadcast vote progress to everyone in room
    io.to(meta.code).emit('playAgainVote', {
      voteCount: result.voteCount,
      total: result.total,
      allVoted: result.allVoted,
    });

    // If everyone's ready, reset to lobby automatically
    if (result.allVoted) {
      const resetResult = resetGame(meta.code);
      if (!resetResult.error) {
        io.to(meta.code).emit('gameReset', { lobby: lobbyState(resetResult.room) });
      }
    }
  });

  // Host can also force-reset (kick off new game without waiting for all votes)
  socket.on('hostRestart', () => {
    const meta = socketMeta[socket.id];
    if (!meta) return;
    const room = getRoom(meta.code);
    if (!room) return;
    if (room.host !== socket.id) return socket.emit('error', 'Only the host can restart');

    const resetResult = resetGame(meta.code);
    if (!resetResult.error) {
      io.to(meta.code).emit('gameReset', { lobby: lobbyState(resetResult.room) });
    }
  });

  // ---- LEAVE ROOM (lobby) ----
  socket.on('leaveRoom', () => {
    const meta = socketMeta[socket.id];
    if (!meta) return;
    cancelRemoval(socket.id);
    delete socketMeta[socket.id];
    const result = removePlayer(socket.id);
    if (result) {
      const { code, room, playerName: name } = result;
      if (!room) return;
      io.to(code).emit('lobbyUpdate', lobbyState(room));
      io.to(code).emit('playerLeft', { name, lobby: lobbyState(room), duringGame: false });
    }
    socket.leave(meta.code);
  });

  // ---- QUIT ----
  socket.on('quitGame', () => {
    const meta = socketMeta[socket.id];
    if (!meta) return;
    const code = meta.code;
    const name = meta.name;
    cancelRemoval(socket.id);
    delete socketMeta[socket.id];

    // Delete the entire room — any quit ends the game for everyone
    const room = getRoom(code);
    if (room) {
      socket.to(code).emit('roomClosed', { name });
      deleteRoom(code);
    }
    socket.leave(code);
  });

  // ---- GAMEPLAY ----

  socket.on('playCards', ({ cards }) => {
    const meta = socketMeta[socket.id];
    if (!meta) return;

    const result = playCards(meta.code, socket.id, cards);
    if (result.error) return socket.emit('error', result.error);

    broadcastGameState(result.room, result.event, { outPlayer: result.outPlayer });
  });

  socket.on('passTurn', () => {
    const meta = socketMeta[socket.id];
    if (!meta) return;

    const result = passTurn(meta.code, socket.id);
    if (result.error) return socket.emit('error', result.error);

    if (result.drawnCard) socket.emit('drewCard', { card: result.drawnCard });
    broadcastGameState(result.room, result.event, { controlPlayer: result.controlPlayer });
  });

  // ---- CHAT ----

  socket.on('chatMessage', ({ message }) => {
    const meta = socketMeta[socket.id];
    if (!meta || !message?.trim()) return;
    const entry = addChat(meta.code, socket.id, message.trim().slice(0, 200));
    if (entry) io.to(meta.code).emit('chatMessage', entry);
  });

  // ---- DISCONNECT ----

  socket.on('disconnect', (reason) => {
    console.log('🔴 disconnected:', socket.id, '|', reason);
    const meta = socketMeta[socket.id];
    delete socketMeta[socket.id];

    if (!meta) return;

    // Mark as disconnected immediately so others can see "away" status
    const room = getRoom(meta.code);
    if (room) {
      const player = room.players.find(p => p.id === socket.id);
      if (player) player.connected = false;
      io.to(meta.code).emit('playerLeft', {
        name: meta.name,
        lobby: lobbyState(room),
        duringGame: room.phase === 'playing',
      });
    }

    // Schedule actual removal after 30s grace period
    // If they reconnect before then, the timer is cancelled
    scheduleRemoval(socket.id, meta, io);
  });

  // ---- Helpers ----

  function broadcastGameState(room, event, extras = {}) {
    for (const player of room.players) {
      const pid = player.id;
      io.to(pid).emit('gameState', {
        event,
        state: sanitize(room, pid),
        ...extras,
      });
    }
  }
});

// Strip private hand data
function sanitize(room, viewerSocketId) {
  return {
    code: room.code,
    phase: room.phase,
    players: room.players.map(p => ({
      id: p.id,
      name: p.name,
      cardCount: room.cardCounts?.[p.id] ?? (room.hands?.[p.id]?.length ?? 0),
      isHost: p.id === room.host,
      connected: p.connected !== false,
    })),
    hand: room.hands?.[viewerSocketId] || [],
    currentCombo: room.currentCombo ? {
      type: room.currentCombo.type,
      cards: room.currentCombo.cards,
      playerId: room.currentCombo.playerId,
    } : null,
    currentPlayerId: room.turnOrder?.[room.currentPlayerIdx] || null,
    controlPlayer: room.controlPlayer,
    placements: room.placements,
    extraCard: room.extraCard,
    playerCount: room.players.length,
    drawPileCount: room.drawPile?.length ?? 0,
    openingCard: room.firstPlayDone ? null : room.openingCard,
    playHistory: room.playHistory || [],
  };
}

function lobbyState(room) {
  return {
    code: room.code,
    players: room.players.map(p => ({
      id: p.id,
      name: p.name,
      isHost: p.id === room.host,
      connected: p.connected !== false,
    })),
    phase: room.phase,
  };
}

const PORT = process.env.PORT || 3000;

// Load rooms from Redis first, then start listening
loadRooms().then(() => {
  server.listen(PORT, () => console.log(`🃏 Pisoy Dos running on port ${PORT}`));
}).catch(err => {
  console.error('Failed to load rooms on startup:', err);
  server.listen(PORT, () => console.log(`🃏 Pisoy Dos running on port ${PORT} (no saved rooms)`));
});
