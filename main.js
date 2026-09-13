// Neon Deck — lobby and shell.
//
// The lobby is where theme selection happens, and theme selection is one of the
// three questions this repo answers. So the lobby is instrumented at least as
// carefully as the games: it records what you *looked at* and for how long, not
// only what you chose. A choice without the rejected alternatives is a very thin
// fact, and no amount of downstream modelling can put the alternatives back.
//
// The live event feed on the right is not decoration. It is the argument of
// chapter 01 made visible: every affordance you touch produces a row, and the
// shape of those rows is a design decision you are making right now, whether or
// not you think of it that way.

import { Telemetry } from "./telemetry.js";
import { THEMES, THEME_IDS, DEFAULT_THEME, theme } from "./themes.js";
import { makeRng } from "./engine.js";
import { Blackjack } from "./blackjack.js";
import { Slots } from "./slots.js";

const params = new URLSearchParams(location.search);
const seedParam = params.get("seed");
const rng = makeRng(seedParam === null ? null : Number(seedParam));

const tm = new Telemetry({ batchSize: Number(params.get("batch") ?? 20) });
const canvas = document.getElementById("stage");
const feedEl = document.getElementById("feed");
const themeBar = document.getElementById("themes");
const statusEl = document.getElementById("status");

let currentTheme = DEFAULT_THEME;
let game = null;
let previewStartedAt = Date.now();
let previewing = DEFAULT_THEME;

// ─── Live event feed ──────────────────────────────────────────────────────────
const FEED_MAX = 120;
tm.onEmit((evt) => {
  const row = document.createElement("div");
  row.className = "evt";
  const ctxBits = [evt.context.table_id, evt.context.round_id, evt.context.hand_id]
    .filter(Boolean)
    .map((s) => s.split("_").slice(0, 2).join("_"));
  row.innerHTML =
    `<span class="seq">${String(evt.seq).padStart(4, "0")}</span>` +
    `<span class="name">${evt.event_name}</span>` +
    `<span class="ctx">${ctxBits.join(" ")}</span>` +
    `<span class="pl">${summarise(evt.payload)}</span>`;
  feedEl.prepend(row);
  while (feedEl.childElementCount > FEED_MAX) feedEl.lastElementChild.remove();
  statusEl.textContent = `${evt.seq + 1} events · ${tm.sent} sent · ${tm.dropped} dropped`;
});

function summarise(payload) {
  const keys = Object.keys(payload).slice(0, 3);
  return keys
    .map((k) => {
      const v = payload[k];
      const s = Array.isArray(v) ? v.join("") : String(v);
      return `${k}=${s.length > 18 ? s.slice(0, 18) + "…" : s}`;
    })
    .join(" ");
}

// ─── Theme selection ──────────────────────────────────────────────────────────
function buildThemeBar() {
  for (const id of THEME_IDS) {
    const t = THEMES[id];
    const b = document.createElement("button");
    b.className = "theme-chip";
    b.dataset.theme = id;
    b.style.setProperty("--felt", t.felt);
    b.style.setProperty("--accent", t.accent);
    b.innerHTML = `<span class="swatch"></span>${t.name}`;
    b.addEventListener("mouseenter", () => startPreview(id));
    b.addEventListener("click", () => selectTheme(id));
    themeBar.appendChild(b);
  }
  markSelected();
}

function startPreview(id) {
  if (previewing === id) return;
  const dwell = Date.now() - previewStartedAt;
  // Only record a preview the player actually looked at. A pointer crossing three
  // chips on its way to a fourth is not interest, and recording it as interest is
  // how you end up with a "most previewed theme" that is simply the leftmost one.
  if (dwell >= 250) {
    tm.emit("theme_previewed", {
      theme_id: previewing,
      to_theme_id: id,
      dwell_ms: dwell,
      selected: false,
    });
  }
  previewing = id;
  previewStartedAt = Date.now();
}

function selectTheme(id) {
  if (id === currentTheme) return;
  const from = currentTheme;
  currentTheme = id;
  tm.emit("theme_selected", {
    theme_id: id,
    from_theme_id: from,
    dwell_ms: Date.now() - previewStartedAt,
    in_game: game !== null,
  });
  tm.setContext({ theme_id: id });
  previewStartedAt = Date.now();
  previewing = id;
  markSelected();
  applyChrome();
  if (game) game.setTheme(id);
  else renderLobby();
}

function markSelected() {
  for (const el of themeBar.querySelectorAll(".theme-chip")) {
    el.classList.toggle("on", el.dataset.theme === currentTheme);
  }
}

function applyChrome() {
  const t = theme(currentTheme);
  document.body.style.setProperty("--accent", t.accent);
  document.body.style.setProperty("--felt", t.felt);
  document.body.style.setProperty("--text", t.text);
}

// ─── Lobby ────────────────────────────────────────────────────────────────────
let lobbyBoxes = [];

function renderLobby() {
  const t = theme(currentTheme);
  const ctx = canvas.getContext("2d");
  const W = canvas.width;
  const H = canvas.height;
  lobbyBoxes = [];

  const g = ctx.createRadialGradient(W / 2, H / 2, 40, W / 2, H / 2, W * 0.8);
  g.addColorStop(0, t.feltEdge);
  g.addColorStop(1, t.felt);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);

  ctx.textAlign = "center";
  ctx.fillStyle = t.accent;
  ctx.font = "700 44px ui-sans-serif, system-ui, sans-serif";
  ctx.fillText("NEON DECK", W / 2, H / 2 - 110);
  ctx.fillStyle = t.text + "cc";
  ctx.font = "15px ui-sans-serif, system-ui, sans-serif";
  ctx.fillText(`${t.name} · ${t.register} · ${t.intensity} intensity`, W / 2, H / 2 - 78);

  card("Blackjack", "Multi-seat · decisions · splits", W / 2 - 200, H / 2 - 30, 190, 120, t, () => open("blackjack"));
  card("Slots", "One press · no decisions · autospin", W / 2 + 10, H / 2 - 30, 190, 120, t, () => open("slots"));

  ctx.fillStyle = t.text + "77";
  ctx.font = "12px ui-sans-serif, system-ui, sans-serif";
  ctx.fillText("Everything you touch here becomes a row in the event log on the right.", W / 2, H / 2 + 130);

  function card(title, sub, x, y, w, h, t, fn) {
    ctx.fillStyle = "#ffffff10";
    ctx.strokeStyle = t.accent + "77";
    ctx.lineWidth = 2;
    roundRect(ctx, x, y, w, h, 12);
    ctx.fill();
    ctx.stroke();
    ctx.lineWidth = 1;
    ctx.fillStyle = t.text;
    ctx.font = "600 20px ui-sans-serif, system-ui, sans-serif";
    ctx.fillText(title, x + w / 2, y + 52);
    ctx.fillStyle = t.text + "99";
    ctx.font = "12px ui-sans-serif, system-ui, sans-serif";
    ctx.fillText(sub, x + w / 2, y + 78);
    lobbyBoxes.push({ x, y, w, h, fn });
  }
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

canvas.addEventListener("click", (e) => {
  if (game) return; // the running game installs its own handler
  const r = canvas.getBoundingClientRect();
  const x = (e.clientX - r.left) * (canvas.width / r.width);
  const y = (e.clientY - r.top) * (canvas.height / r.height);
  for (const b of lobbyBoxes) {
    if (x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) return b.fn();
  }
});

function open(which) {
  const common = { canvas, telemetry: tm, themeId: currentTheme, rng, onExit: exitGame };
  game = which === "blackjack" ? new Blackjack(common) : new Slots(common);
}

function exitGame() {
  game.destroy();
  game = null;
  renderLobby();
}

// ─── Idle detection ───────────────────────────────────────────────────────────
// Session length is meaningless without it. Thirty minutes of a tab left open is
// not thirty minutes of play, and every "average session" number that does not
// subtract idle time is quietly inflated.
let lastActivity = Date.now();
let idle = false;
const IDLE_MS = 45_000;
for (const ev of ["click", "keydown", "mousemove"]) {
  globalThis.addEventListener(ev, () => {
    lastActivity = Date.now();
    if (idle) {
      idle = false;
      tm.emit("idle_end", { idle_ms: Date.now() - idleStartedAt });
    }
  }, { passive: true });
}
let idleStartedAt = 0;
setInterval(() => {
  if (!idle && Date.now() - lastActivity > IDLE_MS) {
    idle = true;
    idleStartedAt = lastActivity + IDLE_MS;
    tm.emit("idle_start", { since_ms: IDLE_MS });
  }
}, 5000);

// ─── Boot ─────────────────────────────────────────────────────────────────────
buildThemeBar();
applyChrome();
tm.emit("app_opened", {
  viewport_w: globalThis.innerWidth,
  viewport_h: globalThis.innerHeight,
  theme_id: currentTheme,
  seeded: seedParam !== null,
});
renderLobby();
