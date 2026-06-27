// ============================================================
// PISOY DOS — Game Logic
// ============================================================

const { randomInt } = require('crypto');

const FACE_VALUES = ['3','4','5','6','7','8','9','10','J','Q','K','A','2'];
const SUITS = ['C','S','H','D']; // clubs < spades < hearts < diamonds

function faceRank(face) { return FACE_VALUES.indexOf(face); }
function suitRank(suit) { return SUITS.indexOf(suit); }

function parseCard(code) {
  const suit = code.slice(-1);
  const face = code.slice(0, -1);
  return { face, suit, code };
}

function cardValue(code) {
  const { face, suit } = parseCard(code);
  return faceRank(face) * 4 + suitRank(suit);
}

function compareCards(a, b) { return cardValue(a) - cardValue(b); }

function sortCards(cards) { return [...cards].sort(compareCards); }

// ---- Combination detection ----

function detectCombination(cards) {
  const n = cards.length;
  if (n === 0) return null;

  if (n === 1) return { type: 'single', rank: cardValue(cards[0]), cards };

  if (n === 2) {
    const [a, b] = cards.map(parseCard);
    if (a.face === b.face) {
      const highSuit = Math.max(suitRank(a.suit), suitRank(b.suit));
      const rank = faceRank(a.face) * 4 + highSuit;
      return { type: 'pair', rank, cards };
    }
    return null;
  }

  if (n === 3) {
    const parsed = cards.map(parseCard);
    const faces = parsed.map(c => c.face);
    if (faces.every(f => f === faces[0])) {
      return { type: 'triple', rank: faceRank(faces[0]), cards };
    }
    return null;
  }

  // Four-of-a-kind: exactly 4 cards, all same face — sits in the 5-card hierarchy tier
  if (n === 4) {
    const parsed = cards.map(parseCard);
    const faces = parsed.map(c => c.face);
    if (faces.every(f => f === faces[0])) {
      return { type: 'four-of-a-kind', rank: faceRank(faces[0]), cards };
    }
    return null;
  }

  if (n === 5) {
    return detect5Card(cards);
  }

  return null;
}

function detect5Card(cards) {
  const parsed = cards.map(parseCard);
  const faces = parsed.map(c => faceRank(c.face)).sort((a,b)=>a-b);
  const suits = parsed.map(c => c.suit);
  const isFlush = suits.every(s => s === suits[0]);
  const isStr = isStraightFaces(faces);

  // Straight flush
  if (isStr && isFlush) {
    const highCard = cards.reduce((a,b) => cardValue(a) > cardValue(b) ? a : b);
    return { type: 'straight-flush', rank: cardValue(highCard), cards };
  }

  // Full house
  const groups = groupByFace(parsed);
  const groupSizes = Object.values(groups).map(g => g.length).sort((a,b)=>b-a);
  if (groupSizes[0] === 3 && groupSizes[1] === 2) {
    const trioFace = Object.entries(groups).find(([,g]) => g.length === 3)[0];
    return { type: 'full-house', rank: faceRank(trioFace), cards };
  }

  // Straight
  if (isStr) {
    const highCard = cards.reduce((a,b) => cardValue(a) > cardValue(b) ? a : b);
    return { type: 'straight', rank: cardValue(highCard), cards };
  }

  return null;
}

function isStraightFaces(sortedFaceRanks) {
  for (let i = 1; i < sortedFaceRanks.length; i++) {
    if (sortedFaceRanks[i] !== sortedFaceRanks[i-1] + 1) return false;
  }
  // No wrap-arounds; 2 (rank 12) cannot appear in a straight
  if (sortedFaceRanks.includes(12)) return false;
  return true;
}

function groupByFace(parsedCards) {
  const g = {};
  for (const c of parsedCards) {
    g[c.face] = g[c.face] || [];
    g[c.face].push(c);
  }
  return g;
}

// ---- Combination type ordering ----
// four-of-a-kind (4 cards) sits between full-house and straight-flush
const COMBO_TIER = {
  'single':         0,
  'pair':           1,
  'triple':         2,
  'straight':       3,
  'full-house':     4,
  'four-of-a-kind': 5,
  'straight-flush': 6,
};

function beatsCombo(newCombo, currentCombo) {
  if (!currentCombo) return true;

  const newTier = COMBO_TIER[newCombo.type];
  const curTier = COMBO_TIER[currentCombo.type];

  // Singles, pairs, triples: same type required
  if (curTier <= 2) {
    if (newCombo.type !== currentCombo.type) return false;
    return newCombo.rank > currentCombo.rank;
  }

  // 5-card hierarchy (tiers 3+): higher tier always beats lower;
  // four-of-a-kind (tier 5) participates here even though it's only 4 cards
  if (curTier >= 3 && newTier >= 3) {
    if (newTier !== curTier) return newTier > curTier;
    return newCombo.rank > currentCombo.rank;
  }

  return false;
}

// ---- Deck ----
function createDeck() {
  const deck = [];
  for (const face of FACE_VALUES) {
    for (const suit of SUITS) {
      deck.push(face + suit);
    }
  }
  return deck;
}

// Cryptographically strong Fisher-Yates shuffle using crypto.randomInt
function shuffle(deck) {
  const d = [...deck];
  // Run 3 passes of Fisher-Yates — eliminates any theoretical starting-order bias
  for (let pass = 0; pass < 3; pass++) {
    for (let i = d.length - 1; i > 0; i--) {
      const j = randomInt(0, i + 1);
      [d[i], d[j]] = [d[j], d[i]];
    }
  }
  return d;
}

function dealCards(playerCount) {
  // Start from a randomly seeded order rather than always the same sequence
  const base = createDeck();
  // Cut the deck at a random point before shuffling (mimics real card handling)
  const cut = randomInt(0, base.length);
  const cut_deck = [...base.slice(cut), ...base.slice(0, cut)];
  const deck = shuffle(cut_deck);
  const hands = Array.from({ length: playerCount }, () => []);
  let cardsPerPlayer;

  if (playerCount === 2) cardsPerPlayer = 17;
  else if (playerCount === 3) cardsPerPlayer = 17;
  else cardsPerPlayer = 13;

  let idx = 0;
  for (let i = 0; i < playerCount; i++) {
    hands[i] = deck.slice(idx, idx + cardsPerPlayer);
    idx += cardsPerPlayer;
  }

  let extraCard = null;

  if (playerCount === 4) {
    // All 52 cards dealt. Player with 3♣ goes first and must open with it.
    // No extra card, openingCard is always 3♣.
    return { hands, extraCard: null, openingCard: '3C' };
  }

  if (playerCount === 3) {
    // Deal 17 each (51 cards). The 52nd card is revealed face-up to all players.
    // Normally: whoever has 3♣ in hand goes first (extra card just goes to them too).
    // Special case: if the 52nd card IS 3♣, the player holding 3♠ collects it and goes first.
    // Either way, the game doesn't start until all 3 players acknowledge seeing the card.
    extraCard = deck[51];
    // Don't add extra card to any hand yet — server waits for all acks first.
    return { hands, extraCard, openingCard: '3C' };
  }

  if (playerCount === 2) {
    // 17 cards each (34 total). 3♣ may be in the undealt pile.
    // Player with the lowest card IN HAND goes first and must open with that card.
    let lowestCard = null;
    for (let i = 0; i < hands.length; i++) {
      for (const card of hands[i]) {
        if (lowestCard === null || cardValue(card) < cardValue(lowestCard)) {
          lowestCard = card;
        }
      }
    }
    return { hands, extraCard: null, openingCard: lowestCard };
  }

  return { hands, extraCard, openingCard: '3C' };
}

// Find which hand index holds the opening card
function findStartingPlayer(hands, openingCard) {
  return hands.findIndex(h => h.includes(openingCard));
}

module.exports = {
  parseCard, cardValue, compareCards, sortCards,
  detectCombination, beatsCombo,
  createDeck, shuffle, dealCards, findStartingPlayer,
  FACE_VALUES, SUITS,
};

