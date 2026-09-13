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
const ENDPOINT = "/collect";

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
}
