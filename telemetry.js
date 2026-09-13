// Neon Deck telemetry.
//
// One envelope for every event, from both games. The shape here IS the contract
// that chapters 02-07 depend on, so it is worth reading before anything else.
//
// Design decisions, and why:
//
//   event_id     Client-generated UUID. The collector dedupes on it, which is what
//                makes retries safe. Without a client-side idempotency key you
//                cannot retry a failed batch without double-counting.
//   seq          Monotonic per session. Gaps in seq are the only way to detect
//                events lost in a beacon that never landed -- a count alone can't.
//   occurred_at  The client's clock, when the thing happened.
//   sent_at      The client's clock, when the batch left the browser.
//   received_at  The server's clock. Added by the collector, never by us.
//                (received_at - sent_at) is your clock-skew estimate; chapter 01
//                shows why you must keep all three and never collapse them.
//   event_version Bumped when a payload changes shape. Chapter 02 has to read
//                two versions of the same event at once, which is the normal
//                state of affairs and not an error condition.

const STORAGE_KEY = "neondeck.player_id";
const EVENTS_KEY = "neondeck.events";
const ENDPOINT = "/collect";

// Without a collector (GitHub Pages, file://) the browser is the only event log
// there is. It is a bounded one: localStorage gives us a few MB, so the oldest
// events are evicted first and `trimmed` says how many are gone.
const LOCAL_MAX = 5000;

function uuid() {
  // crypto.randomUUID is unavailable on file:// in some browsers; fall back so the
  // game still runs when opened directly off disk with no collector at all.
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

// A player is a browser, remembered across sessions. This is exactly the identity
// an analytics system actually has -- not a real person -- and chapter 03 makes a
// point of that when it applies a policy to it.
function stablePlayerId() {
  try {
    let id = localStorage.getItem(STORAGE_KEY);
    if (!id) {
      id = "p_" + uuid().replace(/-/g, "").slice(0, 12);
      localStorage.setItem(STORAGE_KEY, id);
    }
    return id;
  } catch {
    // Private browsing: a new player every time, and no way to know it is the
    // same person. This is not a bug to fix; it is the ceiling on identity
    // resolution, and chapter 06 runs into it.
    return "p_anon_" + uuid().replace(/-/g, "").slice(0, 8);
  }
}

export class Telemetry {
  constructor({ batchSize = 20, flushMs = 4000, endpoint = ENDPOINT } = {}) {
    this.playerId = stablePlayerId();
    this.sessionId = "s_" + uuid().replace(/-/g, "").slice(0, 12);
    this.seq = 0;
    this.queue = [];
    this.batchSize = batchSize;
    this.endpoint = endpoint;
    this.context = {};          // merged into every event; games set table_id etc.
    this.dropped = 0;           // batches the collector refused or that failed
    this.sent = 0;
    this.trimmed = 0;           // oldest local events evicted to stay under quota
    this.storedCount = this.stored().length;
    this.listeners = [];

    this.timer = setInterval(() => this.flush(), flushMs);

    // A tab close is the single most common way to lose the end of a session.
    // sendBeacon survives unload; fetch() does not.
    globalThis.addEventListener?.("pagehide", () => this.flush({ beacon: true }));
    globalThis.addEventListener?.("visibilitychange", () => {
      if (document.visibilityState === "hidden") this.flush({ beacon: true });
    });
  }

  // Games call this when they enter a table, so every subsequent event carries the
  // table, seat and shoe without each call site having to remember.
  setContext(patch) {
    this.context = { ...this.context, ...patch };
    for (const [k, v] of Object.entries(patch)) {
      if (v === null || v === undefined) delete this.context[k];
    }
  }

  onEmit(fn) {
    this.listeners.push(fn);
  }

  emit(eventName, payload = {}, { version = 1, context = {} } = {}) {
    const evt = {
      event_id: uuid(),
      event_name: eventName,
      event_version: version,
      occurred_at: new Date().toISOString(),
      session_id: this.sessionId,
      player_id: this.playerId,
      seq: this.seq++,
      context: { ...this.context, ...context },
      payload,
    };
    this.queue.push(evt);
    for (const fn of this.listeners) fn(evt);
    if (this.queue.length >= this.batchSize) this.flush();
    return evt;
  }

  flush({ beacon = false } = {}) {
    if (this.queue.length === 0) return;
    const batch = {
      batch_id: uuid(),
      sent_at: new Date().toISOString(),
      // The client tells the server how many it thinks it is sending. If the two
      // disagree, something between them is lying and you want to know.
      count: this.queue.length,
      events: this.queue,
    };
    this.queue = [];
    this.store(batch);
    if (!this.endpoint) return;
    const body = JSON.stringify(batch);

    if (beacon && navigator.sendBeacon) {
      const ok = navigator.sendBeacon(this.endpoint, new Blob([body], { type: "application/json" }));
      if (ok) this.sent += batch.count;
      else this.dropped += batch.count;
      return;
    }

    fetch(this.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      keepalive: true,
    })
      .then((r) => {
        if (r.ok) this.sent += batch.count;
        else this.dropped += batch.count;
      })
      .catch(() => {
        // No collector running (you opened index.html off the filesystem). The
        // game must keep working; losing telemetry is not a reason to break play.
        this.dropped += batch.count;
      });
  }

  // Keeps batch_id and sent_at on each row, so a local export has the same
  // columns the collector would have written, minus received_at.
  store(batch) {
    const rows = batch.events.map((e) => ({ ...e, batch_id: batch.batch_id, sent_at: batch.sent_at }));
    let all = this.stored().concat(rows);
    if (all.length > LOCAL_MAX) {
      this.trimmed += all.length - LOCAL_MAX;
      all = all.slice(-LOCAL_MAX);
    }
    while (all.length) {
      try {
        localStorage.setItem(EVENTS_KEY, JSON.stringify(all));
        this.storedCount = all.length;
        return;
      } catch (err) {
        if (err?.name !== "QuotaExceededError") return; // storage unavailable
        const drop = Math.ceil(all.length / 2);
        this.trimmed += drop;
        all = all.slice(drop);
      }
    }
  }

  stored() {
    try {
      return JSON.parse(localStorage.getItem(EVENTS_KEY) ?? "[]");
    } catch {
      return [];
    }
  }

  clearStored() {
    this.queue = [];
    this.trimmed = 0;
    this.storedCount = 0;
    try {
      localStorage.removeItem(EVENTS_KEY);
    } catch {}
  }
}

// One row per event. Context keys are few and stable, so they become their own
// columns; payloads differ per event_name, so each stays a single JSON cell
// rather than exploding into hundreds of mostly-empty columns.
export function eventsToCsv(events) {
  const base = ["event_id", "event_name", "event_version", "occurred_at", "sent_at",
    "session_id", "player_id", "seq", "batch_id"];
  const ctxKeys = [...new Set(events.flatMap((e) => Object.keys(e.context ?? {})))].sort();
  const header = [...base, ...ctxKeys.map((k) => `context.${k}`), "payload"];
  const cell = (v) => {
    if (v === null || v === undefined) return "";
    const s = typeof v === "object" ? JSON.stringify(v) : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = events.map((e) =>
    [...base.map((k) => e[k]), ...ctxKeys.map((k) => e.context?.[k]), e.payload].map(cell).join(","));
  return [header.join(","), ...lines].join("\r\n");
}
