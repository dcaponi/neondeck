// Shared game engine: shuffling, hand evaluation, and basic strategy.
//
// The basic-strategy table is here for one reason that has nothing to do with
// playing well: it lets every `decision_made` event carry the action basic strategy
// would have taken alongside the action the player actually took. That single extra
// field is what makes "deviates from basic strategy" answerable at all -- and it
// costs nothing to record at the moment of the decision, while reconstructing it
// afterwards from a warehouse means re-implementing the game's rules in SQL.
//
// This is chapter 01's thesis in one field: instrument the decision, not the result.

// ─── Randomness ───────────────────────────────────────────────────────────────
// A seedable PRNG so a simulated run is reproducible. The browser uses Math.random
// unless a seed is supplied via ?seed=.
export function makeRng(seed) {
  if (seed === undefined || seed === null) return Math.random;
  let s = seed >>> 0;
  return function rng() {
    // mulberry32
    s |= 0;
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ─── Cards ────────────────────────────────────────────────────────────────────
export const RANKS = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"];
export const SUITS = ["♠", "♥", "♦", "♣"];

export function cardValue(rank) {
  if (rank === "A") return 11;
  if (rank === "10" || rank === "J" || rank === "Q" || rank === "K") return 10;
  return Number(rank);
}

export class Shoe {
  // A real shoe, because penetration matters: `cards_remaining` at the moment a
  // round starts is a fact you cannot recover later, and it is the difference
  // between "this player left after a bad run" and "this player left at the shuffle".
  constructor({ decks = 6, penetration = 0.75, rng = Math.random } = {}) {
    this.decks = decks;
    this.penetration = penetration;
    this.rng = rng;
    this.id = null;
    this.cards = [];
    this.shuffle();
  }

  shuffle() {
    const cards = [];
    for (let d = 0; d < this.decks; d++) {
      for (const s of SUITS) for (const r of RANKS) cards.push({ rank: r, suit: s });
    }
    for (let i = cards.length - 1; i > 0; i--) {
      const j = Math.floor(this.rng() * (i + 1));
      [cards[i], cards[j]] = [cards[j], cards[i]];
    }
    this.cards = cards;
    this.dealt = 0;
    this.cutCard = Math.floor(cards.length * this.penetration);
    const prev = this.id;
    this.id = "shoe_" + Math.floor(this.rng() * 1e9).toString(36);
    return prev;
  }

  get remaining() {
    return this.cards.length - this.dealt;
  }

  // True once the cut card is reached. The shoe is not reshuffled mid-round; the
  // caller reshuffles between rounds, which is how a real pit works.
  get needsShuffle() {
    return this.dealt >= this.cutCard;
  }

  draw() {
    if (this.dealt >= this.cards.length) this.shuffle();
    return this.cards[this.dealt++];
  }
}

// ─── Hand evaluation ──────────────────────────────────────────────────────────
// Returns { total, soft, busted, blackjack }. `soft` means an ace is still counted
// as 11, which is the distinction the strategy table turns on.
export function evaluate(cards) {
  let total = 0;
  let aces = 0;
  for (const c of cards) {
    const v = cardValue(c.rank);
    total += v;
    if (c.rank === "A") aces++;
  }
  let soft = aces > 0;
  while (total > 21 && aces > 0) {
    total -= 10;
    aces--;
  }
  if (aces === 0) soft = false;
  return {
    total,
    soft,
    busted: total > 21,
    blackjack: cards.length === 2 && total === 21,
  };
}

export function isPair(cards) {
  return cards.length === 2 && cardValue(cards[0].rank) === cardValue(cards[1].rank);
}

// ─── Basic strategy ───────────────────────────────────────────────────────────
// Six decks, dealer stands on soft 17, double after split allowed, no surrender.
// Returns one of "hit" | "stand" | "double" | "split".
//
// This is the *ideal* action, computed independently of what the UI happens to be
// offering. `legalise()` below reduces it to something the player could actually
// press, and both values are recorded -- because "wanted to double but couldn't
// afford it" and "chose not to double" are different behaviours that a single
// column would flatten into one.
export function basicStrategy(playerCards, dealerUpRank) {
  const up = cardValue(dealerUpRank); // 2..11, ace is 11
  const { total, soft } = evaluate(playerCards);

  if (isPair(playerCards)) {
    const r = playerCards[0].rank;
    const v = cardValue(r);
    if (r === "A") return "split";
    if (v === 10) return "stand";
    if (v === 9) return up >= 2 && up <= 6 ? "split" : up === 8 || up === 9 ? "split" : "stand";
    if (v === 8) return "split";
    if (v === 7) return up <= 7 ? "split" : "hit";
    if (v === 6) return up <= 6 ? "split" : "hit";
    if (v === 5) return up <= 9 ? "double" : "hit"; // never split fives; play as hard 10
    if (v === 4) return up === 5 || up === 6 ? "split" : "hit";
    if (v === 3 || v === 2) return up <= 7 ? "split" : "hit";
  }

  if (soft) {
    if (total >= 19) return "stand";
    if (total === 18) {
      if (up >= 3 && up <= 6) return "double";
      if (up === 2 || up === 7 || up === 8) return "stand";
      return "hit";
    }
    if (total === 17) return up >= 3 && up <= 6 ? "double" : "hit";
    if (total === 16 || total === 15) return up >= 4 && up <= 6 ? "double" : "hit";
    if (total === 14 || total === 13) return up >= 5 && up <= 6 ? "double" : "hit";
    return "hit";
  }

  if (total >= 17) return "stand";
  if (total >= 13) return up <= 6 ? "stand" : "hit";
  if (total === 12) return up >= 4 && up <= 6 ? "stand" : "hit";
  if (total === 11) return up <= 10 ? "double" : "hit";
  if (total === 10) return up <= 9 ? "double" : "hit";
  if (total === 9) return up >= 3 && up <= 6 ? "double" : "hit";
  return "hit";
}

// Reduce an ideal action to one the player can actually take right now.
// The convention is the standard one: a double you cannot take becomes a hit,
// except on soft 18 where it becomes a stand.
export function legalise(action, options, playerCards) {
  if (options.includes(action)) return action;
  if (action === "double") {
    const { total, soft } = evaluate(playerCards);
    if (soft && total === 18) return "stand";
    return "hit";
  }
  if (action === "split") return basicStrategyNoSplit(playerCards, options);
  return options.includes("stand") ? "stand" : options[0];
}

function basicStrategyNoSplit(playerCards, options) {
  const { total } = evaluate(playerCards);
  if (total >= 17) return "stand";
  return options.includes("hit") ? "hit" : "stand";
}

// ─── Dealer ───────────────────────────────────────────────────────────────────
// Stands on all 17s, including soft. Stated explicitly because S17 vs H17 changes
// the strategy table above, and a reader who changes one without the other will
// produce a dataset where "deviation" quietly means nothing.
export function dealerShouldHit(cards) {
  return evaluate(cards).total < 17;
}

// ─── Payouts ──────────────────────────────────────────────────────────────────
export const BLACKJACK_PAYOUT = 1.5; // 3:2

// `fromSplit` matters: 21 on the first two cards of a split hand is a plain 21,
// not a blackjack, and pays even money. Getting this wrong is worth about half a
// point of house edge, which is most of the edge in the game.
export function settle({ playerCards, dealerCards, wager, doubled, fromSplit = false }) {
  const p = evaluate(playerCards);
  const d = evaluate(dealerCards);
  const stake = doubled ? wager * 2 : wager;
  const playerBj = p.blackjack && !fromSplit;

  if (p.busted) return { outcome: "loss", payout: 0, net: -stake, stake };
  if (playerBj && !d.blackjack) {
    return { outcome: "blackjack", payout: stake + stake * BLACKJACK_PAYOUT, net: stake * BLACKJACK_PAYOUT, stake };
  }
  if (d.blackjack && !playerBj) return { outcome: "loss", payout: 0, net: -stake, stake };
  if (d.busted) return { outcome: "win", payout: stake * 2, net: stake, stake };
  if (p.total > d.total) return { outcome: "win", payout: stake * 2, net: stake, stake };
  if (p.total < d.total) return { outcome: "loss", payout: 0, net: -stake, stake };
  return { outcome: "push", payout: stake, net: 0, stake };
}
