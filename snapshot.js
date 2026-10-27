(function (root) {
  const VERSION = 1, MAX_BYTES = 262144;
  const FAILURE_KINDS = ["flaky", "test", "codeql", "deps", "secrets"];
  const object = x => x !== null && typeof x === "object" && !Array.isArray(x);
  const number = x => Number.isFinite(x) && x >= 0;
  const strings = x => Array.isArray(x) && x.every(y => typeof y === "string");
  function validate(snapshot) {
    if (!object(snapshot) || snapshot.version !== VERSION) throw new Error("Unsupported diner snapshot version.");
    if (!["hub", "classic"].includes(snapshot.view) || !object(snapshot.state)) throw new Error("Invalid diner snapshot.");
    const s = snapshot.state;
    const total = Array.isArray(s.queue) && Array.isArray(s.orders) ? s.queue.length + s.orders.length : 0;
    const fields = ["phase", "left", "elapsed", "active", "pr", "tips", "banked", "served", "queue", "orders", "chef"];
    if (Object.keys(s).some(k => !fields.includes(k)) || fields.some(k => !(k in s)) ||
        !["welcome", "shift", "over", "won"].includes(s.phase) ||
        !Number.isFinite(s.left) || !["elapsed", "pr", "tips", "banked", "served"].every(k => number(s[k])) ||
        s.served > total || typeof s.chef !== "string" || s.chef.length > 39 ||
        !(s.active === null || Number.isInteger(s.active)) ||
        !Array.isArray(s.queue) || !Array.isArray(s.orders) || total < 1 || total > 6) {
      throw new Error("Invalid diner shift state.");
    }
    const ids = new Set();
    for (const q of s.queue) {
      if (!object(q) || !number(q.at) || typeof q.d !== "string" || !strings(q.who) || q.who.length !== 2 ||
          !Number.isInteger(q.n) || q.n < 0 || q.n >= total || ids.has(q.n) ||
          !(q.fail === undefined || q.fail === null || FAILURE_KINDS.includes(q.fail))) throw new Error("Invalid diner queue.");
      ids.add(q.n);
    }
    for (const o of s.orders) {
      if (!object(o) || !Number.isInteger(o.id) || o.id < 40 || o.id >= 40 + total || ids.has(o.id - 40) ||
          !["line", "ordering", "cooking", "checks", "failing", "deploying", "ready", "returned", "served"].includes(o.status) ||
          !["name", "face", "speech", "text", "sent", "complaint"].every(k => typeof o[k] === "string") ||
          !["patience", "returns", "tip", "miss"].every(k => number(o[k])) ||
          !Number.isInteger(o.ci) || o.ci < 0 ||
          (o.status === "checks" && (!Array.isArray(o.checks) || o.ci >= o.checks.length)) ||
          !["handed", "fleet", "failFixed"].every(k => typeof o[k] === "boolean") ||
          !(o.failKind === null || FAILURE_KINDS.includes(o.failKind)) ||
          !object(o.want) || typeof o.want.dish !== "string" || !strings(o.want.opts) ||
          !object(o.draft) || !(o.draft.dish === null || typeof o.draft.dish === "string") || !strings(o.draft.opts) ||
          !(o.dish === null || typeof o.dish === "string") ||
          !["asked", "set", "flag", "tried", "log"].every(k => strings(o[k])) || !object(o.built) ||
          !Array.isArray(o.prs) || !o.prs.every(p => object(p) && number(p.n) && number(p.i) && typeof p.title === "string" && typeof p.emoji === "string") ||
          !Array.isArray(o.pending) || !o.pending.every(p => object(p) && number(p.i) && typeof p.title === "string" && typeof p.emoji === "string") ||
          !Array.isArray(o.checks) || !o.checks.every(c => object(c) && typeof c.id === "string" && ["queued", "running", "pass", "fail"].includes(c.state)) ||
          !(o.fail === null || (object(o.fail) && FAILURE_KINDS.includes(o.fail.kind) &&
            typeof o.fail.title === "string" && strings(o.fail.log) && Array.isArray(o.fail.fixes) &&
            o.fail.fixes.every(f => object(f) && ["id", "text", "why"].every(k => typeof f[k] === "string")))) ||
          !Number.isInteger(o.seat) || o.seat < 0 || o.seat >= total ||
          (o.delay !== undefined && (!object(o.delay) || !Object.entries(o.delay).every(([k, v]) =>
            ["deploy", "next", "thanks", "leave", "gone", "bank"].includes(k) && number(v))))) {
        throw new Error("Invalid diner order.");
      }
      ids.add(o.id - 40);
    }
    if (s.active !== null && !s.orders.some(o => o.id === s.active)) throw new Error("Invalid active order.");
    if (s.served !== s.orders.filter(o => o.status === "served").length) throw new Error("Invalid served count.");
    // Bound nesting and reject prototype keys even in optional/transient order data.
    function visit(value, depth = 0) {
      if (depth > 16) throw new Error("Diner snapshot is too deeply nested.");
      if (typeof value === "number" && !Number.isFinite(value)) throw new Error("Invalid snapshot number.");
      if (value && typeof value === "object") {
        for (const [key, child] of Object.entries(value)) {
          if (["__proto__", "prototype", "constructor", "timer"].includes(key)) throw new Error("Invalid snapshot key.");
          visit(child, depth + 1);
        }
      }
    }
    visit(snapshot);
    if (new TextEncoder().encode(JSON.stringify(snapshot)).length > MAX_BYTES) throw new Error("Diner snapshot is too large.");
    return snapshot;
  }
  const api = { VERSION, MAX_BYTES, FAILURE_KINDS, validate };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.DinerSnapshot = api;
})(typeof window === "undefined" ? globalThis : window);
