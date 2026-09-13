// Neon Deck — slots.
//
// The second game exists so that the layers above have something to reconcile.
// Slots and blackjack share a player, a session vocabulary and a theme, but almost
// nothing else: there is no decision, no seat, no opponent, and a "round" lasts two
// seconds rather than ninety. Any semantic layer that can express "hold percentage"
// across both without lying has earned the name, and chapter 04 is largely about
// discovering that the naive shared definition does lie.
//
// The deliberate asymmetry with blackjack:
//   blackjack  one wager, several hands, decisions, a shared table
//   slots      one wager, one outcome, no decisions, solitary
// Chapter 05 is where the ontology says why both are nonetheless `Wager`s.

import { REEL_SYMBOLS, theme } from "./themes.js";

const BET_LADDER = [1, 2, 5, 10, 25, 50];
let idCounter = 0;
const nextId = (p) => `${p}_${Date.now().toString(36)}_${(idCounter++).toString(36)}`;

// Reel weights. Index 3 is the "7" in every theme's symbol list, and it is rare.
// The paytable and weights together set the return to player; nothing in this repo
// quotes an RTP figure from this comment, because chapter 01's notebook measures it
// from the events instead. That is the house rule: numbers come from executed cells.
const WEIGHTS = [10, 12, 14, 3, 16, 18];
const PAYTABLE = { 0: 45, 1: 28, 2: 19, 3: 125, 4: 12, 5: 8 };
// Two of a kind pays LESS than the stake. That is not a mistake and not a bug --
// it is a "loss disguised as a win": the machine says "Win 3" while taking 5, and
// the player files it under wins. It matters here because it is the cleanest
// example in the whole repo of a metric that is correct and useless. Counting
// `win_kind != 'no_win'` gives a win rate near 40%; counting `net > 0` gives
// something far lower, and both are honest answers to different questions.
// Chapter 04 makes the semantic layer pick one and name it.
const TWO_OF_A_KIND = 0.6;
const SEVENS_PAIR = 2;

export class Slots {
  constructor({ canvas, telemetry, themeId, rng = Math.random, onExit }) {
    this.cv = canvas;
    this.ctx = canvas.getContext("2d");
    this.tm = telemetry;
    this.themeId = themeId;
    this.rng = rng;
    this.onExit = onExit;

    this.machineId = nextId("m");
    this.bet = 5;
    this.balance = 500;
    this.reels = [0, 1, 2];
    this.spinning = false;
    this.lastWin = 0;
    this.spins = 0;
    this.autoRemaining = 0;
    this.autoPlanned = 0;
    this.message = "Spin to play";
    this.hitboxes = [];
    this.openedAt = Date.now();

    this.cumWeights = [];
    let acc = 0;
    for (const w of WEIGHTS) {
      acc += w;
      this.cumWeights.push(acc);
    }
    this.weightTotal = acc;

    this.tm.setContext({
      game: "slots",
      theme_id: this.themeId,
      table_id: this.machineId,
      seat_no: null,
      shoe_id: null,
    });
    this.tm.emit("game_opened", {
      game: "slots",
      seats_total: 1,
      min_bet: BET_LADDER[0],
      max_bet: BET_LADDER[BET_LADDER.length - 1],
      opening_balance: this.balance,
    });

    this.onClick = (e) => this.handleClick(e);
    this.cv.addEventListener("click", this.onClick);
    this.render();
  }

  destroy() {
    this.autoRemaining = 0;
    this.cv.removeEventListener("click", this.onClick);
    this.tm.emit("game_closed", {
      game: "slots",
      reason: "back",
      duration_ms: Date.now() - this.openedAt,
      rounds_played: this.spins,
      closing_balance: this.balance,
    });
    this.tm.setContext({ table_id: null, theme_id: this.themeId });
  }

  setTheme(themeId) {
    this.themeId = themeId;
    this.tm.setContext({ theme_id: themeId });
    this.render();
  }

  changeBet(delta) {
    const i = BET_LADDER.indexOf(this.bet);
    const to = BET_LADDER[Math.max(0, Math.min(BET_LADDER.length - 1, i + delta))];
    if (to === this.bet) return;
    // Bet changes are recorded as transitions, not levels. "Went from 25 to 5 after
    // a losing streak" is the shape of the answer chapter 08 needs for the bet
    // minimum question, and a level-only record cannot express it.
    this.tm.emit("bet_changed", { bet_from: this.bet, bet_to: to, balance: this.balance });
    this.bet = to;
    this.render();
  }

  topUp() {
    const before = this.balance;
    this.balance += 500;
    this.tm.emit("balance_topped_up", {
      amount: 500,
      balance_before: before,
      balance_after: this.balance,
      rounds_played: this.spins,
    });
    this.render();
  }

  pickSymbol() {
    const r = this.rng() * this.weightTotal;
    for (let i = 0; i < this.cumWeights.length; i++) if (r < this.cumWeights[i]) return i;
    return this.cumWeights.length - 1;
  }

  evaluateReels(reels) {
    const [a, b, c] = reels;
    if (a === b && b === c) return { multiplier: PAYTABLE[a], kind: "three_of_a_kind", symbol: a };
    if (a === b || b === c || a === c) {
      const sym = a === b ? a : b === c ? b : a;
      return { multiplier: sym === 3 ? SEVENS_PAIR : TWO_OF_A_KIND, kind: "two_of_a_kind", symbol: sym };
    }
    return { multiplier: 0, kind: "no_win", symbol: null };
  }

  spin({ auto = false } = {}) {
    if (this.spinning) return;
    if (this.balance < this.bet) {
      this.message = "Out of credit";
      this.autoRemaining = 0;
      this.render();
      return;
    }
    const spinId = nextId("sp");
    this.spinning = true;
    const balanceBefore = this.balance;
    this.balance -= this.bet;

    this.tm.emit("spin_requested", {
      bet: this.bet,
      balance_before: balanceBefore,
      autospin: auto,
      autospin_remaining: this.autoRemaining,
    }, { context: { round_id: spinId } });

    const reels = [this.pickSymbol(), this.pickSymbol(), this.pickSymbol()];
    const res = this.evaluateReels(reels);
    const payout = Math.round(this.bet * res.multiplier);

    // A short animation, then resolution. The delay is real elapsed time and shows
    // up in the gap between spin_requested and spin_resolved -- which is how you
    // measure spin rate without the client having to compute it.
    const frames = 12;
    let f = 0;
    const tick = () => {
      if (f++ < frames) {
        this.reels = [this.pickSymbol(), this.pickSymbol(), this.pickSymbol()];
        this.render();
        setTimeout(tick, 45);
        return;
      }
      this.reels = reels;
      this.balance += payout;
      this.lastWin = payout;
      this.spins++;
      this.spinning = false;
      this.message = payout > 0 ? `Win ${payout}` : "No win";

      this.tm.emit("spin_resolved", {
        bet: this.bet,
        symbols: reels.map((i) => REEL_SYMBOLS[this.themeId]?.[i] ?? String(i)),
        symbol_indices: reels,
        win_kind: res.kind,
        multiplier: res.multiplier,
        payout,
        net: payout - this.bet,
        balance_after: this.balance,
        autospin: auto,
      }, { context: { round_id: spinId } });

      this.render();
      if (this.autoRemaining > 0) {
        this.autoRemaining--;
        if (this.autoRemaining === 0) {
          this.tm.emit("autospin_stopped", {
            spins_planned: this.autoPlanned,
            spins_done: this.autoPlanned,
            stop_reason: "completed",
          });
        } else if (this.balance < this.bet) {
          this.tm.emit("autospin_stopped", {
            spins_planned: this.autoPlanned,
            spins_done: this.autoPlanned - this.autoRemaining,
            stop_reason: "out_of_credit",
          });
          this.autoRemaining = 0;
        } else {
          setTimeout(() => this.spin({ auto: true }), 220);
        }
      }
    };
    setTimeout(tick, 45);
  }

  startAuto(n) {
    if (this.autoRemaining > 0) {
      this.tm.emit("autospin_stopped", {
        spins_planned: this.autoPlanned,
        spins_done: this.autoPlanned - this.autoRemaining,
        stop_reason: "cancelled",
      });
      this.autoRemaining = 0;
      this.render();
      return;
    }
    this.autoPlanned = n;
    this.autoRemaining = n;
    this.tm.emit("autospin_started", { spins_planned: n, bet: this.bet, balance: this.balance });
    this.spin({ auto: true });
  }

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

  render() {
    const t = theme(this.themeId);
    const ctx = this.ctx;
    const W = this.cv.width;
    const H = this.cv.height;
    this.hitboxes = [];

    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, t.feltEdge);
    g.addColorStop(1, t.felt);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);

    ctx.fillStyle = t.text;
    ctx.font = "600 15px ui-sans-serif, system-ui, sans-serif";
    ctx.textAlign = "left";
    ctx.fillText(`Balance ${this.balance}`, 20, 30);
    ctx.fillStyle = t.accent;
    ctx.fillText(t.name, 20, 52);
    ctx.fillStyle = t.text;
    ctx.textAlign = "right";
    ctx.fillText(`Spins ${this.spins}`, W - 20, 30);
    if (this.autoRemaining > 0) ctx.fillText(`Auto ${this.autoRemaining}`, W - 20, 52);

    // Reels
    const rw = 130;
    const rh = 160;
    const gap = 18;
    const totalW = rw * 3 + gap * 2;
    let x = W / 2 - totalW / 2;
    const y = H / 2 - rh / 2 - 40;
    const symbols = REEL_SYMBOLS[this.themeId] ?? REEL_SYMBOLS.neon_nights;
    for (let i = 0; i < 3; i++) {
      ctx.fillStyle = "#00000055";
      ctx.strokeStyle = t.accent + "88";
      ctx.lineWidth = 2;
      this.roundRect(x, y, rw, rh, 12);
      ctx.fill();
      ctx.stroke();
      ctx.lineWidth = 1;
      ctx.fillStyle = t.text;
      ctx.font = "64px ui-sans-serif, system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(symbols[this.reels[i]], x + rw / 2, y + rh / 2);
      ctx.textBaseline = "alphabetic";
      x += rw + gap;
    }

    ctx.textAlign = "center";
    ctx.fillStyle = this.lastWin > 0 ? t.accent : t.text;
    ctx.font = "600 18px ui-sans-serif, system-ui, sans-serif";
    ctx.fillText(this.message, W / 2, y + rh + 44);

    // Controls
    const cy = H - 100;
    ctx.fillStyle = t.text + "aa";
    ctx.font = "13px ui-sans-serif, system-ui, sans-serif";
    ctx.textAlign = "left";
    ctx.fillText(`Bet ${this.bet}`, 24, cy + 26);
    this.button("−", 92, cy + 8, 32, 32, t, () => this.changeBet(-1), { enabled: !this.spinning });
    this.button("+", 130, cy + 8, 32, 32, t, () => this.changeBet(1), { enabled: !this.spinning });

    this.button("Spin", W / 2 - 60, cy, 120, 48, t, () => this.spin(), {
      primary: true,
      enabled: !this.spinning && this.autoRemaining === 0,
    });
    this.button(this.autoRemaining > 0 ? "Stop" : "Auto ×25", W / 2 + 74, cy + 8, 96, 32, t, () => this.startAuto(25), {
      enabled: !this.spinning || this.autoRemaining > 0,
    });
    if (this.balance < this.bet) this.button("Add 500", W / 2 + 182, cy + 8, 88, 32, t, () => this.topUp());

    this.button("Lobby", W - 104, H - 44, 80, 30, t, () => this.onExit());
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
}
