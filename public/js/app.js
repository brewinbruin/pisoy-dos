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
$('btn-leave-room').addEventListener('click', () => {
  clearSession();
  clearHandState();
  roomCode = '';
  myName = '';
  socket.emit('leaveRoom');
  showScreen('screen-landing');
});

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


// ---- Hand state ----
// rowMap: code -> 'h1'|'s1'|'s2'|'s3'
// rowOrder: rowId -> [codes in order]
let rowMap = {};
let rowOrder = { h1:[], s1:[], s2:[], s3:[] };

const HAND_ROWS    = ['h1'];
const STAGE_ROWS   = ['s1','s2','s3'];
const ALL_ROWS     = [...STAGE_ROWS, ...HAND_ROWS];

// ---- Persistence ----
function handStateKey() { return `pd_hand_${roomCode}_${myName}`; }

function saveHandState() {
  try {
    localStorage.setItem(handStateKey(), JSON.stringify({ rowMap, rowOrder }));
  } catch(e) {}
}

function loadHandState(hand) {
  try {
    const raw = localStorage.getItem(handStateKey());
    if (!raw) return false;
    const saved = JSON.parse(raw);
    // Reject old format that used h2/h3 rows
    if (saved.rowOrder?.h2 !== undefined || saved.rowOrder?.h3 !== undefined) {
      localStorage.removeItem(handStateKey());
      return false;
    }
    // Only restore if all saved cards are still in hand
    const handSet = new Set(hand);
    const savedCards = Object.keys(saved.rowMap);
    if (!savedCards.every(c => handSet.has(c))) return false;
    rowMap = saved.rowMap;
    rowOrder = saved.rowOrder;
    // Add any new cards (drawn since last save) to h1
    for (const c of hand) {
      if (!rowMap[c]) { rowMap[c] = 'h1'; rowOrder.h1.push(c); }
    }
    return true;
  } catch(e) { return false; }
}

function clearHandState() {
  try { localStorage.removeItem(handStateKey()); } catch(e) {}
  rowMap = {};
  rowOrder = { h1:[], s1:[], s2:[], s3:[] };
}

function initHandState(hand) {
  // Default: all cards in single hand row h1
  clearHandState();
  hand.forEach(c => {
    rowMap[c] = 'h1';
    rowOrder.h1.push(c);
  });
}

function syncHandState(hand) {
  // Remove cards no longer in hand
  const handSet = new Set(hand);
  for (const row of ALL_ROWS) {
    rowOrder[row] = rowOrder[row].filter(c => handSet.has(c));
  }
  for (const c of Object.keys(rowMap)) {
    if (!handSet.has(c)) delete rowMap[c];
  }
  // Add new cards (drawn) to h1
  for (const c of hand) {
    if (!rowMap[c]) { rowMap[c] = 'h1'; rowOrder.h1.push(c); }
  }
}

// ---- Drag state ----
// Single shared drag state — one source of truth, no per-row closure copies
let dragCard = null;
let dragFromRow = null;

// Current hand snapshot — updated by renderHand so drag handlers always see fresh data
// without holding stale closure references
let _currentHand = [];
let _currentIsMyTurn = false;

function endDrag(targetRowId, targetCode) {
  document.querySelectorAll('.card.dragging').forEach(c => c.classList.remove('dragging'));
  document.querySelectorAll('.row-drop-target.drag-active').forEach(r => r.classList.remove('drag-active'));
  if (!dragCard || !targetRowId) { dragCard = null; dragFromRow = null; return; }

  const src = dragCard;
  const srcRow = dragFromRow;
  dragCard = null; dragFromRow = null;

  if (srcRow === targetRowId && !targetCode) return; // dropped on same row empty space

  // Remove from source row
  rowOrder[srcRow] = rowOrder[srcRow].filter(c => c !== src);

  // Insert into target row
  const arr = rowOrder[targetRowId];
  if (targetCode && targetCode !== src && arr.includes(targetCode)) {
    arr.splice(arr.indexOf(targetCode), 0, src);
  } else {
    arr.push(src);
  }
  rowMap[src] = targetRowId;
  saveHandState();
}

// ---- Drag logic (shared, stateless relative to rows) ----
// These are module-level so they're created exactly ONCE.
let _dragActive = false;
let _dragStartX = 0, _dragStartY = 0;
let _dragActiveCode = null, _dragActiveEl = null, _dragRowEl = null;

const OVERLAP = 20;
const CARD_W  = 40;
const VISIBLE = CARD_W - OVERLAP;

function _getCardAtInFan(rowEl, clientX, clientY) {
  const cards = Array.from(rowEl.querySelectorAll('.card[data-code]'));
  if (!cards.length) return null;
  const rowRect = rowEl.getBoundingClientRect();
  if (clientY < rowRect.top || clientY > rowRect.bottom) return null;
  const firstRect = cards[0].getBoundingClientRect();
  const startLeft = firstRect.left;
  let matched = null;
  cards.forEach((card, idx) => {
    const cardLeft = startLeft + idx * VISIBLE;
    const cardRight = idx === cards.length - 1 ? cardLeft + CARD_W : cardLeft + VISIBLE;
    if (clientX >= cardLeft && clientX <= cardRight) matched = card;
  });
  return matched;
}

function _onDragStart(rowEl, clientX, clientY) {
  const isFan = rowEl.classList.contains('fan-row');
  let cardEl;
  if (isFan) {
    cardEl = _getCardAtInFan(rowEl, clientX, clientY);
  } else {
    cardEl = document.elementFromPoint(clientX, clientY)?.closest('.card[data-code]');
    if (cardEl && !rowEl.contains(cardEl)) cardEl = null;
  }
  if (!cardEl) return false;
  _dragActiveCode = cardEl.dataset.code;
  _dragActiveEl   = cardEl;
  _dragRowEl      = rowEl;
  dragCard        = _dragActiveCode;
  dragFromRow     = rowEl.dataset.row;
  _dragStartX     = clientX;
  _dragStartY     = clientY;
  _dragActive     = false;
  return true;
}

function _onDragMove(clientX, clientY, e) {
  if (!_dragActiveCode) return;
  const dx = Math.abs(clientX - _dragStartX), dy = Math.abs(clientY - _dragStartY);
  if (!_dragActive && (dx > 4 || dy > 4)) {
    _dragActive = true;
    _dragActiveEl?.classList.add('dragging');
  }
  if (!_dragActive) return;
  if (e) e.preventDefault();
  document.querySelectorAll('.row-drop-target').forEach(r => r.classList.remove('drag-active'));
  const targetRow = document.elementFromPoint(clientX, clientY)?.closest('.row-drop-target');
  if (targetRow) targetRow.classList.add('drag-active');
}

function _onDragEnd(clientX, clientY) {
  if (!_dragActiveCode) return;
  const endEl = _dragActiveEl;
  _dragActiveCode = null; _dragActiveEl = null; _dragRowEl = null;
  if (!_dragActive) { _dragActive = false; dragCard = null; dragFromRow = null; return; }
  _dragActive = false;
  document.querySelectorAll('.row-drop-target.drag-active').forEach(r => r.classList.remove('drag-active'));

  if (endEl) endEl.style.visibility = 'hidden';
  const ptEl = document.elementFromPoint(clientX, clientY);
  if (endEl) endEl.style.visibility = '';

  document.querySelectorAll('.card.dragging').forEach(c => c.classList.remove('dragging'));

  const targetCardEl = ptEl?.closest('.card[data-code]');
  const targetRow    = ptEl?.closest('.row-drop-target');
  endDrag(targetRow?.dataset.row || null, targetCardEl?.dataset.code || null);
  // Use module-level hand snapshot — no stale closure
  renderHand(_currentHand, _currentIsMyTurn);
}

// ---- Attach drag listeners ONCE to a permanent row element ----
// Call this only at startup (or first render) per row element.
// Never call this inside renderHand or buildRow.
function attachDragListenersOnce(rowEl) {
  // Touch
  rowEl.addEventListener('touchstart', e => {
    _onDragStart(rowEl, e.touches[0].clientX, e.touches[0].clientY);
  }, { passive: true });
  rowEl.addEventListener('touchmove', e => {
    _onDragMove(e.touches[0].clientX, e.touches[0].clientY, e);
  }, { passive: false });
  rowEl.addEventListener('touchend', e => {
    _onDragEnd(e.changedTouches[0].clientX, e.changedTouches[0].clientY);
  });

  // Mouse
  rowEl.addEventListener('mousedown', e => {
    if (!_onDragStart(rowEl, e.clientX, e.clientY)) return;
    e.preventDefault();
    const onMove = ev => _onDragMove(ev.clientX, ev.clientY, ev);
    const onUp   = ev => {
      _onDragEnd(ev.clientX, ev.clientY);
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}

// Attach once to all 4 permanent row elements at startup
(function initDragListeners() {
  ['stage-row-1', 'stage-row-2', 'stage-row-3', 'hand-row'].forEach(id => {
    const el = $(id);
    if (el) attachDragListenersOnce(el);
  });
})();

// ---- renderHand: only updates card children, never recreates rows ----
function renderHand(hand, isMyTurn) {
  // Update module-level snapshot so drag handlers always see current state
  _currentHand = hand;
  _currentIsMyTurn = isMyTurn;

  syncHandState(hand);

  // ---- Staging rows (static elements, just repopulate cards) ----
  STAGE_ROWS.forEach((rowId, i) => {
    const container = $(`stage-row-${i+1}`);
    if (!container) return;
    container.innerHTML = '';
    rowOrder[rowId].forEach(code => {
      const el = buildCardEl(code, true);
      el.dataset.code = code;
      if (selectedCards.has(code)) el.classList.add('selected');
      if (gameState?.openingCard === code) el.classList.add('must-play');
      el.addEventListener('click', () => { if (_currentIsMyTurn) toggleCard(code, _currentHand); });
      container.appendChild(el);
    });
  });

  // ---- Hand fan row (static element, just repopulate cards) ----
  const fanRow = $('hand-row');
  if (!fanRow) return;
  fanRow.innerHTML = '';
  rowOrder.h1.forEach((code, idx) => {
    const el = buildCardEl(code, true);
    el.dataset.code = code;
    if (selectedCards.has(code)) el.classList.add('selected');
    if (gameState?.openingCard === code) el.classList.add('must-play');
    el.style.zIndex = idx + 1;
    el.style.position = 'relative';
    if (idx < rowOrder.h1.length - 1) el.style.marginRight = '-20px';
    el.addEventListener('click', () => { if (_currentIsMyTurn) toggleCard(code, _currentHand); });
    fanRow.appendChild(el);
  });
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
  renderHand(_currentHand, _currentIsMyTurn);
  updateButtons(gameState, _currentIsMyTurn);
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
  clearHandState();
  clearSession();
  roomCode = '';
  myName = '';
  selectedCards.clear();
  socket.emit('quitGame');
  showScreen('screen-landing');
});
// ---- DRAWN CARD MODAL ----
let drawnCardPending = null;
let drawnModalTimer = null;

function showDrawnModal(card) {
  drawnCardPending = card;
  const display = $('drawn-card-display');
  display.innerHTML = '';
  display.appendChild(buildCardEl(card, false));
  $('drawn-modal').classList.remove('hidden');
  // Auto-dismiss after 4 seconds
  clearTimeout(drawnModalTimer);
  drawnModalTimer = setTimeout(dismissDrawnModal, 4000);
}

function dismissDrawnModal() {
  clearTimeout(drawnModalTimer);
  $('drawn-modal').classList.add('hidden');
  drawnCardPending = null;
}

$('btn-drawn-ok').addEventListener('click', dismissDrawnModal);

socket.on('drewCard', ({ card }) => {
  showDrawnModal(card);
});

$('btn-sort').addEventListener('click', () => {
  if (!gameState) return;
  initHandState(_currentHand);
  saveHandState();
  const me = gameState.players.find(p => p.name === myName);
  renderHand(_currentHand, gameState.currentPlayerId === me?.id);
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

// ---- PLAY HISTORY ----
let historyOpen = false;

$('btn-history').addEventListener('click', () => {
  historyOpen = !historyOpen;
  $('history-panel').classList.toggle('hidden', !historyOpen);
  $('btn-history').classList.toggle('open', historyOpen);
  if (historyOpen) renderHistory(gameState?.playHistory || []);
});

function renderHistory(history) {
  const container = $('history-entries');
  if (!container) return;
  container.innerHTML = '';

  if (!history || history.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'history-empty';
    empty.textContent = 'No plays yet';
    container.appendChild(empty);
    return;
  }

  const COMBO_LABEL = {
    'single': 'Single', 'pair': 'Pair', 'triple': 'Triple',
    'straight': 'Straight', 'full-house': 'Full House',
    'four-of-a-kind': 'Four of a Kind', 'straight-flush': 'Straight Flush',
  };

  history.forEach((entry, idx) => {
    const row = document.createElement('div');
    row.className = 'history-entry';

    const meta = document.createElement('div');
    meta.className = 'history-entry-meta';
    meta.innerHTML = `
      <div class="history-entry-name">${esc(entry.name)}</div>
      <div class="history-entry-type">${COMBO_LABEL[entry.combo.type] || entry.combo.type}</div>
    `;

    const cards = document.createElement('div');
    cards.className = 'history-entry-cards';
    for (const code of entry.combo.cards) {
      cards.appendChild(buildCardEl(code, false));
    }

    row.appendChild(meta);
    row.appendChild(cards);
    container.appendChild(row);
  });
}

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
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    // Only rejoin if THIS tab was already in a room (roomCode set in memory)
    // Don't use localStorage here — that could steal another device's session
    if (!roomCode || !myName) return;

    if (!socket.connected) {
      socket.connect();
    } else {
      socket.emit('rejoinRoom', { code: roomCode, name: myName });
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

  // Only auto-rejoin if this is a genuine reconnect (socket dropped and came back)
  // NOT on a fresh page load — that would steal another device's session
  if (!isReconnecting) {
    isReconnecting = false;
    return;
  }

  // Reconnect after a drop — restore session
  const session = loadSession();
  const rejoinCode = roomCode || session.code;
  const rejoinName = myName || session.name;

  if (rejoinCode && rejoinName) {
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
  // Load session now so it's available when connect fires
  // (in case the tab was reloaded and in-memory vars were cleared)
  const session = loadSession();
  if (!roomCode && session.code) roomCode = session.code;
  if (!myName && session.name) myName = session.name;
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
  // Try to restore saved arrangement, else init fresh split
  if (!loadHandState(hand)) {
    initHandState(hand);
  }
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

  // Keep history panel fresh if it's open
  if (historyOpen) renderHistory(state.playHistory || []);

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
  clearHandState();
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
  historyOpen = false;
  $('history-panel').classList.add('hidden');
  $('btn-history').classList.remove('open');
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
