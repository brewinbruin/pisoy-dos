// ============================================================
// PISOY DOS — Client
// ============================================================

const socket = io({
  // ---- Client-side reconnection (no timeout) ----
  // Retry forever with exponential backoff, capped at 10s
  reconnection: true,
  reconnectionAttempts: Infinity,
  reconnectionDelay: 1000,
  reconnectionDelayMax: 10000,
  timeout: 60000,
});

// ---- State ----
let mySocketId = null;
let myName = '';
let roomCode = '';
let gameState = null;
let selectedCards = new Set();
let chatUnread = 0;
let chatOpen = false;
let isReconnecting = false;

// ---- DOM shortcuts ----
const $ = id => document.getElementById(id);
const showScreen = id => {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  $(id).classList.add('active');
};

// ---- LANDING ----
$('btn-go-create').addEventListener('click', () => {
  showScreen('screen-create');
  setTimeout(() => $('create-name').focus(), 100);
});

$('btn-go-join').addEventListener('click', () => {
  showScreen('screen-join');
  setTimeout(() => $('join-code').focus(), 100);
});

$('btn-back-create').addEventListener('click', () => { clearSession(); showScreen('screen-landing'); });
$('btn-back-join').addEventListener('click', () => { clearSession(); showScreen('screen-landing'); });

// ---- CREATE ----
$('btn-create').addEventListener('click', doCreate);
$('create-name').addEventListener('keyup', e => { if (e.key === 'Enter') doCreate(); });

function doCreate() {
  const name = $('create-name').value.trim();
  if (!name) return toast('Enter your name');
  myName = name;
  socket.emit('createRoom', { name });
}

// ---- JOIN ----
$('btn-join').addEventListener('click', doJoin);
$('join-name').addEventListener('keyup', e => { if (e.key === 'Enter') doJoin(); });
$('join-code').addEventListener('input', e => {
  // Force uppercase as you type
  const pos = e.target.selectionStart;
  e.target.value = e.target.value.toUpperCase();
  e.target.setSelectionRange(pos, pos);
});
$('join-code').addEventListener('keyup', e => { if (e.key === 'Enter') $('join-name').focus(); });

function doJoin() {
  const code = $('join-code').value.trim().toUpperCase();
  const name = $('join-name').value.trim();
  if (code.length !== 4) return toast('Enter the 4-letter room code');
  if (!name) return toast('Enter your name');
  myName = name;
  socket.emit('joinRoom', { code, name });
}

// ---- LOBBY ----
$('btn-copy-code').addEventListener('click', () => {
  navigator.clipboard?.writeText(roomCode).then(() => toast('Code copied!'));
});

$('btn-start').addEventListener('click', () => {
  socket.emit('startGame');
});

function renderLobby(lobby) {
  $('lobby-code').textContent = lobby.code;
  const list = $('lobby-players');
  list.innerHTML = '';
  for (const p of lobby.players) {
    const row = document.createElement('div');
    row.className = 'player-row';
    const offline = p.connected === false ? ' (away)' : '';
    row.innerHTML = `
      <div class="avatar${p.connected === false ? ' offline' : ''}">${p.name[0].toUpperCase()}</div>
      <div class="pname">${esc(p.name)}${offline ? '<span class="away-tag">away</span>' : ''}</div>
      ${p.isHost ? '<span class="host-badge">Host</span>' : ''}
    `;
    list.appendChild(row);
  }

  const me = lobby.players.find(p => p.name === myName);
  const isHost = me?.isHost;
  const n = lobby.players.length;
  $('lobby-hint').textContent = n < 2
    ? `Waiting for players… (need at least 2, up to 4)`
    : `${n} player${n > 1 ? 's' : ''} in room${isHost ? ' — tap Start when ready' : ''}`;
  $('btn-start').classList.toggle('hidden', !isHost || n < 2);
}

// ---- GAME ----
function renderGame(state, myHand) {
  gameState = state;
  // Always find ourselves by name — socket ID may be stale after reconnect
  const me = state.players.find(p => p.name === myName);
  if (me) mySocketId = me.id; // keep mySocketId in sync
  const isMyTurn = me && state.currentPlayerId === me.id;

  // Opponents
  const oppArea = $('opponents-area');
  oppArea.innerHTML = '';
  for (const p of state.players) {
    if (p.name === myName) continue;
    const isActive = p.id === state.currentPlayerId;
    const isOut = state.placements.some(pl => pl.socketId === p.id);
    const slot = document.createElement('div');
    slot.className = 'opponent-slot';
    const maxMini = Math.min(p.cardCount, 10);
    let miniCards = '';
    for (let i = 0; i < maxMini; i++) miniCards += '<div class="mini-card"></div>';
    const offlineDot = p.connected === false ? '<span class="offline-dot" title="Away">●</span>' : '';
    slot.innerHTML = `
      <div class="opponent-avatar${isActive ? ' active-turn' : ''}${isOut ? ' is-out' : ''}">
        ${p.name[0].toUpperCase()}${offlineDot}
      </div>
      <div class="opponent-name">${esc(p.name)}</div>
      <div class="opponent-cards">${isOut ? '✓ Out' : miniCards}</div>
      <div class="opponent-count">${isOut ? '' : `${p.cardCount} card${p.cardCount !== 1 ? 's' : ''}`}</div>
    `;
    oppArea.appendChild(slot);
  }

  // Played area
  const playedCards = $('played-cards');
  playedCards.innerHTML = '';
  if (state.currentCombo) {
    $('played-label').textContent = `${playerName(state, state.currentCombo.playerId)} played:`;
    for (const c of state.currentCombo.cards) {
      playedCards.appendChild(buildCardEl(c, false));
    }
  } else {
    $('played-label').textContent = isMyTurn && me && state.controlPlayer === me.id
      ? 'You have control — lead a combination'
      : 'Waiting for play…';
  }

  // Status
  let statusText = '';
  if (isMyTurn) {
    statusText = me && state.controlPlayer === me.id ? '🎯 Your turn — you have control' : '🎯 Your turn!';
  } else {
    const who = playerName(state, state.currentPlayerId);
    statusText = `Waiting for ${who}…`;
  }
  $('status-bar').textContent = statusText;

  // My info
  $('my-name-label').textContent = me ? me.name : myName;
  $('my-card-count').textContent = `${myHand.length} card${myHand.length !== 1 ? 's' : ''}`;

  renderHand(myHand, isMyTurn);
  updateButtons(state, isMyTurn);

  // Draw pile counter — only visible in 2-player games
  const drawCounter = $('draw-pile-counter');
  if (state.playerCount === 2) {
    drawCounter.classList.remove('hidden');
    $('draw-pile-count').textContent = state.drawPileCount ?? 0;
  } else {
    drawCounter.classList.add('hidden');
  }
}

function renderHand(hand, isMyTurn) {
  const container = $('my-hand');
  container.innerHTML = '';

  if (hand.length === 0) return;

  const splitAt = Math.floor(hand.length / 2);
  const topCards    = hand.slice(0, splitAt);
  const bottomCards = hand.slice(splitAt);

  // Opening card that must be played (only set before first move)
  const openingCard = gameState?.openingCard;

  function makeRow(cards, rowClass) {
    const row = document.createElement('div');
    row.className = `hand-row ${rowClass}`;
    for (const code of cards) {
      const el = buildCardEl(code, true);
      if (selectedCards.has(code)) el.classList.add('selected');
      if (openingCard === code) el.classList.add('must-play');
      if (isMyTurn) {
        el.addEventListener('click', () => toggleCard(code, hand));
      } else {
        el.style.cursor = 'default';
      }
      row.appendChild(el);
    }
    return row;
  }

  if (topCards.length > 0) {
    container.appendChild(makeRow(topCards, 'row-top'));
  }
  container.appendChild(makeRow(bottomCards, 'row-bottom'));
}

function buildCardEl(code, interactive) {
  const suit = code.slice(-1);
  const face = code.slice(0, -1);
  const isRed = suit === 'H' || suit === 'D';
  const suitSymbol = { C: '♣', S: '♠', H: '♥', D: '♦' }[suit];

  const el = document.createElement('div');
  el.className = `card ${isRed ? 'red-card' : 'black-card'}`;
  el.dataset.code = code;
  el.innerHTML = `
    <div class="card-face">${face}</div>
    <div class="card-suit-tl">${suitSymbol}</div>
    <div class="card-suit-center">${suitSymbol}</div>
    <div class="card-br">${face}</div>
  `;
  return el;
}

function toggleCard(code, hand) {
  if (selectedCards.has(code)) {
    selectedCards.delete(code);
  } else {
    selectedCards.add(code);
  }
  renderHand(hand, true);
  updateButtons(gameState, true);
}

function updateButtons(state, isMyTurn) {
  const playBtn = $('btn-play-cards');
  const passBtn = $('btn-pass');
  const me = state?.players?.find(p => p.name === myName);
  const inControl = me && state?.controlPlayer === me.id;

  if (!isMyTurn) {
    playBtn.disabled = true;
    passBtn.disabled = true;
    return;
  }
  playBtn.disabled = selectedCards.size === 0;
  passBtn.disabled = !!inControl;
}

function playerName(state, id) {
  return state.players.find(p => p.id === id)?.name || '?';
}

// ---- Game buttons ----
$('btn-quit').addEventListener('click', () => {
  if (!confirm('Quit the game? You will leave the room.')) return;
  clearSession();
  roomCode = '';
  myName = '';
  selectedCards.clear();
  socket.emit('quitGame');
  showScreen('screen-landing');
});
$('btn-play-cards').addEventListener('click', () => {
  if (selectedCards.size === 0) return;
  socket.emit('playCards', { cards: [...selectedCards] });
  selectedCards.clear();
});

$('btn-pass').addEventListener('click', () => {
  socket.emit('passTurn');
  selectedCards.clear();
});

// ---- RESULTS / PLAY AGAIN ----
let myVotedPlayAgain = false;

function showResults(placements) {
  myVotedPlayAgain = false;
  const list = $('placements-list');
  list.innerHTML = '';
  const medals = ['🥇', '🥈', '🥉', ''];
  const cls = ['place-1', 'place-2', 'place-3', 'place-4'];
  for (const p of placements) {
    const row = document.createElement('div');
    row.className = 'placement-row';
    row.innerHTML = `
      <div class="place-badge ${cls[p.place - 1]}">${medals[p.place - 1] || p.place}</div>
      <div class="placement-name">${esc(p.name)}</div>
    `;
    list.appendChild(row);
  }
  updatePlayAgainBtn(0, 0);
  showScreen('screen-results');
}

function updatePlayAgainBtn(voteCount, total) {
  const btn = $('btn-play-again');
  if (myVotedPlayAgain) {
    btn.textContent = total > 0 ? `Waiting… (${voteCount}/${total} ready)` : 'Waiting for others…';
    btn.disabled = true;
  } else {
    btn.textContent = '🔄 Play Again';
    btn.disabled = false;
  }
  // Show host force-restart button only if I'm host
  const room = getLocalRoomInfo();
  $('btn-host-restart').classList.toggle('hidden', !room?.iAmHost);
}

function getLocalRoomInfo() {
  if (!gameState) return null;
  const me = gameState.players?.find(p => p.name === myName);
  return me ? { iAmHost: me.isHost } : null;
}

$('btn-play-again').addEventListener('click', () => {
  if (myVotedPlayAgain) return;
  myVotedPlayAgain = true;
  socket.emit('votePlayAgain');
  updatePlayAgainBtn(1, gameState?.players?.length || 0);
});

$('btn-host-restart').addEventListener('click', () => {
  if (confirm('Start a new game now for everyone?')) {
    socket.emit('hostRestart');
  }
});

// ---- CHAT ----
$('chat-toggle').addEventListener('click', () => {
  $('chat-panel').classList.remove('hidden');
  chatOpen = true;
  chatUnread = 0;
  updateChatBadge();
  $('chat-input').focus();
  scrollChat();
});
$('chat-close').addEventListener('click', () => {
  $('chat-panel').classList.add('hidden');
  chatOpen = false;
});
$('chat-send').addEventListener('click', sendChat);
$('chat-input').addEventListener('keyup', e => { if (e.key === 'Enter') sendChat(); });

function sendChat() {
  const msg = $('chat-input').value.trim();
  if (!msg) return;
  socket.emit('chatMessage', { message: msg });
  $('chat-input').value = '';
}

function appendChat(entry, isSystem) {
  const box = $('chat-messages');
  const div = document.createElement('div');
  div.className = `chat-msg${isSystem ? ' system' : ''}`;
  if (isSystem) {
    div.innerHTML = `<span class="msg-text">${esc(entry.message)}</span>`;
  } else {
    div.innerHTML = `<span class="msg-name">${esc(entry.name)}</span><span class="msg-text">${esc(entry.message)}</span>`;
  }
  box.appendChild(div);
  scrollChat();
  if (!chatOpen) { chatUnread++; updateChatBadge(); }
}

function scrollChat() {
  const box = $('chat-messages');
  box.scrollTop = box.scrollHeight;
}

function updateChatBadge() {
  const toggle = $('chat-toggle');
  let badge = toggle.querySelector('.badge');
  if (chatUnread > 0) {
    if (!badge) { badge = document.createElement('span'); badge.className = 'badge'; toggle.appendChild(badge); }
    badge.textContent = chatUnread;
  } else {
    badge?.remove();
  }
}

// ---- RECONNECT BANNER ----
function showReconnectBanner(show) {
  let banner = $('reconnect-banner');
  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'reconnect-banner';
    banner.className = 'reconnect-banner';
    banner.textContent = '🔄 Reconnecting…';
    document.body.appendChild(banner);
  }
  banner.classList.toggle('visible', show);
}

// ---- VISIBILITY CHANGE ----
// On mobile, coming back to the browser fires visibilitychange.
// Force a reconnect attempt immediately so the player is back in their room fast.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    const session = loadSession();
    const rejoinCode = roomCode || session.code;
    const rejoinName = myName || session.name;
    if (!rejoinCode || !rejoinName) return;

    if (!socket.connected) {
      // Socket is down — reconnect will trigger the connect handler which rejoins
      socket.connect();
    } else {
      // Socket still alive — just re-send rejoin to be safe
      socket.emit('rejoinRoom', { code: rejoinCode, name: rejoinName });
    }
  }
});

// ---- SESSION PERSISTENCE ----
// localStorage survives browser suspension on mobile (sessionStorage does not)
// URL hash is a last-resort fallback for Samsung Internet which kills localStorage
function saveSession(code, name) {
  try {
    localStorage.setItem('pd_code', code);
    localStorage.setItem('pd_name', name);
  } catch(e) {}
  // Also encode in URL hash so Samsung tab-restore can find it
  try {
    const encoded = btoa(JSON.stringify({ code, name }));
    history.replaceState(null, '', '#' + encoded);
  } catch(e) {}
}
function clearSession() {
  try { localStorage.removeItem('pd_code'); localStorage.removeItem('pd_name'); } catch(e) {}
  try { history.replaceState(null, '', window.location.pathname); } catch(e) {}
}
function loadSession() {
  // Try localStorage first
  try {
    const code = localStorage.getItem('pd_code');
    const name = localStorage.getItem('pd_name');
    if (code && name) return { code, name };
  } catch(e) {}
  // Fallback: try URL hash (Samsung Internet tab restore)
  try {
    const hash = window.location.hash.slice(1);
    if (hash) {
      const parsed = JSON.parse(atob(hash));
      if (parsed.code && parsed.name) return parsed;
    }
  } catch(e) {}
  return {};
}

// ---- SOCKET EVENTS ----

socket.on('connect', () => {
  mySocketId = socket.id;
  showReconnectBanner(false);

  // Load session first so myName and roomCode are set before we rejoin
  const session = loadSession();
  const rejoinCode = roomCode || session.code;
  const rejoinName = myName || session.name;

  if (rejoinCode && rejoinName) {
    // Set these before emitting so any callbacks have the right values
    myName = rejoinName;
    roomCode = rejoinCode;
    console.log('↩️ Rejoining room', rejoinCode, 'as', rejoinName);
    socket.emit('rejoinRoom', { code: rejoinCode, name: rejoinName });
  }
  isReconnecting = false;
});

socket.on('disconnect', (reason) => {
  console.log('Disconnected:', reason);
  isReconnecting = true;
  showReconnectBanner(true);
});

socket.on('reconnect_attempt', (n) => {
  showReconnectBanner(true);
});

socket.on('reconnect', () => {
  showReconnectBanner(false);
  toast('Reconnected ✓');
});

socket.on('roomCreated', ({ code, room }) => {
  roomCode = code;
  saveSession(code, myName);
  showScreen('screen-lobby');
  renderLobby({ code, players: room.players, phase: room.phase });
});

socket.on('roomJoined', ({ code, room }) => {
  roomCode = code;
  saveSession(code, myName);
  showScreen('screen-lobby');
  renderLobby({ code, players: room.players, phase: room.phase });
});

socket.on('lobbyUpdate', lobby => {
  if (lobby.code === roomCode) renderLobby(lobby);
});

// ---- EXTRA CARD REVEAL (3-player) ----
let myAckedExtraCard = false;

socket.on('revealExtraCard', ({ hand, extraCard, playerCount, players }) => {
  myAckedExtraCard = false;
  selectedCards.clear();

  // Show the card
  const wrap = $('reveal-card-wrap');
  wrap.innerHTML = '';
  wrap.appendChild(buildCardEl(extraCard, false));

  // Update subtitle based on whether it's 3C (special case)
  const subtitle = document.querySelector('.reveal-subtitle');
  if (extraCard === '3C') {
    subtitle.innerHTML = 'This is <strong>3♣</strong> — the holder of <strong>3♠</strong> collects it and goes first';
  } else {
    subtitle.innerHTML = `This card goes to the holder of <strong>3♣</strong>`;
  }

  $('reveal-waiting').textContent = 'Waiting for all players to confirm…';
  $('btn-saw-card').disabled = false;
  showScreen('screen-reveal');
});

$('btn-saw-card').addEventListener('click', () => {
  if (myAckedExtraCard) return;
  myAckedExtraCard = true;
  $('btn-saw-card').disabled = true;
  $('btn-saw-card').textContent = '✓ Confirmed';
  socket.emit('sawExtraCard');
});

socket.on('extraCardAckUpdate', ({ ackCount, total }) => {
  $('reveal-waiting').textContent = `${ackCount} of ${total} players confirmed…`;
});
socket.on('gameStarted', ({ hand, extraCard, gameState: state, isRejoin }) => {
  selectedCards.clear();
  // Always update mySocketId from the state — on rejoin after tab close
  // the socket ID has changed and we need the server's view of who we are
  const me = state.players.find(p => p.name === myName);
  if (me) mySocketId = me.id;

  showScreen('screen-game');

  if (extraCard && state.playerCount === 3 && !isRejoin) {
    const n = $('extra-card-notice');
    const suit = extraCard.slice(-1);
    const face = extraCard.slice(0, -1);
    const sym = { C: '♣', S: '♠', H: '♥', D: '♦' }[suit];
    n.textContent = `Extra card for 3-player game: ${face}${sym} — given to holder of 3♣`;
    n.classList.remove('hidden');
    setTimeout(() => n.classList.add('hidden'), 5000);
  }

  renderGame(state, hand);
  if (!isRejoin) {
    const opening = state.openingCard;
    if (opening) {
      const suit = opening.slice(-1);
      const face = opening.slice(0, -1);
      const sym = { C: '♣', S: '♠', H: '♥', D: '♦' }[suit];
      const starter = state.players.find(p => p.id === state.currentPlayerId);
      appendChat({ message: `Game started! ${starter?.name ?? 'First player'} must open with ${face}${sym}.` }, true);
    } else {
      appendChat({ message: 'Game started!' }, true);
    }
  } else {
    appendChat({ message: 'You reconnected to the game.' }, true);
  }
});

socket.on('gameState', ({ event, state, controlPlayer, drawnCard }) => {
  // Keep mySocketId in sync — it may have changed after a reconnect
  const me = state.players.find(p => p.name === myName);
  if (me) mySocketId = me.id;
  renderGame(state, state.hand);

  if (event === 'control') {
    const who = controlPlayer === mySocketId ? 'You have' : `${playerName(state, controlPlayer)} has`;
    toast(`${who} control`);
    appendChat({ message: `${who} control — leads next.` }, true);
  }
  if (event === 'playerOut') {
    const place = state.placements[state.placements.length - 1];
    if (place) {
      toast(`${place.name} finished ${ordinal(place.place)}!`);
      appendChat({ message: `${place.name} finished in ${ordinal(place.place)} place!` }, true);
    }
  }
  if (drawnCard) toast('You drew a card');
  if (event === 'gameOver') {
    setTimeout(() => showResults(state.placements), 1200);
  }
});

socket.on('drewCard', ({ card }) => {
  toast(`You drew: ${card}`);
});

socket.on('chatMessage', entry => {
  appendChat(entry, false);
});

socket.on('roomClosed', ({ name }) => {
  clearSession();
  roomCode = '';
  myName = '';
  selectedCards.clear();
  toast(`${name} quit — room closed`);
  setTimeout(() => showScreen('screen-landing'), 1500);
});

socket.on('playerLeft', ({ name, lobby, duringGame }) => {
  if (name) {
    toast(`${name} disconnected`);
    appendChat({ message: `${name} disconnected${duringGame ? ' (game continues)' : ''}.` }, true);
  }
  if (lobby && lobby.code === roomCode && lobby.phase === 'lobby') renderLobby(lobby);
});

socket.on('playerRejoined', ({ name }) => {
  toast(`${name} reconnected`);
  appendChat({ message: `${name} reconnected.` }, true);
});

socket.on('playAgainVote', ({ voteCount, total, allVoted }) => {
  updatePlayAgainBtn(voteCount, total);
  if (!allVoted) {
    appendChat({ message: `Play again: ${voteCount}/${total} ready…` }, true);
  }
});

socket.on('gameReset', ({ lobby }) => {
  roomCode = lobby.code;
  saveSession(lobby.code, myName);
  selectedCards.clear();
  myVotedPlayAgain = false;
  showScreen('screen-lobby');
  renderLobby(lobby);
  appendChat({ message: '🔄 New game starting — host can deal!' }, true);
});

socket.on('error', msg => {
  toast(`⚠️ ${msg}`);
  // If the room no longer exists, clear session and go back to landing
  // so the player can create or join a fresh room
  if (msg.includes('not found') || msg.includes('not in room')) {
    clearSession();
    roomCode = '';
    myName = '';
    setTimeout(() => showScreen('screen-landing'), 1500);
  }
});

// ---- Utils ----
function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('show'), 2800);
}

function esc(str) {
  return String(str)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function ordinal(n) {
  const s = ['th','st','nd','rd'];
  const v = n % 100;
  return n + (s[(v-20)%10] || s[v] || s[0]);
}
