// Neon Deck — blackjack.
//
// A real multi-seat table: you sit in one seat, bots fill the rest, and the number
// of seats is a dial the player controls. That dial is the point. "How many seats
// per table?" is one of the three questions this whole repo exists to answer, and
// it is unanswerable unless the app records both the setting and its consequence
// (hand rate, session length, abandonment).
//
// The grain trap lives here too. A split turns one wager into two hands with two
// independent outcomes. Every event below is emitted at the grain it actually
// happens at -- `wager_placed` per hand, `round_settled` per round -- and never
// flattened. Chapters 02 and 04 spend real effort on the consequences.

import { Shoe, evaluate, isPair, basicStrategy, legalise, dealerShouldHit, settle } from "./engine.js";
import { theme } from "./themes.js";

const CHIPS = [1, 5, 25, 100];
let idCounter = 0;
const nextId = (p) => `${p}_${Date.now().toString(36)}_${(idCounter++).toString(36)}`;

// Bots exist to make the table feel occupied and to make seat count mean something
// (more seats = slower rounds). They are not players and are never instrumented as
// such -- chapter 02 checks that no bot ever appears in the player dimension.
const BOT_NAMES = ["Rae", "Kip", "Mo", "Sol", "Wren", "Ida", "Zed"];

export class Blackjack {
  constructor({ canvas, telemetry, themeId, rng = Math.random, onExit }) {
    this.cv = canvas;
    this.ctx = canvas.getContext("2d");
    this.tm = telemetry;
    this.themeId = themeId;
    this.rng = rng;
    this.onExit = onExit;

    this.tableId = nextId("t");
    this.seats = 3;
    this.humanSeat = 0;
    this.minBet = 5;
    this.maxBet = 500;
    this.balance = 500;
    this.pendingBet = 0;
    this.phase = "betting";
    this.hands = [];          // active hands for the human seat
    this.activeHand = 0;
    this.botHands = [];
    this.dealer = [];
    this.roundId = null;
    this.message = "Place your bet";
    this.hitboxes = [];
    this.decisionOfferedAt = 0;
    this.roundStartedAt = 0;
    this.openedAt = Date.now();
    this.roundsPlayed = 0;

    this.shoe = new Shoe({ decks: 6, penetration: 0.75, rng });

    this.tm.setContext({
      game: "blackjack",
      theme_id: this.themeId,
      table_id: this.tableId,
      seat_no: this.humanSeat,
      shoe_id: this.shoe.id,
    });
    this.tm.emit("game_opened", {
      game: "blackjack",
      seats_total: this.seats,
      min_bet: this.minBet,
      max_bet: this.maxBet,
      opening_balance: this.balance,
    });
    this.tm.emit("seat_taken", { seat_no: this.humanSeat, seats_total: this.seats });

    this.onClick = (e) => this.handleClick(e);
    this.cv.addEventListener("click", this.onClick);
    this.render();
  }

  destroy() {
    this.cv.removeEventListener("click", this.onClick);
    this.tm.emit("seat_left", { seat_no: this.humanSeat, reason: "navigated" });
    this.tm.emit("game_closed", {
      game: "blackjack",
      reason: "back",
      duration_ms: Date.now() - this.openedAt,
      rounds_played: this.roundsPlayed,
      closing_balance: this.balance,
    });
    this.tm.setContext({ table_id: null, seat_no: null, shoe_id: null, round_id: null, hand_id: null });
  }

  setTheme(themeId) {
    this.themeId = themeId;
    this.tm.setContext({ theme_id: themeId });
    this.render();
  }

  // ── Table configuration ─────────────────────────────────────────────────────
  // Every change is an event. A product owner asking "does anyone actually move
  // the minimum?" gets a real answer instead of a guess, and chapter 08 needs the
  // *transitions*, not just the final state, to say anything about sensitivity.
  changeSeats(delta) {
    const from = this.seats;
    const to = Math.max(1, Math.min(5, this.seats + delta));
    if (to === from) return;
    this.seats = to;
    this.humanSeat = Math.min(this.humanSeat, to - 1);
    this.tm.emit("table_config_changed", {
      field: "seats",
      seats_from: from,
      seats_to: to,
      min_bet_from: this.minBet,
      min_bet_to: this.minBet,
    });
    this.tm.setContext({ seat_no: this.humanSeat });
    this.render();
  }

  changeMinBet(delta) {
    const ladder = [1, 3, 5, 10, 25, 50, 100];
    const i = ladder.indexOf(this.minBet);
    const to = ladder[Math.max(0, Math.min(ladder.length - 1, i + delta))];
    if (to === this.minBet) return;
    const from = this.minBet;
    this.minBet = to;
    this.tm.emit("table_config_changed", {
      field: "min_bet",
      min_bet_from: from,
      min_bet_to: to,
      seats_from: this.seats,
      seats_to: this.seats,
    });
    this.render();
  }

  // ── Bet construction ────────────────────────────────────────────────────────
  // Chips are recorded as they are added, not only as a final total. "Reached for
  // 100 then took it back" is a different player from "bet 25", and the final
  // wager alone cannot tell them apart.
  addChip(denom) {
    if (this.phase !== "betting") return;
    if (this.pendingBet + denom > Math.min(this.maxBet, this.balance)) return;
    this.pendingBet += denom;
    this.tm.emit("chip_added", { denom, bet_total_after: this.pendingBet, balance: this.balance });
    this.render();
  }

  clearBet() {
    if (this.phase !== "betting" || this.pendingBet === 0) return;
    this.tm.emit("chip_cleared", { bet_total_before: this.pendingBet });
    this.pendingBet = 0;
    this.render();
  }

  topUp() {
    const before = this.balance;
    this.balance += 500;
    // Reloading after going broke is the single strongest behavioural signal in
    // this dataset. Chapter 05 turns it into an ontology class; chapter 08 asks
    // what you are obliged to do about it.
    this.tm.emit("balance_topped_up", {
      amount: 500,
      balance_before: before,
      balance_after: this.balance,
      rounds_played: this.roundsPlayed,
    });
    this.render();
  }

  // ── Round lifecycle ─────────────────────────────────────────────────────────
  deal() {
    if (this.phase !== "betting") return;
    if (this.pendingBet < this.minBet) {
      this.message = `Minimum bet is ${this.minBet}`;
      this.render();
      return;
    }
    if (this.shoe.needsShuffle) {
      const prev = this.shoe.shuffle();
      this.tm.emit("shoe_shuffled", {
        shoe_id_old: prev,
        shoe_id_new: this.shoe.id,
        decks: this.shoe.decks,
      });
      this.tm.setContext({ shoe_id: this.shoe.id });
    }

    this.roundId = nextId("r");
    this.roundStartedAt = Date.now();
    this.tm.setContext({ round_id: this.roundId });
    this.tm.emit("round_started", {
      seats_occupied: this.seats,
      cards_remaining: this.shoe.remaining,
      penetration: 1 - this.shoe.remaining / this.shoe.cards.length,
    });

    const wager = this.pendingBet;
    this.balance -= wager;
    this.pendingBet = 0;

    const handId = nextId("h");
    this.hands = [{ id: handId, cards: [], wager, doubled: false, done: false, fromSplit: false }];
    this.activeHand = 0;
    this.botHands = [];
    for (let s = 0; s < this.seats; s++) {
      if (s === this.humanSeat) continue;
      this.botHands.push({ seat: s, name: BOT_NAMES[s % BOT_NAMES.length], cards: [], done: false });
    }
    this.dealer = [];

    this.tm.emit("wager_placed", {
      amount: wager,
      balance_before: this.balance + wager,
      balance_after: this.balance,
      min_bet: this.minBet,
      is_split_hand: false,
    }, { context: { hand_id: handId } });

    // Deal order matters for card-counting realism, and the event records what the
    // player could see: their own cards and the dealer's up card, nothing else.
    for (let i = 0; i < 2; i++) {
      this.hands[0].cards.push(this.shoe.draw());
      for (const b of this.botHands) b.cards.push(this.shoe.draw());
      this.dealer.push(this.shoe.draw());
    }

    this.phase = "playing";
    this.tm.emit("cards_dealt", {
      cards: this.hands[0].cards.map((c) => c.rank + c.suit),
      hand_total: evaluate(this.hands[0].cards).total,
      is_soft: evaluate(this.hands[0].cards).soft,
      dealer_up: this.dealer[0].rank,
    }, { context: { hand_id: handId } });

    if (evaluate(this.hands[0].cards).blackjack) {
      this.hands[0].done = true;
      this.finishRound();
      return;
    }
    this.offerDecision();
  }

  currentOptions() {
    const h = this.hands[this.activeHand];
    const opts = ["hit", "stand"];
    if (h.cards.length === 2 && this.balance >= h.wager) opts.push("double");
    if (h.cards.length === 2 && isPair(h.cards) && this.balance >= h.wager && this.hands.length < 4) {
      opts.push("split");
    }
    return opts;
  }

  offerDecision() {
    const h = this.hands[this.activeHand];
    const ev = evaluate(h.cards);
    this.decisionOfferedAt = Date.now();
    this.tm.emit("decision_offered", {
      options: this.currentOptions(),
      hand_total: ev.total,
      is_soft: ev.soft,
      dealer_up: this.dealer[0].rank,
      card_count: h.cards.length,
    }, { context: { hand_id: h.id } });
    this.message = "Your move";
    this.render();
  }

  act(action) {
    if (this.phase !== "playing") return;
    const options = this.currentOptions();
    if (!options.includes(action)) return;

    const h = this.hands[this.activeHand];
    const ev = evaluate(h.cards);
    const ideal = basicStrategy(h.cards, this.dealer[0].rank);
    const advised = legalise(ideal, options, h.cards);

    // The decision event is the richest thing this app produces. It carries the
    // state the decision was made in, the latency, what the player did, and what
    // basic strategy would have done -- all at the moment it is knowable.
    this.tm.emit("decision_made", {
      action,
      latency_ms: Date.now() - this.decisionOfferedAt,
      hand_total: ev.total,
      is_soft: ev.soft,
      dealer_up: this.dealer[0].rank,
      options_offered: options,
      basic_strategy_action: advised,
      basic_strategy_ideal: ideal,
      deviated: action !== advised,
      wager: h.wager,
      is_split_hand: h.fromSplit,
      // Version 2: `basic_strategy_ideal` and `deviated` were added after launch.
      // The event log still contains v1 rows without them, and always will --
      // chapter 02 has to read both. See fabric/collect/simulate.py, which
      // backfills a history that straddles the change.
    }, { version: 2, context: { hand_id: h.id } });

    if (action === "hit") {
      h.cards.push(this.shoe.draw());
      if (evaluate(h.cards).busted) {
        h.done = true;
        this.advanceHand();
      } else {
        this.offerDecision();
      }
      return;
    }
    if (action === "stand") {
      h.done = true;
      this.advanceHand();
      return;
    }
    if (action === "double") {
      this.balance -= h.wager;
      h.doubled = true;
      h.cards.push(this.shoe.draw());
      h.done = true;
      this.advanceHand();
      return;
    }
    if (action === "split") {
      this.balance -= h.wager;
      const child = {
        id: nextId("h"),
        cards: [h.cards.pop()],
        wager: h.wager,
        doubled: false,
        done: false,
        fromSplit: true,
      };
      h.fromSplit = true;
      h.cards.push(this.shoe.draw());
      child.cards.push(this.shoe.draw());
      this.hands.splice(this.activeHand + 1, 0, child);

      // The event that makes the grain explicit. One wager_placed already exists
      // for the parent; this is a second, and any downstream count of "wagers per
      // round" that assumes one is now wrong.
      this.tm.emit("hand_split", {
        parent_hand_id: h.id,
        child_hand_id: child.id,
        hands_in_round: this.hands.length,
      }, { context: { hand_id: h.id } });
      this.tm.emit("wager_placed", {
        amount: child.wager,
        balance_before: this.balance + child.wager,
        balance_after: this.balance,
        min_bet: this.minBet,
        is_split_hand: true,
      }, { context: { hand_id: child.id } });

      this.offerDecision();
    }
  }

  advanceHand() {
    while (this.activeHand < this.hands.length && this.hands[this.activeHand].done) this.activeHand++;
    if (this.activeHand < this.hands.length) {
      this.offerDecision();
      return;
    }
    this.playBots();
    this.finishRound();
  }

  playBots() {
    for (const b of this.botHands) {
      let guard = 0;
      while (!evaluate(b.cards).busted && basicStrategy(b.cards, this.dealer[0].rank) !== "stand" && guard++ < 8) {
        const a = legalise(basicStrategy(b.cards, this.dealer[0].rank), ["hit", "stand"], b.cards);
        if (a === "stand") break;
        b.cards.push(this.shoe.draw());
      }
      b.done = true;
    }
  }

  finishRound() {
    this.phase = "dealer";
    const anyLive = this.hands.some((h) => !evaluate(h.cards).busted);
    if (anyLive) {
      let guard = 0;
      while (dealerShouldHit(this.dealer) && guard++ < 10) this.dealer.push(this.shoe.draw());
    }

    let totalWagered = 0;
    let totalPayout = 0;
    for (const h of this.hands) {
      const r = settle({
        playerCards: h.cards,
        dealerCards: this.dealer,
        wager: h.wager,
        doubled: h.doubled,
        fromSplit: h.fromSplit,
      });
      this.balance += r.payout;
      totalWagered += r.stake;
      totalPayout += r.payout;
      const pev = evaluate(h.cards);
      const dev = evaluate(this.dealer);
      this.tm.emit("hand_settled", {
        outcome: r.outcome,
        wager: r.stake,
        payout: r.payout,
        net: r.net,
        doubled: h.doubled,
        is_split_hand: h.fromSplit,
        final_total: pev.total,
        dealer_total: dev.total,
        dealer_busted: dev.busted,
        cards: h.cards.map((c) => c.rank + c.suit),
      }, { context: { hand_id: h.id } });
    }

    this.roundsPlayed++;
    this.tm.emit("round_settled", {
      hands_count: this.hands.length,
      total_wagered: totalWagered,
      total_payout: totalPayout,
      net: totalPayout - totalWagered,
      duration_ms: Date.now() - this.roundStartedAt,
      seats_occupied: this.seats,
      balance_after: this.balance,
    });

    this.tm.setContext({ round_id: null, hand_id: null });
    this.phase = "betting";
    const net = totalPayout - totalWagered;
    this.message = net > 0 ? `You win ${net}` : net < 0 ? `You lose ${-net}` : "Push";
    this.render();
  }

  // ── Input ───────────────────────────────────────────────────────────────────
  handleClick(e) {
    const r = this.cv.getBoundingClientRect();
    const x = (e.clientX - r.left) * (this.cv.width / r.width);
    const y = (e.clientY - r.top) * (this.cv.height / r.height);
    for (const hb of this.hitboxes) {
      if (x >= hb.x && x <= hb.x + hb.w && y >= hb.y && y <= hb.y + hb.h) {
        hb.fn();
        return;
      }
    }
  }

  // ── Rendering ───────────────────────────────────────────────────────────────
  render() {
    const t = theme(this.themeId);
    const ctx = this.ctx;
    const W = this.cv.width;
    const H = this.cv.height;
    this.hitboxes = [];

    const g = ctx.createRadialGradient(W / 2, H * 0.42, 40, W / 2, H * 0.42, W * 0.75);
    g.addColorStop(0, t.feltEdge);
    g.addColorStop(1, t.felt);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);

    ctx.fillStyle = t.text;
    ctx.font = "600 15px ui-sans-serif, system-ui, sans-serif";
    ctx.textAlign = "left";
    ctx.fillText(`Balance ${this.balance}`, 20, 30);
    ctx.fillStyle = t.accent;
    ctx.fillText(`${t.name}`, 20, 52);
    ctx.fillStyle = t.text;
    ctx.textAlign = "right";
    ctx.fillText(`Shoe ${this.shoe.remaining} cards`, W - 20, 30);
    ctx.fillText(`Round ${this.roundsPlayed}`, W - 20, 52);

    // Dealer
    ctx.textAlign = "center";
    ctx.fillStyle = t.text;
    ctx.font = "13px ui-sans-serif, system-ui, sans-serif";
    ctx.fillText("Dealer", W / 2, 86);
    const hideHole = this.phase === "playing";
    this.drawCards(this.dealer, W / 2, 100, t, hideHole);
    if (!hideHole && this.dealer.length) {
      const d = evaluate(this.dealer);
      ctx.fillStyle = d.busted ? "#ff6b6b" : t.text;
      ctx.fillText(String(d.total), W / 2, 196);
    }

    // Seats
    const seatY = H - 250;
    const slot = W / (this.seats + 1);
    let botIdx = 0;
    for (let s = 0; s < this.seats; s++) {
      const cx = slot * (s + 1);
      if (s === this.humanSeat) {
        ctx.fillStyle = t.accent;
        ctx.font = "600 13px ui-sans-serif, system-ui, sans-serif";
        ctx.fillText("You", cx, seatY - 8);
        let ox = 0;
        for (const h of this.hands) {
          const hx = cx + ox;
          this.drawCards(h.cards, hx, seatY, t, false);
          const ev = evaluate(h.cards);
          ctx.fillStyle = ev.busted ? "#ff6b6b" : this.hands.indexOf(h) === this.activeHand && this.phase === "playing" ? t.accent2 : t.text;
          ctx.font = "12px ui-sans-serif, system-ui, sans-serif";
          ctx.fillText(`${ev.total}${h.doubled ? " ×2" : ""}  ·  ${h.wager}`, hx, seatY + 96);
          ox += this.hands.length > 1 ? 96 : 0;
        }
      } else {
        const b = this.botHands[botIdx++];
        ctx.fillStyle = t.text + "99";
        ctx.font = "12px ui-sans-serif, system-ui, sans-serif";
        ctx.fillText(b ? b.name : BOT_NAMES[s % BOT_NAMES.length], cx, seatY - 8);
        if (b) {
          this.drawCards(b.cards, cx, seatY, t, false, 0.55);
          const ev = evaluate(b.cards);
          ctx.fillStyle = t.text + "99";
          ctx.fillText(String(ev.total), cx, seatY + 96);
        }
      }
    }

    ctx.fillStyle = t.text;
    ctx.font = "600 16px ui-sans-serif, system-ui, sans-serif";
    ctx.fillText(this.message, W / 2, H - 132);

    if (this.phase === "betting") this.drawBettingControls(t, W, H);
    else if (this.phase === "playing") this.drawActionControls(t, W, H);

    this.drawTableControls(t, W, H);
  }

  drawCards(cards, cx, y, t, hideSecond, scale = 1) {
    const w = 52 * scale;
    const h = 74 * scale;
    const gap = 20 * scale;
    const total = cards.length ? (cards.length - 1) * gap + w : 0;
    let x = cx - total / 2;
    const ctx = this.ctx;
    cards.forEach((c, i) => {
      const hidden = hideSecond && i === 1;
      ctx.fillStyle = hidden ? t.accent2 : "#fdfdfb";
      ctx.strokeStyle = hidden ? t.accent : "#00000033";
      this.roundRect(x, y, w, h, 6 * scale);
      ctx.fill();
      ctx.stroke();
      if (!hidden) {
        ctx.fillStyle = c.suit === "♥" || c.suit === "♦" ? "#c92a2a" : "#1a1a1a";
        ctx.font = `600 ${14 * scale}px ui-sans-serif, system-ui, sans-serif`;
        ctx.textAlign = "left";
        ctx.fillText(c.rank, x + 5 * scale, y + 18 * scale);
        ctx.font = `${16 * scale}px ui-sans-serif, system-ui, sans-serif`;
        ctx.fillText(c.suit, x + 5 * scale, y + 38 * scale);
        ctx.textAlign = "center";
      }
      x += gap;
    });
    ctx.textAlign = "center";
  }

  roundRect(x, y, w, h, r) {
    const ctx = this.ctx;
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  button(label, x, y, w, h, t, fn, { primary = false, enabled = true } = {}) {
    const ctx = this.ctx;
    ctx.globalAlpha = enabled ? 1 : 0.35;
    ctx.fillStyle = primary ? t.accent : "#ffffff14";
    ctx.strokeStyle = primary ? t.accent : t.text + "44";
    this.roundRect(x, y, w, h, 8);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = primary ? "#0b0b12" : t.text;
    ctx.font = "600 13px ui-sans-serif, system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(label, x + w / 2, y + h / 2 + 5);
    ctx.globalAlpha = 1;
    if (enabled) this.hitboxes.push({ x, y, w, h, fn });
  }

  drawBettingControls(t, W, H) {
    const y = H - 108;
    let x = W / 2 - (CHIPS.length * 62) / 2 - 70;
    const ctx = this.ctx;
    ctx.fillStyle = t.text;
    ctx.font = "13px ui-sans-serif, system-ui, sans-serif";
    ctx.textAlign = "right";
    ctx.fillText(`Bet ${this.pendingBet}`, x - 12, y + 26);
    ctx.textAlign = "center";
    for (const d of CHIPS) {
      const cx = x + 26;
      const cy = y + 20;
      ctx.beginPath();
      ctx.arc(cx, cy, 20, 0, Math.PI * 2);
      ctx.fillStyle = "#ffffff10";
      ctx.fill();
      ctx.lineWidth = 3;
      ctx.strokeStyle = t.chipRim;
      ctx.stroke();
      ctx.lineWidth = 1;
      ctx.fillStyle = t.text;
      ctx.font = "600 12px ui-sans-serif, system-ui, sans-serif";
      ctx.fillText(String(d), cx, cy + 4);
      this.hitboxes.push({ x: cx - 20, y: cy - 20, w: 40, h: 40, fn: () => this.addChip(d) });
      x += 62;
    }
    this.button("Clear", x + 4, y, 62, 40, t, () => this.clearBet(), { enabled: this.pendingBet > 0 });
    this.button("Deal", x + 74, y, 80, 40, t, () => this.deal(), {
      primary: true,
      enabled: this.pendingBet >= this.minBet,
    });
    if (this.balance < this.minBet) {
      this.button("Add 500", x + 162, y, 84, 40, t, () => this.topUp());
    }
  }

  drawActionControls(t, W, H) {
    const opts = this.currentOptions();
    const labels = { hit: "Hit", stand: "Stand", double: "Double", split: "Split" };
    const all = ["hit", "stand", "double", "split"];
    const w = 88;
    let x = W / 2 - (all.length * (w + 10)) / 2;
    const y = H - 108;
    for (const a of all) {
      this.button(labels[a], x, y, w, 40, t, () => this.act(a), {
        primary: a === "hit",
        enabled: opts.includes(a),
      });
      x += w + 10;
    }
  }

  drawTableControls(t, W, H) {
    const y = H - 52;
    const ctx = this.ctx;
    ctx.fillStyle = t.text + "aa";
    ctx.font = "12px ui-sans-serif, system-ui, sans-serif";
    ctx.textAlign = "left";
    ctx.fillText(`Seats ${this.seats}`, 24, y + 26);
    this.button("−", 88, y + 8, 30, 30, t, () => this.changeSeats(-1), { enabled: this.phase === "betting" && this.seats > 1 });
    this.button("+", 124, y + 8, 30, 30, t, () => this.changeSeats(1), { enabled: this.phase === "betting" && this.seats < 5 });

    ctx.fillStyle = t.text + "aa";
    ctx.textAlign = "left";
    ctx.fillText(`Min bet ${this.minBet}`, 176, y + 26);
    this.button("−", 262, y + 8, 30, 30, t, () => this.changeMinBet(-1), { enabled: this.phase === "betting" });
    this.button("+", 298, y + 8, 30, 30, t, () => this.changeMinBet(1), { enabled: this.phase === "betting" });

    this.button("Lobby", W - 104, y + 8, 80, 30, t, () => this.onExit());
    ctx.textAlign = "center";
  }
}
