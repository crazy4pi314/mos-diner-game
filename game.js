// Mo's Diner: you work the counter, Copilot cooks. Data in orders.js, Copilot's planning in copilot.js.
(async () => {
  let menuData;
  try {
    [menuData] = await Promise.all([window.Menu.ready, window.Copilot.ready, window.DinerLivePlan.ready]);
  } catch (error) {
    console.error(error);
    const info = document.querySelector("#info-dialog");
    document.querySelector("#lifecycle-message").textContent = `Could not load the diner menu: ${error.message}`;
    document.querySelector("#lifecycle-status").hidden = false;
    document.querySelector("#start-shift").disabled = true;
    if (info && !info.open) info.showModal();
    return;
  }
  const { MENU, CUSTOMERS, HELLO } = menuData;
  const FEATURES = Object.freeze({ tips: false });
  const SHIFT = 90, TOTAL = Math.min(6, MENU.length), GOAL = Math.min(3, TOTAL), ARRIVALS = Array.from({ length: TOTAL }, (_, i) => i), COOK_MS = 450, EAT_MS = 3000, THANKS_MS = 1600, LEAVE_MS = 700;
  const CP16 = '<path d="M7.998 15.035c-4.562 0-7.873-2.914-7.998-3.749V9.338c.085-.628.677-1.686 1.588-2.065.013-.07.024-.143.036-.218.029-.183.06-.384.126-.612-.201-.508-.254-1.084-.254-1.656 0-.87.128-1.769.693-2.484.579-.733 1.494-1.124 2.724-1.261 1.206-.134 2.262.034 2.944.765.05.053.096.108.139.165.044-.057.094-.112.143-.165.682-.731 1.738-.899 2.944-.765 1.23.137 2.145.528 2.724 1.261.566.715.693 1.614.693 2.484 0 .572-.053 1.148-.254 1.656.066.228.098.429.126.612.012.076.024.148.037.218.924.385 1.522 1.471 1.591 2.095v1.872c0 .766-3.351 3.795-8.002 3.795Zm0-1.485c2.28 0 4.584-1.11 5.002-1.433V7.862l-.023-.116c-.49.21-1.075.291-1.727.291-1.146 0-2.059-.327-2.71-.991A3.222 3.222 0 0 1 8 6.303a3.24 3.24 0 0 1-.544.743c-.65.664-1.563.991-2.71.991-.652 0-1.236-.081-1.727-.291l-.023.116v4.255c.419.323 2.722 1.433 5.002 1.433ZM6.762 2.83c-.193-.206-.637-.413-1.682-.297-1.019.113-1.479.404-1.713.7-.247.312-.369.789-.369 1.554 0 .793.129 1.171.308 1.371.162.181.519.379 1.442.379.853 0 1.339-.235 1.638-.54.315-.322.527-.827.617-1.553.117-.935-.037-1.395-.241-1.614Zm4.155-.297c-1.044-.116-1.488.091-1.681.297-.204.219-.359.679-.242 1.614.091.726.303 1.231.618 1.553.299.305.784.54 1.638.54.922 0 1.28-.198 1.442-.379.179-.2.308-.578.308-1.371 0-.765-.123-1.242-.37-1.554-.233-.296-.693-.587-1.713-.7Z"/><path d="M6.25 9.037a.75.75 0 0 1 .75.75v1.501a.75.75 0 0 1-1.5 0V9.787a.75.75 0 0 1 .75-.75Zm4.25.75v1.501a.75.75 0 0 1-1.5 0V9.787a.75.75 0 0 1 1.5 0Z"/>';
  const cpIcon = (s = 16) => `<svg width="${s}" height="${s}" viewBox="0 0 16 16" fill="currentColor" role="img" aria-label="GitHub Copilot">${CP16}</svg>`;

  const $ = s => document.querySelector(s);
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const shuffle = a => { a = [...a]; for (let i = a.length - 1; i > 0; i--) { const j = Math.random() * (i + 1) | 0; [a[i], a[j]] = [a[j], a[i]]; } return a; };
  const pick = a => a[Math.random() * a.length | 0];
  const mmss = s => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  const dishOf = Copilot.dishOf;

  const shell = $(".shell"), counterEl = $("#counter"), kitchenEl = $("#kitchen"), headEl = $("#cp-head"), bodyEl = $("#cp-body"),
    input = $("#prompt"), timerChip = $(".timer"), infoDlg = $("#info-dialog"), overDlg = $("#over-dialog"),
    startBtn = $("#start-shift"), nameInput = $("#chef-name"), certEl = $("#cert");
  const mobile = window.dinerCompact;
  const canvas = !!document.querySelector('meta[name="diner-canvas"]');
  let canvasVisible = !canvas;
  const hidden = () => document.hidden || (canvas && !canvasVisible);
  let controller = null, loaded = !canvas, lifecycleFailed = false, resumed = false;
  let initializing = null, initializationAbort = null, initializationGeneration = 0, pageClosed = false;
  let liveAvailable = false, dinerConfig = null;
  const modelRequests = new Map(), modelNotices = new Map();
  const canEdit = () => loaded && !lifecycleFailed && (!canvas || controller?.canEdit());
  const canAdvance = () => resumed && !hidden() && (!canvas || controller?.canAdvance());
  function lifecycleError(message) {
    lifecycleFailed = true;
    stopTimer();
    $("#lifecycle-status").hidden = false;
    $("#lifecycle-message").textContent = message;
    $("#retry-loading").hidden = true;
    startBtn.disabled = true;
    if (overDlg.open) overDlg.close();
    if (!infoDlg.open) infoDlg.showModal();
  }
  function controlInterrupted(message) {
    $("#lifecycle-status").hidden = false;
    $("#lifecycle-message").textContent = message;
    startBtn.disabled = false;
    if (!infoDlg.open) infoDlg.showModal();
  }

  // ---------- State ----------
  // Order status: line → ordering (you're talking to them; prompt, then plan) → cooking → ready → served.
  // Customers stay in line until they're served, and you can take anyone's order in any order.
  // A wrong order comes back as "returned" until you fix the plan and Copilot rebuilds it.
  let S = null;
  function newShift() {
    const dishes = shuffle(MENU).slice(0, TOTAL);
    const people = shuffle(CUSTOMERS);
    S = {
      phase: "welcome", left: SHIFT, elapsed: 0, timer: null, active: null, pr: 101, tips: 0, banked: 0, served: 0,
      queue: dishes.map((d, i) => ({ at: ARRIVALS[i], d, who: people[i], n: i })),
      orders: [], chef: S ? S.chef : "",
    };
    if (HUB) {
      const kinds = shuffle(Checks.KINDS);
      shuffle(Array.from({ length: Math.max(0, TOTAL - 1) }, (_, i) => i + 1))
        .slice(0, Math.min(3, TOTAL - 1))
        .forEach((n, i) => { S.queue[n].fail = kinds[i]; });
    }
    api.S = S;
  }

  function makeOrder({ d, who, n, fail }) {
    const opts = shuffle(d.opts).slice(0, n === 0 ? 1 : 1 + (Math.random() < .5));
    const asks = d.opts.filter(o => opts.includes(o));
    const speech = `${pick(HELLO)} ${pick(d.say)}, ${asks.map(o => o.say).join(" and ")}.`;
    return {
      id: 40 + n, name: who[0], face: who[1], want: { dish: d.id, opts: asks.map(o => o.id) }, speech,
      status: "line", patience: 100, handed: false, text: "", draft: { dish: null, opts: [] },
      dish: null, asked: [], set: [], sent: "", prs: [], pending: [], built: {}, returns: 0, complaint: "", flag: [],
      help: null, tip: 0, fleet: false, log: [],
      failKind: fail || null, fail: null, failFixed: false, tried: [], miss: 0, checks: [], ci: 0,
    };
  }

  const HUB = document.documentElement.classList.contains("hub");
  let hubTab = "open";
  if (HUB) {
    const lbl = { line: "Issues", cp: "Chef", kitchen: "Pull requests" };
    document.querySelectorAll("#m-tabs button").forEach(b => { b.firstChild.textContent = lbl[b.dataset.arg]; });
    document.querySelector(".floor").setAttribute("aria-label", "Issues");
    document.querySelector(".kitchen").setAttribute("aria-label", "Pull requests");
    document.querySelector(".k-head").innerHTML = `<div class="cp-title"><b>Pull requests</b></div>`;
    document.addEventListener("keydown", e => {
      const r = e.target.closest?.(".hi-row[data-act]");
      if (r && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); r.click(); }
    });
  }
  const active = () => S.orders.find(o => o.id === S.active) || null;
  // The customer you're taking an order from: whoever is selected, else the first person who hasn't ordered yet.
  const atRegister = () => {
    const a = active();
    return a && !a.handed && a.status !== "served" ? a : S.orders.find(o => !o.handed && o.status !== "served") || null;
  };
  function talkTo(o) {
    if (!o || o.status !== "line") return;
    o.status = "ordering";
    say(o, cpSay(`What should I make for ${esc(o.name)}?`));
    if (S.phase === "shift" && S.elapsed > 6) sfx("bell");
  }
  const pickupList = () => S.orders.filter(o => o.handed && o.status !== "served");
  const stage = o => (o.status === "ordering" || o.status === "returned") && !o.dish ? "prompt"
    : o.status === "ordering" || o.status === "returned" ? "plan" : o.status;
  const first = o => o.name.replace(/^@/, "");
  // Served customers stay on their stool while they eat, then walk out.
  const seated = o => o.status !== "served" || !o.gone;

  function arrive() {
    const q = S.queue.shift();
    if (!q) return;
    const o = makeOrder(q), taken = new Set(S.orders.filter(seated).map(x => x.seat));
    o.arriving = true;
    o.seat = [...Array(TOTAL).keys()].find(i => !taken.has(i)) ?? 0;
    S.orders.push(o);
    promote();
  }
  // Only pick a customer when nobody is selected; otherwise the player decides who to serve next.
  function promote() {
    if (active()) return;
    const o = atRegister();
    if (!o) return;
    talkTo(o);
    S.active = o.id;
  }

  // ---------- Order flow ----------
  function cancelModel(o, message = "Copilot request cancelled. Send again to retry.") {
    const request = modelRequests.get(o);
    if (!request) return;
    modelRequests.delete(o);
    modelNotices.set(o, message);
    request.abort.abort();
  }
  function applyPlan(o, p, text) {
    Object.assign(o, { dish: p.dish, asked: p.opts, set: [...p.opts], sent: text, help: null, flag: [] });
    o.text = ""; if (active() === o) input.value = "";
  }
  async function askModel(o, text) {
    if (!liveAvailable || !canAdvance() || stage(o) !== "prompt") {
      modelNotices.set(o, "Resume the shift to use real Copilot, or choose deterministic mode.");
      renderPane(); return;
    }
    try { text = DinerLivePlan.validatePrompt(text); }
    catch (error) { modelNotices.set(o, error.message); renderPane(); return; }
    cancelModel(o);
    const shift = S, abort = new AbortController(), bytes = crypto.getRandomValues(new Uint8Array(16));
    const hex = [...bytes].map(x => x.toString(16).padStart(2, "0")).join("");
    const requestId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    const request = { abort, requestId };
    modelRequests.set(o, request); modelNotices.delete(o);
    o.text = text;
    say(o, userMsg(`<code>${esc(text)}</code>`));
    const valid = () => modelRequests.get(o) === request && S === shift && S.orders.includes(o) &&
      S.phase === "shift" && canAdvance() && stage(o) === "prompt" && o.text === text;
    const cancelRemote = () => {
      fetch("/_diner/plan", {
        method: "POST", keepalive: true,
        headers: { "Content-Type": "application/json", "X-Diner-Capability": dinerConfig.capability },
        body: JSON.stringify({ op: "cancel", requestId, ...controller.identity() }),
      }).then(response => {
        if (!response.ok) console.error("Could not cancel diner model request:", response.status);
      }).catch(error => console.error("Could not cancel diner model request:", error.message));
    };
    abort.signal.addEventListener("abort", cancelRemote, { once: true });
    renderAll();
    try {
      // Persist the prompt/order before the provider checks the current controller.
      await controller.save();
      if (!valid()) return;
      const response = await fetch("/_diner/plan", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Diner-Capability": dinerConfig.capability },
        body: JSON.stringify({ op: "interpret", requestId, orderId: o.id, prompt: text, ...controller.identity() }),
        signal: AbortSignal.any([abort.signal, AbortSignal.timeout(40000)]),
      });
      if (!response.ok) throw new Error(await response.text());
      const plan = DinerLivePlan.validate(await response.json());
      if (!valid()) return;
      applyPlan(o, plan, text);
      if (plan.note) say(o, cpSay(`Copilot: ${esc(plan.note)}`));
      modelRequests.delete(o);
      renderAll();
      await controller.save();
    } catch (error) {
      if (valid()) {
        modelNotices.set(o, `Copilot could not propose a plan: ${error.message} Retry or choose deterministic mode.`);
        modelRequests.delete(o); renderAll();
        saveSoon();
      }
    } finally {
      abort.signal.removeEventListener("abort", cancelRemote);
      if (modelRequests.get(o) === request) modelRequests.delete(o);
    }
  }
  function sendPrompt(o, text) {
    text = (text || "").trim();
    cancelModel(o); modelNotices.delete(o);
    const p = Copilot.parse(text);
    if (text) say(o, userMsg(`<code>${esc(text)}</code>`));
    if (!p.dish) { say(o, cpSay("Which dish should I make? Pick one from the menu 👆")); return; }
    applyPlan(o, p, text);
  }
  function toggle(o, id) {
    if (stage(o) !== "plan") return;
    o.set = o.set.includes(id) ? o.set.filter(x => x !== id) : [...o.set, id];
    o.flag = o.flag.filter(x => x !== id);
  }
  function pickStep(o, id, on) {
    if (stage(o) !== "plan") return;
    if (o.set.includes(id) !== on) toggle(o, id);
    o.open = null;
  }
  function approve(o) {
    if (stage(o) !== "plan") return;
    const plan = Copilot.plan(o.dish, o.set);
    const fix = o.prs.length > 0;
    say(o, planHtml(o, dishOf(o.dish), true));
    say(o, userMsg(fix ? "✅ Approved the fix" : "✅ Approved the plan"));
    o.pending = plan.filter(s => o.built[s.i] !== s.title);
    if (!o.pending.length) o.pending = [plan[plan.length - 1]];
    if (!fix) o.prs = [];
    o.fixup = fix;
    o.status = "cooking"; o.help = null; o.complaint = ""; o.flag = [];
    o.handed = true;
    const nxt = atRegister();
    say(o, cpSay(`${fix ? "On it 👍 Rebuilding only the PRs that changed." : "Plan approved 👍 I'm cooking it in the kitchen now as a stack of PRs."}${nxt && nxt !== o ? " Take the next order while you wait!" : ""}`));
    sfx("good");
    startCooking();
    if (mobile.matches) setView(atRegister() ? "line" : "kitchen");
  }
  // Copilot lands a PR every COOK_MS while cooking, on its own clock so plating feels snappy.
  let cookT = null;
  function startCooking() {
    if (!cookT && S.timer && canAdvance()) cookT = setTimeout(cook, COOK_MS);
  }
  function cook() {
    cookT = null;
    if (S.phase !== "shift" || !S.timer || !canAdvance()) return;
    const busy = S.orders.filter(o => o.status === "cooking" || o.status === "checks");
    if (!busy.length) return;
    busy.forEach(o => o.status === "checks" ? runCheck(o) : build(o)); renderAll();
    saveSoon();
    startCooking();
  }
  function build(o) {
    const s = o.pending.shift();
    if (!s) return;
    const old = o.prs.find(p => p.i === s.i);
    const pr = { n: S.pr++, i: s.i, emoji: s.emoji, title: s.title, fix: o.fixup, at: Date.now() };
    if (old) o.prs[o.prs.indexOf(old)] = pr; else o.prs.push(pr);
    o.prs.sort((a, b) => a.i - b.i);
    o.built[s.i] = s.title;
    if (!o.pending.length) {
      const d = dishOf(o.dish);
      if (HUB) { o.status = "checks"; o.checks = Checks.RUNS.map(r => ({ ...r, state: "queued" })); o.ci = 0;
        say(o, cpSay(`${food(d)}${esc(d.name)} is built. GitHub Actions and GHAS are checking it before it can merge…`)); }
      else { o.status = "ready"; sfx("bell"); toast(`🛎 Order up for ${o.name}!`);
        say(o, cpSay(`${food(d)}${esc(d.name)} is ready. Merge &amp; serve it from the kitchen 🛎`)); }
    }
  }
  // Hub view: once the stack is built, Actions and GHAS checks run one at a time.
  function runCheck(o) {
    const c = o.checks[o.ci];
    if (!c) return;
    if (c.state === "queued") { c.state = "running"; return; }
    const kind = !o.failFixed && o.failKind, f = kind && Checks.FAILS[kind](dishOf(o.dish));
    if (f && f.check === c.id) {
      c.state = "fail"; o.status = "failing";
      o.fail = { ...f, kind, fixes: shuffle(f.fixes) };
      sfx("bad"); toast(`❌ ${c.name} failed on #${o.id}`);
      say(o, cpSay(`❌ <b>${esc(c.app)} · ${esc(c.name)}</b> failed on the PR stack, so I can't merge yet. Read the log and pick the fix.`));
      return;
    }
    c.state = "pass"; o.ci++;
    if (o.ci >= o.checks.length) {
      o.status = "ready"; sfx("bell"); toast(`✅ All checks passed on #${o.id}. Ready to merge!`);
      const d = dishOf(o.dish);
      say(o, checksList(o));
      say(o, cpSay(`${food(d)}${esc(d.name)} is ready and every check is green ✅ Merge &amp; serve it from the Pull requests tab 🛎`));
    }
  }
  // The player picks a fix for a failing check. Only one is right; wrong picks cost patience and tip.
  function tryFix(o, id) {
    if (!o || o.status !== "failing" || !o.fail) return;
    const fx = o.fail.fixes.find(x => x.id === id);
    if (!fx || o.tried.includes(id)) return;
    o.tried.push(id); o.help = null;
    say(o, userMsg(`🔧 ${esc(fx.text)}`));
    if (!fx.ok) { say(o, cpSay(`✗ That didn't fix it: ${esc(fx.why)} Read the log again.`)); o.miss++; o.patience = Math.max(0, o.patience - 8); sfx("bad"); toast("That didn't fix it. Read the log again."); return; }
    o.failFixed = true;
    if (fx.id !== "rerun") o.prs.push({ n: S.pr++, i: 99, emoji: "🔧", title: fx.pr, fix: true, at: Date.now() });
    const at = o.checks.findIndex(c => c.state === "fail");
    o.checks.forEach((c, i) => { if (i >= at) c.state = "queued"; });
    o.ci = at; o.status = "checks";
    say(o, cpSay(`✅ ${esc(fx.why)} Re-running checks…`));
    sfx("good"); toast(`🔧 ${fx.why}`);
    startCooking();
  }
  function serve(o) {
    if (!o || o.status !== "ready" || S.phase !== "shift") return;
    const d = Copilot.diff(o, o.set);
    if (d.dish || d.opts.length) {
      o.returns++; o.status = "returned"; o.patience = Math.max(0, o.patience - 10);
      const want = dishOf(o.want.dish);
      if (d.dish) {
        o.complaint = `This isn't what I ordered! I asked for the ${want.name.toLowerCase()}.`;
        Object.assign(o, { dish: null, prs: [], built: {}, asked: [], set: [], text: "", draft: { dish: null, opts: [] } });
      } else {
        o.complaint = d.opts.map(x => o.want.opts.includes(x.id) ? `I asked for ${x.alt}!` : `I didn't ask for ${x.alt}.`).join(" ");
        o.flag = d.opts.map(x => x.id);
      }
      say(o, `<div class="is-event">↩ <b>@${esc(first(o).toLowerCase())}</b> reopened this</div>`);
      say(o, custMsg(o, esc(o.complaint)));
      say(o, cpSay(d.dish ? "Got it, let's start over. What should I make?" : "Got it. I'll update the plan and rebuild only the PRs that change."));
      toast(`↩ ${o.name} sent it back`); sfx("bad");
      return;
    }
    if (FEATURES.tips) {
      let tip = 3 + o.prs.length + Math.round(o.patience / 100 * 5) - 2 * o.returns - o.miss;
      if (o.fleet) tip = Math.ceil(tip / 2);
      o.tip = Math.max(1, tip);
      S.tips += o.tip;
    }
    o.status = "served"; S.served++; S.left += 5;
    say(o, cpSay(`${o.face} ${esc(first(o))} loved it!${FEATURES.tips ? ` <b>+$${o.tip}</b> tip` : ""}${o.fleet ? " (finished by /fleet)" : ""}`));
    say(o, `<div class="is-event">✓ Issue closed as served</div>`);
    if (HUB) { o.gone = true; if (FEATURES.tips) bank(o); }
    else {
    o.thanks = true;
    o.delay = { thanks: THANKS_MS, leave: EAT_MS };
    }
    if (!o.fleet) { toast(`😋 ${o.name} loved it!${FEATURES.tips ? ` +$${o.tip}` : ""}`); sfx("good"); }
    if (S.served >= GOAL) win();
  }

  function bank(o) {
    if (!FEATURES.tips || !S.orders.includes(o)) return;
    const cash = document.querySelectorAll(".seat")[o.seat]?.querySelector(".cash"), jar = $("#hud-tips");
    const land = () => {
      if (!S.orders.includes(o) || o.banked) return;
      o.banked = true; S.banked += o.tip; renderHud();
      jar.classList.remove("bump"); void jar.offsetWidth; jar.classList.add("bump");
    };
    if (!cash || !jar || matchMedia("(prefers-reduced-motion: reduce)").matches) return land();
    const a = cash.getBoundingClientRect(), b = jar.getBoundingClientRect();
    const fly = Object.assign(document.createElement("div"), { className: "cash-fly", textContent: `+$${o.tip}` });
    fly.style.left = `${a.left + a.width / 2}px`; fly.style.top = `${a.top + a.height / 2}px`;
    document.body.append(fly);
    requestAnimationFrame(() => { fly.style.transform = `translate(${b.left + b.width / 2 - a.left - a.width / 2}px, ${b.top + b.height / 2 - a.top - a.height / 2}px) translate(-50%, -50%) scale(.7)`; fly.style.opacity = ".2"; });
    o.delay = { ...(o.delay || {}), bank: 750 };
    setTimeout(() => fly.remove(), 750);
  }

  // ✨ Ask Copilot: it all but gives you the answer.
  function help(o) {
    cancelModel(o);
    const want = dishOf(o.want.dish), alts = want.opts.filter(x => o.want.opts.includes(x.id)).map(x => x.alt);
    const st = stage(o);
    let msg;
    if (st === "prompt") {
      o.draft = { dish: want.id, opts: [...o.want.opts] };
      o.text = input.value = Copilot.promptText(want.id, o.want.opts);
      msg = `From what ${first(o)} said: ${food(want)}<b>${want.name.toLowerCase()}</b>, ${alts.map(a => `<b>${a}</b>`).join(" and ")}. I filled in the prompt. Send it when you're ready!`;
    } else if (st === "plan") {
      const d = Copilot.diff(o, o.set);
      o.flag = d.opts.map(x => x.id);
      if (o.flag.length) o.open = o.flag[0];
      msg = d.dish
        ? `${esc(first(o))} asked for <b>${esc(want.name)}</b>, not <b>${esc(dishOf(o.dish).name)}</b>. Choose <b>Edit prompt</b> to change the dish.`
        : d.opts.length
        ? `Check the highlighted step${d.opts.length > 1 ? "s" : ""}: ${d.opts.map(x => o.want.opts.includes(x.id) ? `${first(o)} asked for <b>${x.alt}</b>` : `nobody asked for <b>${x.alt}</b>`).join(", and ")}. Tap <b>Change</b> to fix it.`
        : "The plan matches what they asked for 👌 Approve it!";
    } else if (st === "failing") {
      const fx = o.fail.fixes.find(x => x.ok);
      o.flag = [fx.id];
      msg = { flaky: "The log says the runner timed out, and this job passed 12 times in a row. That's a flaky runner, not a bug.",
        test: "The test fails the same way every run, so it isn't a flake. That's a real bug in the code.",
        codeql: "CodeQL found a real vulnerability, and Copilot Autofix can patch it for you.",
        deps: "One of your ingredients has a known vulnerability, and Dependabot already opened a PR with the patched version.",
        secrets: "A secret got committed. Deleting the line isn't enough because it stays in the git history. Rotate it, then store it safely." }[o.fail.kind]
        + ` Pick <b>${esc(fx.text)}</b>.`;
    } else if (st === "checks") msg = "Checks are running: Actions builds and tests it, and GHAS scans the code, dependencies and secrets. Hang tight!";
    else if (st === "deploying") msg = "Deploying now 🚀";
    else if (st === "cooking") msg = `On it! ${o.prs.length}/${o.prs.length + o.pending.length} PRs merged into the stack…`;
    else if (st === "ready") msg = "All checks passed ✅ Merge it and serve!";
    else msg = `${first(o)} is happy 😋`;
      say(o, `<div class="cp-hint">${cpSay("✨ " + msg)}</div>`);
  }

  // ---------- Timer ----------
  function startTimer() {
    if (S.timer || S.phase !== "shift" || !canAdvance()) return;
    S.timer = setInterval(tick, 1000);
    startCooking();
    startDelays();
    renderHud();
  }
  function stopTimer() {
    for (const o of modelRequests.keys()) cancelModel(o, "Copilot request interrupted by pause. Resume and send again to retry.");
    resumed = false;
    clearInterval(S.timer); S.timer = null;
    clearTimeout(cookT); cookT = null;
    clearInterval(delayT); delayT = null;
    renderHud();
  }
  function tick() {
    if (S.phase !== "shift" || !S.timer || !canAdvance()) return;
    S.left--; S.elapsed++;
    let changed = false;
    while (S.queue.length && S.queue[0].at <= S.elapsed) { arrive(); changed = true; }
    for (const o of S.orders) {
      if (o.status === "served") continue;
      o.patience = Math.max(0, o.patience - (o.status === "line" ? .25 : o.handed ? .4 : .6));
    }
    if (changed) renderAll(); else { renderHud(); patchBars(); }
    if (S.left <= 0) lastCall();
    saveSoon();
  }

  // Serializable remaining delays run on active time, never wall-clock time.
  let delayT = null;
  function startDelays() {
    if (delayT) return;
    delayT = setInterval(() => {
      if (!canAdvance()) return;
      for (const o of S.orders) {
        for (const key of Object.keys(o.delay || {})) {
          o.delay[key] = Math.max(0, o.delay[key] - 100);
          if (o.delay[key]) continue;
          delete o.delay[key];
          if (key === "thanks") o.thanks = false;
          if (key === "leave") { o.leaving = true; o.delay.gone = LEAVE_MS + 500; }
          if (key === "gone") { o.gone = true; bank(o); }
          if (key === "bank" && !o.banked) {
            o.banked = true;
            if (FEATURES.tips) S.banked += o.tip;
          }
          if (key === "deploy" && o.status === "deploying") {
            if (S.phase !== "shift") return;
            o.status = "ready"; serve(o);
            if (S.phase !== "shift") {
              renderAll();
              saveSoon();
              return;
            }
            if (mobile.matches) setView("line");
            if (o.status === "served") o.delay = { ...(o.delay || {}), next: 1100 };
          }
          if (key === "next" && S.phase === "shift" && (S.active === o.id || active()?.status === "served")) {
            const n = S.orders.find(x => x.status !== "served" && (!x.handed || ["failing", "ready", "returned"].includes(x.status)));
            if (n) select(n.id);
          }
          renderAll();
          saveSoon();
        }
      }
    }, 100);
  }

  function lastCall() {
    S.phase = "over";
    settleTips();
    stopTimer();
    renderAll();
    showShiftSummary(false);
  }
  function showShiftSummary(won) {
    overDlg.classList.toggle("win-summary", won);
    $("#over-title").textContent = won ? "Shift complete!" : "Shift's over!";
    $("#over-summary").textContent = won
      ? `You fulfilled ${S.served} orders with ${mmss(S.left)} left on the clock.`
      : `You served ${S.served} of ${GOAL} orders before the shift ended.`;
    $("#over-restart").hidden = won;
    $("#over-close").hidden = !won;
    renderShiftSummary();
    if (!overDlg.open) overDlg.showModal();
  }
  function renderShiftSummary() {
    const served = S.orders.filter(o => o.status === "served");
    $("#over-orders").innerHTML = served.length ? `<h3>Diners served</h3><ul>${served.map(o => {
      const d = dishOf(o.want.dish);
      const options = d.opts.filter(option => o.want.opts.includes(option.id)).map(option => option.alt);
      const details = options.length ? options.join(", ") : "house recipe";
      return `<li><span class="summary-face" aria-hidden="true">${esc(o.face)}</span>
        <span class="summary-diner">@${esc(first(o))}</span>
        <span class="summary-order">${esc(d.name)} · ${esc(details)}</span></li>`;
    }).join("")}</ul>` : `<div class="summary-empty">No completed orders this shift.</div>`;
  }

  // Copilot finishes every open order exactly as asked.
  function fleetAll() {
    while (S.queue.length) arrive();
    for (const o of S.orders) {
      if (o.status === "served") continue;
      Object.assign(o, { status: "ordering", handed: true, dish: o.want.dish, asked: [...o.want.opts], set: [...o.want.opts], fleet: true, built: {}, prs: [] });
      o.sent = Copilot.promptText(o.dish, o.set) + " (via /fleet)";
      say(o, userMsg(`<code>${esc(o.sent)}</code>`));
      o.pending = Copilot.plan(o.dish, o.set);
      o.status = "cooking";
      while (o.pending.length) build(o);
      o.status = "ready"; o.failFixed = true;
      serve(o);
      if (S.phase === "won") break;
    }
    renderAll();
  }

  function win() {
    S.phase = "won";
    settleTips();
    stopTimer();
    showCert();
    showShiftSummary(true);
  }
  // Settle earned tips before a terminal screen stops the animation clock.
  function settleTips() {
    S.orders.filter(o => o.status === "served").forEach(o => {
      if (FEATURES.tips && !o.banked) S.banked += o.tip;
      o.banked = true; o.delay = {}; o.gone = true;
    });
  }

  // ---------- Render ----------
  const mood = p => p < 25 ? "bad" : p < 50 ? "warn" : "";
  const bar = o => o.status === "served" ? "" : `<i class="patience" data-pat="${o.id}"><i class="${mood(o.patience)}" style="width:${o.patience}%"></i></i>`;
  function patchBars() {
    document.querySelectorAll("[data-pat]").forEach(el => {
      const o = S.orders.find(x => x.id === +el.dataset.pat);
      if (!o) return;
      el.firstElementChild.style.width = o.patience + "%";
      el.firstElementChild.className = mood(o.patience);
    });
  }
  function renderAll() { renderHud(); renderCounter(); renderPane(); renderKitchen(); }

  function renderHud() {
    $("#shift-time").textContent = mmss(Math.max(0, S.left)).padStart(5, "0");
    $("#shift-bar").style.width = (Math.min(SHIFT, Math.max(0, S.left)) / SHIFT * 100) + "%";
    const chefChip = $(".chef-chip");
    chefChip.hidden = false;
    $("#hud-chef").textContent = S.chef || "octocat";
    timerChip.classList.toggle("low", S.left <= 30);
    const running = S.phase === "shift" && !!S.timer && S.left > 0;
    timerChip.classList.toggle("urgent", running && S.left <= 30);
    timerChip.classList.toggle("critical", running && S.left < 10);
    timerChip.classList.toggle("paused", S.phase === "shift" && !S.timer);
    $("#hud-served").textContent = `${S.served}/${GOAL}`;
    const tipsChip = $("#hud-tips")?.closest(".chip");
    if (tipsChip) tipsChip.hidden = !FEATURES.tips;
    if (FEATURES.tips) $("#hud-tips").textContent = `$${S.banked}`;
  }

  // The left pane just says hi; the full order lives on the ticket in the middle.
  const READY = ["Hey, I'm ready to order!", "Hi there! Ready when you are.", "Hey! I know what I want.", "Excuse me, can I order?", "Hi! I'm starving, ready to order."];
  const SAYS = {
    line: o => READY[o.id % READY.length], ordering: o => READY[o.id % READY.length],
    cooking: () => "Ooh, I can't wait!", ready: () => "Is that mine? 👀", returned: () => "Hmm, that's not what I asked for…",
  };
  const STATUS = { checks: "⏳ Cooking", failing: "⏳ Cooking", deploying: "🛎 Order up", served: "😋 Eating", line: "Waiting to order", ordering: "Ordering", cooking: "⏳ Cooking", ready: "🛎 Order up", returned: "↩ Sent back" };
  // The line is keyed by customer, and FLIP-animated. Everyone stays in line until they're served;
  // the customer you're talking to is expanded with their order in a speech bubble.
  // What sits on the counter between stools (above seat i); null leaves the counter bare.
  const DECOR = [null, "condiments", "splatter", "napkins", "coffee", null];
  function renderCounter() {
    if (HUB) return renderIssues();
    const people = S.orders.filter(seated);
    const a = active(), front = a && a.status !== "served" ? a : atRegister();
    if (!counterEl.firstChild) counterEl.innerHTML = `
      <div class="line" aria-label="Customers in line"></div>`;
    const lineEl = counterEl.querySelector(".line");
    // Fixed stools along the counter: each customer keeps their seat until they're served.
    if (!lineEl.children.length) lineEl.innerHTML = Array.from({ length: TOTAL }, (_, i) => `<div class="seat">
      <span class="place" aria-hidden="true">${DECOR[i] ? `<img class="decor" src="assets/diner/${DECOR[i]}.svg" alt="" draggable="false">` : ""}<img class="dish-spot" src="assets/diner/plate.svg" alt="" draggable="false"><img class="dish-food" alt="" draggable="false">${FEATURES.tips ? `<img class="cash" src="assets/diner/cash.svg" alt="" draggable="false">` : ""}</span>
      <span class="stool" aria-hidden="true"><span class="sitter"></span></span></div>`).join("");
    [...lineEl.children].forEach((seat, i) => {
      const o = people.find(p => p.seat === i);
      let el = seat.querySelector(".lp");
      if (el && (!o || el.dataset.id !== String(o.id))) { el.remove(); el = null; }
      const sitter = seat.querySelector(".sitter");
      if (sitter.textContent !== (o ? o.face : "")) {
        sitter.textContent = o ? o.face : "";
        seat.classList.remove("arrive"); void seat.offsetWidth;
        if (o) { seat.classList.add("arrive"); setTimeout(() => seat.classList.remove("arrive"), 700); }
      }
      const stool = seat.querySelector(".stool");
      if (o && o.status !== "served") { stool.dataset.act = "order"; stool.dataset.arg = o.id; } else delete stool.dataset.act;
      const eating = !!o && o.status === "served", meal = seat.querySelector(".dish-food");
      if (eating && !meal.getAttribute("src")) meal.src = `assets/food/${dishOf(o.dish).art}.svg`;
      if (!eating && meal.getAttribute("src")) meal.removeAttribute("src");
      seat.classList.toggle("eating", eating);
      seat.classList.toggle("leaving", !!o && !!o.leaving);
      seat.classList.toggle("thanks", !!o && !!o.thanks);
      seat.classList.toggle("taken", !!o);
      seat.classList.toggle("sel", !!o && o.id === S.active);
      if (!o) return;
      if (!el) {
        el = document.createElement("div"); el.dataset.id = o.id; el.dataset.act = "order"; el.dataset.arg = o.id; el.className = "lp enter";
        seat.prepend(el); setTimeout(() => el.classList.remove("enter"), 700);
      }
      // Same card for everyone, so nothing jumps around: name, status, patience, then their ask (shown only once you tap them).
      if (!el.firstChild) el.innerHTML = `<button class="lp-who" data-act="order"></button><div class="speech"><p></p></div>`;
      const who = el.firstChild, q = el.querySelector(".speech p");
      who.dataset.arg = o.id; who.disabled = o.status === "served"; el.dataset.act = who.disabled ? "" : "order";
      who.setAttribute("aria-label", `${o.name}: ${STATUS[o.status]}. Open their order ticket`);
      const html = `<span class="cu-name">${esc(o.name)}</span><span class="lp-st st-${o.status}">${STATUS[o.status]}</span>${bar(o)}`;
      if (who._html !== html) { who._html = html; who.innerHTML = html; }
      const said = SAYS[o.status]?.(o) ?? "Thank you!";
      if (q.textContent !== said) q.textContent = said;
      el.classList.toggle("front", o === front);
      el.classList.toggle("sel", o.id === S.active);
    });
  }

  // Option B ("?ui=hub"): the left pane is a plain GitHub Issues list instead of the diner counter.
  const HUB_STATE = { line: "New", ordering: "Needs prompt", returned: "Reopened", cooking: "Copilot is cooking", checks: "Running checks", failing: "A check failed: investigate", ready: "All checks passed: ready to merge", deploying: "Deploying", served: "Closed" };
  let issueResize = null;
  function renderIssues() {
    let box = counterEl.querySelector(".hi-box");
    const previousHeight = box?.getBoundingClientRect().height;
    issueResize?.cancel();
    const open = S.orders.filter(o => o.status !== "served"), closed = S.orders.filter(o => o.status === "served");
    const rows = (hubTab === "open" ? open : closed).slice().sort((a, b) => hubTab === "open" ? a.id - b.id : b.id - a.id);
    const tab = (k, n, icon) => `<button class="hi-tab${hubTab === k ? " on" : ""}" data-act="hubtab" data-arg="${k}" aria-pressed="${hubTab === k}">${icon} ${n} ${k === "open" ? "Open" : "Closed"}</button>`;
    const row = o => {
      const d = o.dish && dishOf(o.dish), handle = "@" + first(o).toLowerCase(), st = o.status === "served" ? "closed" : "open";
      const labels = issueLabels(o, d).filter(l => !l.includes("lbl dish")).join("");
      const who = o.handed ? `<span class="hi-av cp" title="Assigned to Copilot">${cpIcon(12)}</span>` : "";
      return `<li class="hi-row${o.arriving ? " arriving" : ""}${st === "closed" ? " done" : o.id === S.active ? " sel" : ""}"${st === "open" ? ` data-act="order" data-arg="${o.id}" role="button" tabindex="0"` : ""}>
        <span class="hi-ic ${st}">${ICONS[st]}</span>
        <div class="hi-main">
          <div class="hi-title"><b>${d ? esc(d.name) : `Order from ${esc(handle)}`}</b>${labels}</div>
          <div class="hi-meta">#${o.id} · ${o.face} ${esc(handle)} · ${st === "closed" ? `served${FEATURES.tips ? `, +$${o.tip} tip` : ""}` : HUB_STATE[o.status]}</div>
        </div>
        <div class="hi-side">${who}${bar(o)}</div>
      </li>`;
    };
    if (!box) {
      box = document.createElement("div");
      box.className = "hi-box zigzag-bottom";
      counterEl.append(box);
    }
    box.innerHTML = `<div class="hi-head">${tab("open", open.length, ICONS.open)}${tab("closed", closed.length, ICONS.closed)}</div>
      ${rows.length ? `<ul class="hi-list">${rows.map(row).join("")}</ul>`
        : `<div class="hi-empty">${hubTab === "open" ? (S.served === TOTAL ? "All orders closed 🎉" : "No open orders yet. New ones show up here.") : "Nothing closed yet."}</div>`}`;
    const height = box.getBoundingClientRect().height;
    if (previousHeight != null && Math.abs(height - previousHeight) > .5 && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      issueResize = box.animate([{ height: `${previousHeight}px` }, { height: `${height}px` }],
        { duration: 450, easing: "cubic-bezier(.2, .8, .4, 1)" });
    }
    rows.forEach(o => { o.arriving = false; });
  }

  // ---------- Right column: the kitchen. Every approved order cooks here as a PR stack. ----------
  function renderKitchen() {
    const list = pickupList();
    const ready = list.filter(o => o.status === "ready").length;
    $("#k-badge").textContent = ready || "";
    $("#cp-badge").textContent = S.orders.filter(x => x.status === "ordering" || x.status === "returned" || x.status === "failing").length || "";
    if (!list.length) { kitchenEl.innerHTML = `<div class="k-empty"><div class="empty-icon">🍳</div><p>Approved plans cook here as stacked PRs. Merge them when they're green.</p></div>`; return; }
    if (kitchenEl.querySelector(".k-empty")) kitchenEl.innerHTML = "";
    const keep = new Set();
    list.forEach((o, i) => {
      const id = String(o.id);
      keep.add(id);
      let el = kitchenEl.querySelector(`[data-id="${id}"]`);
      if (!el) { el = document.createElement("article"); el.dataset.id = id; }
      el.className = `plan card build ${o.status} ${o.id === S.active ? "sel" : ""}`;
      // Head and body re-render; the plate figure between them stays put so its images never blink.
      if (!el._head) {
        el.innerHTML = `<div class="kc-head"></div><div class="kp-slot"></div><div class="kc-body"></div>`;
        el._head = el.firstChild; el._body = el.lastChild; el._h = el._b = "";
      }
      const [h, b] = kitchenCard(o);
      if (el._h !== h) { el._h = h; el._head.innerHTML = h; }
      if (el._b !== b) { el._b = b; el._body.innerHTML = b; }
      animatePlate(el, o);
      if (kitchenEl.children[i] !== el) kitchenEl.insertBefore(el, kitchenEl.children[i] || null);
    });
    [...kitchenEl.children].forEach(el => { if (!keep.has(el.dataset.id)) el.remove(); });
  }
  function kitchenCard(o) {
    const d = dishOf(o.dish || o.want.dish);
    const total = o.prs.length + o.pending.length;
    const done1 = o.checks.filter(c => c.state === "pass").length;
    const st = o.status === "cooking" ? `<span class="tk-st cooking">⏳ ${o.prs.length}/${total} PRs</span>`
      : o.status === "checks" ? `<span class="tk-st cooking">● Running checks ${done1}/${o.checks.length}</span>`
      : o.status === "failing" ? `<span class="tk-st returned">✗ 1 check failing</span>`
      : o.status === "deploying" ? `<span class="tk-st cooking">🚀 Deploying to table…</span>`
      : o.status === "ready" ? `<span class="tk-st ready">✅ All checks passed</span>`
      : `<span class="tk-st returned">↩ Sent back</span>`;
    const pend = o.pending.slice().reverse().map((s, i, a) => `<li class="bstep pending ${i === a.length - 1 ? "now" : ""}"><span class="pr-st">${i === a.length - 1 ? "⏳" : "○"}</span><span class="st-emoji">${s.emoji}</span><span class="st-title">${esc(s.title)}</span></li>`).join("");
    const done = o.prs.slice().reverse().map(p => `<li class="bstep done${Date.now() - (p.at || 0) < 400 ? " pop" : ""}"><span class="pr-st">✓</span><span class="st-emoji">${p.emoji}</span><span class="st-title">${esc(p.title)}</span><span class="pr-n">#${p.n}${p.fix ? " fix" : ""}</span></li>`).join("");
    const act = o.status === "ready" ? `<button class="btn primary" data-act="serve" data-arg="${o.id}">Merge &amp; serve 🛎</button>`
      : o.status === "returned" ? `<button class="btn ghost" data-act="goto" data-arg="${o.id}">Fix the plan →</button>`
      : o.status === "failing" ? `<button class="btn danger" data-act="goto" data-arg="${o.id}">Investigate the failure →</button>` : "";
    return [`<button class="plan-head k-card-head" data-act="order" data-arg="${o.id}"><span class="tk-face">${o.face}</span>
        <span class="tk-main"><b>#${o.id} ${esc(d.name)}</b>${st}</span>${bar(o)}</button>`,
      `<ol class="steps">${pend}${done}</ol>${HUB && o.checks.length ? checksList(o) : ""}${act ? `<div class="plan-acts">${act}</div>` : ""}`];
  }
  const CK_ICON = { queued: "○", running: "●", pass: "✓", fail: "✗" };
  function checksList(o) {
    const n = o.checks.filter(c => c.state === "pass").length;
    return `<div class="ck-box"><div class="ck-head">${o.status === "failing" ? "Some checks were not successful" : n === o.checks.length ? "All checks have passed" : "Some checks haven't completed yet"} <span>${n}/${o.checks.length}</span></div>
      <ul class="ck-list">${o.checks.map(c => `<li class="ck ${c.state}"><span class="ck-ic">${CK_ICON[c.state]}</span><span class="ck-name"><b>${esc(c.app)}</b> · ${esc(c.name)}</span><span class="ck-diner">${esc(c.diner)}</span></li>`).join("")}</ul></div>`;
  }

  // Plate preview: one illustration per step (assets/food/plating), swapped in as each PR lands.
  // The figure lives outside the card's re-rendered HTML so the swap animates only when the step changes.
  function plateStage(o, d) {
    const n = d.steps.length, total = o.prs.length + o.pending.length;
    const k = ["ready", "checks", "failing", "deploying"].includes(o.status) ? n : Math.min(n, Math.floor(o.prs.length / Math.max(1, total) * n));
    return { k, src: k === 0 ? "assets/food/plating/plate.svg" : k === n ? `assets/food/${d.art}.svg` : `assets/food/plating/${d.art}-${k}.svg` };
  }
  function animatePlate(el, o) {
    const slot = el.querySelector(".kp-slot"), d = dishOf(o.dish || o.want.dish);
    let fig = el._plateEl;
    if (!fig) {
      fig = el._plateEl = document.createElement("figure");
      fig.innerHTML = `<div class="kp-art"></div><figcaption></figcaption><img class="kp-qc" alt="" draggable="false">`;
      for (let k = 1; k < d.steps.length; k++) new Image().src = `assets/food/plating/${d.art}-${k}.svg`;
    }
    if (slot) slot.replaceWith(fig);
    const { k, src } = plateStage(o, d);
    const cap = o.status === "checks" ? "Plated! Running checks…" : o.status === "failing" ? "On hold: a check failed" : o.status === "deploying" ? "Heading to the table…" : o.status === "ready" ? "Plated! Ready to serve" : o.status === "returned" ? "Sent back · needs a fix" : `Plating… step ${k}/${d.steps.length}`;
    fig.className = `k-plate ${o.status}`;
    fig.setAttribute("aria-label", `Plate preview: ${cap}`);
    fig.children[1].textContent = cap;
    const qc = o.status === "failing" ? "qc-fail" : o.status === "checks" ? "qc" : "";
    const qcImg = fig.children[2];
    if (qcImg._k !== qc) { qcImg._k = qc; if (qc) qcImg.src = `assets/food/plating/${qc}.svg`; qcImg.classList.toggle("on", !!qc); }
    if (fig._src === src) return;
    const art = fig.firstChild, first = !fig._src;
    fig._src = src;
    [...art.children].forEach(img => { img.classList.add("out"); setTimeout(() => img.remove(), 450); });
    const img = new Image();
    img.className = first ? "kp-img" : "kp-img in";
    img.alt = ""; img.draggable = false; img.src = src;
    img.addEventListener("animationend", () => img.classList.remove("in"), { once: true });
    art.appendChild(img);
  }

  function renderPane() {
    const o = active();
    const focused = document.activeElement;
    const control = o && paneKey.split(":")[0] === String(o.id) &&
      (headEl.contains(focused) || bodyEl.contains(focused)) ? focused.closest("button[data-act]") : null;
    $("#send-msg").disabled = !!o && modelRequests.has(o);
    shell.classList.toggle("no-order", !o);
    shell.classList.toggle("composing", !!o && stage(o) === "prompt");
    if (!o) { headEl.innerHTML = `<button class="cp-back" data-act="floor" aria-label="Back to the counter">←</button><span class="avatar cp">${cpIcon(16)}</span><div class="cp-title"><b>Copilot</b><span class="cp-sub">Your cook</span></div>`; bodyEl.innerHTML = ""; return; }
    headEl.innerHTML = `<button class="cp-back" data-act="floor" aria-label="Back to the counter">←</button>
      <span class="avatar cp">${cpIcon(16)}</span>
      <div class="cp-title"><b>Copilot</b><span class="cp-sub">Order #${o.id} · ${o.face} ${esc(o.name)}</span></div>${bar(o)}
      ${o.status === "served" ? "" : `<button class="btn ask" data-act="help">✨ Help, chef!</button>`}`;
    if (stage(o) === "prompt" && document.activeElement !== input) input.value = o.text;
    bodyEl.innerHTML = body(o);
    // Chat-style scrolling: new messages scroll in; switching orders jumps to the latest (or the plan / failing check)
    const [pid, pst, plen] = paneKey.split(":"), key = o.id + ":" + stage(o) + ":" + o.log.length;
    if (key !== paneKey) {
      paneKey = key;
      const live = stage(o) === "plan" ? bodyEl.querySelector(".plan:not(.frozen)") : stage(o) === "failing" && bodyEl.querySelector(".ck-fail");
      const fresh = +pid === o.id && +plen < o.log.length && bodyEl.querySelector(`.ent[data-i="${plen}"]`);
      const t = fresh || (+pid !== o.id || pst !== stage(o) ? live : null);
      if (t) bodyEl.scrollTop += t.getBoundingClientRect().top - bodyEl.getBoundingClientRect().top - 8;
      else if (+pid !== o.id) bodyEl.scrollTop = bodyEl.scrollHeight;
    }
    // Keep a freshly expanded step's choices visible above the sticky Approve bar
    const ok = o.id + ":" + (o.open || "");
    if (ok !== openKey) {
      openKey = ok;
      const li = o.open && bodyEl.querySelector(".steps li.open");
      if (li) {
        const box = bodyEl.getBoundingClientRect(), r = li.getBoundingClientRect(), bar = 64;
        if (r.bottom > box.bottom - bar) bodyEl.scrollTop += Math.min(r.bottom - box.bottom + bar + 8, r.top - box.top - 8);
      }
    }
    if (control) {
      const { act, arg } = control.dataset;
      const buttons = [...headEl.querySelectorAll("button[data-act]"), ...bodyEl.querySelectorAll("button[data-act]")];
      let target = buttons.find(b => b.dataset.act === act && b.dataset.arg === arg && !b.disabled);
      if (!target && act === "pick") target = buttons.find(b => b.dataset.act === "expand" && b.dataset.arg === arg.split(":")[0]);
      if (!target && act === "reprompt" && stage(o) === "prompt") target = input;
      if (!target && act === "fixck") target = bodyEl.querySelector('.ck-fix:not([disabled])');
      if (!target) target = headEl.querySelector('[data-act="help"]');
      target?.focus({ preventScroll: true });
    }
  }
  let paneKey = "", openKey = "";

  const food = (d, size = "") => `<img class="food ${size}" src="assets/food/${d.art}.svg" alt="" aria-hidden="true" draggable="false">`;
  const cpSay = html => `<div class="msg bot"><span class="avatar cp">${cpIcon(14)}</span><div class="bubble">${html}</div></div>`;
  const userMsg = html => `<div class="msg user"><div class="bubble">${html}</div></div>`;
  const custMsg = (o, html) => `<div class="msg cust"><span class="avatar cust-av">${o.face}</span><div class="bubble"><small>@${esc(first(o).toLowerCase())}</small>${html}</div></div>`;
  // Each order keeps its own chat history with Copilot.
  const say = (o, html) => { if (o.log[o.log.length - 1] !== html) o.log.push(html); };
  function body(o) {
    const st = stage(o), d = o.dish && dishOf(o.dish);
    let h = issueHtml(o, d) + o.log.map((x, i) => `<div class="ent" data-i="${i}">${x}</div>`).join("");
    if (st === "prompt") h += promptHtml(o);
    else if (st === "plan") h += planHtml(o, d);
    else if (st === "failing") h += failHtml(o);
    else if (st === "checks") h += checksList(o);
    else if (st === "cooking" || st === "deploying") h += `<div class="msg bot typing"><span class="avatar cp">${cpIcon(14)}</span><div class="bubble"><i></i><i></i><i></i></div></div>`;
    return h;
  }

  function failHtml(o) {
    const f = o.fail, c = o.checks.find(x => x.state === "fail");
    return `<article class="ck-fail">
      <div class="ck-fail-head"><span class="ck-ic fail">✗</span><div><b>${esc(f.title)}</b><span>${esc(c.app)} · ${esc(c.diner)}</span></div></div>
      <pre class="ck-log">${f.log.map(l => esc(l)).join("\n")}</pre>
      <div class="chips-label">How do you fix it?</div>
      <div class="ck-fixes">${f.fixes.map(x => {
        const tried = o.tried.includes(x.id), hint = o.flag.includes(x.id);
        return `<button class="ck-fix${tried ? " tried" : ""}${hint ? " hint" : ""}" data-act="fixck" data-arg="${x.id}"${tried ? " disabled" : ""}>${esc(x.text)}${tried ? `<small>✗ ${esc(x.why)}</small>` : ""}</button>`;
      }).join("")}</div>
    </article>`;
  }

  // The customer's ask, shown as a GitHub issue: an order ticket assigned to Copilot.
  const ICONS = { open: `<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M8 9.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Z"/><path fill="currentColor" d="M8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0ZM1.5 8a6.5 6.5 0 1 0 13 0 6.5 6.5 0 0 0-13 0Z"/></svg>`,
      closed: `<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M11.28 6.78a.75.75 0 0 0-1.06-1.06L7.25 8.69 5.78 7.22a.75.75 0 0 0-1.06 1.06l2 2a.75.75 0 0 0 1.06 0l3.5-3.5Z"/><path fill="currentColor" d="M16 8A8 8 0 1 1 0 8a8 8 0 0 1 16 0Zm-1.5 0a6.5 6.5 0 1 0-13 0 6.5 6.5 0 0 0 13 0Z"/></svg>` };
  function issueLabels(o, d) {
    const labels = [];
    if (d) labels.push(`<span class="lbl dish">${food(d)}${esc(d.name.toLowerCase())}</span>`);
    if (o.status !== "served" && o.patience < 40) labels.push(`<span class="lbl hangry">⚠ priority: hangry</span>`);
    if (o.status === "cooking") labels.push(`<span class="lbl cooking">🍳 cooking</span>`);
    if (o.status === "checks") labels.push(`<span class="lbl checks">● checks running</span>`);
    if (o.status === "failing") labels.push(`<span class="lbl failing">✗ checks failing</span>`);
    if (o.status === "ready") labels.push(HUB ? `<span class="lbl ready">✓ checks passed</span>` : `<span class="lbl ready">🛎 ready</span>`);
    if (o.status === "deploying") labels.push(`<span class="lbl checks">🚀 deploying</span>`);
    if (o.returns) labels.push(`<span class="lbl sent-back">↩ sent back</span>`);
    return labels;
  }
  function issueHtml(o, d) {
    const handle = "@" + first(o).toLowerCase();
    const state = o.status === "served" ? ["closed", "Served"] : o.returns ? ["open", "Reopened"] : ["open", "Open"];
    const labels = issueLabels(o, d);
    let h = `<article class="issue">
      <div class="is-top"><span class="is-state ${state[0]}">${ICONS[state[0]]} ${state[1]}</span><span class="is-meta">opened by <b>${esc(handle)}</b></span></div>
      <h3 class="is-title">${d ? `${food(d, "xl")}${esc(d.name)}` : "New order"} <span class="is-num">#${o.id}</span></h3>
      <div class="is-labels">${labels.join("")}</div>
      <div class="is-comment"><span class="is-av">${o.face}</span><div class="is-c-body"><div class="is-c-head"><b>${esc(handle)}</b> commented</div><p>${esc(o.speech)}</p></div></div>`;
    if (d) h += `<div class="is-foot"><span>🔗 Linked stack: <code>order/${o.id}-${d.id}</code></span></div>`;
    h += `</article>`;
    return h;
  }

  function promptHtml(o) {
    const dr = o.draft, dd = dr.dish && dishOf(dr.dish);
    return `<div class="chips-card">
        ${modelRequests.has(o) ? `<p role="status">Copilot is proposing a plan...</p><button class="btn ghost" data-act="cancelmodel">Cancel request</button>` : ""}
        ${modelNotices.has(o) ? `<p role="alert">${esc(modelNotices.get(o))}</p><button class="btn ghost" data-act="retrymodel">Retry prompt</button>` : ""}
        <div class="chips-label">Dish</div>
        <div class="chips">${MENU.map(m => `<button class="chip ${dr.dish === m.id ? "on" : ""}" data-act="dish" data-arg="${m.id}" aria-pressed="${dr.dish === m.id}">${food(m)}${esc(m.name)}</button>`).join("")}</div>
        ${dd ? `<div class="chips-label">Details</div>
        <div class="chips">${dd.opts.map(x => `<button class="chip opt ${dr.opts.includes(x.id) ? "on" : ""}" data-act="opt" data-arg="${x.id}" aria-pressed="${dr.opts.includes(x.id)}">${esc(x.alt)}</button>`).join("")}</div>` : ""}
      </div>`;
  }

  function planHtml(o, d, frozen) {
    const steps = Copilot.plan(o.dish, o.set), fix = o.prs.length > 0;
    const assumed = steps.filter(s => s.opt && !o.asked.includes(s.opt)).length;
    const rows = steps.slice().reverse().map(s => {
      const tag = !s.opt ? "" : o.asked.includes(s.opt) ? `<span class="tag asked">you asked</span>` : `<span class="tag assumed">assumed</span>`;
      const rebuild = fix && o.built[s.i] !== s.title ? `<span class="tag rebuild">fix-up</span>` : "";
      const inner = `<span class="st-emoji">${s.emoji}</span><span class="st-title">${esc(s.title)}</span>${tag}${rebuild}`;
      if (!s.opt || frozen) return `<li><div class="step">${inner}</div></li>`;
      const open = o.open === s.opt, opt = d.opts.find(x => x.id === s.opt), base = d.steps[s.i][1];
      const why = o.asked.includes(s.opt) ? "You asked for this in your prompt." : "Your prompt didn't say, so Copilot assumed. Is it what they ordered?";
      const choice = (on, title, sub) => `<button class="ch ${s.on === on ? "on" : ""}" role="radio" aria-checked="${s.on === on}" data-act="pick" data-arg="${s.opt}:${on ? 1 : 0}">
          <span class="ch-dot" aria-hidden="true"></span><span class="ch-txt"><b>${esc(title)}</b><small>${sub}</small></span></button>`;
      return `<li class="${open ? "open" : ""}"><button class="step toggle ${o.flag.includes(s.opt) ? "flag" : ""}" data-act="expand" data-arg="${s.opt}" aria-expanded="${open}">${inner}<span class="swap" aria-hidden="true">${open ? "▴" : "Change ▾"}</span></button>
        ${open ? `<div class="choices"><div class="ch-why">${why}</div><div class="ch-list" role="radiogroup" aria-label="Choose a version of this step">
          ${choice(false, base, "Standard")}${choice(true, opt.to, esc(opt.alt))}</div></div>` : ""}</li>`;
    }).join("");
    const tip = assumed && !frozen ? ` Tap <b>Change</b> on a step to pick a different version.` : "";
    return cpSay(fix ? `Here's the updated plan.${frozen ? "" : " Tap <b>Change</b> on the step that's wrong, then approve the fix."}`
      : `Here's my plan for ${food(d)}<b>${esc(d.name.toLowerCase())}</b>: ${steps.length} PRs, bottom to top.${assumed ? ` I made <b>${assumed} assumption${assumed > 1 ? "s" : ""}</b>.` : ""}${tip}`) + `
      <div class="plan card${frozen ? " frozen" : ""}"><div class="plan-head">${food(d, "lg")}Plan · ${esc(d.name)}${frozen ? ` <span class="tag asked">approved</span>` : ""}</div><ol class="steps">${rows}</ol>
        ${frozen ? "" : `<div class="plan-acts"><button class="btn ghost" data-act="reprompt">Edit prompt</button>
        <button class="btn primary" data-act="approve">${fix ? "Approve fix" : "Approve plan"}</button></div>`}</div>`;
  }

  // ---------- Celebrations ----------
  function fitCertificate() {
    if (!certEl.classList.contains("show")) return;
    const inner = certEl.querySelector(".cert-inner");
    inner.style.transform = "none";
    const padding = getComputedStyle(certEl);
    const availableWidth = certEl.clientWidth - parseFloat(padding.paddingLeft) - parseFloat(padding.paddingRight);
    const availableHeight = certEl.clientHeight - parseFloat(padding.paddingTop) - parseFloat(padding.paddingBottom);
    const scale = Math.min(1, availableWidth / inner.offsetWidth, availableHeight / inner.offsetHeight);
    inner.style.transform = `scale(${scale})`;
    inner.style.marginTop = `${Math.max(0, (availableHeight - inner.offsetHeight * scale) / 2)}px`;
  }
  window.addEventListener("resize", fitCertificate);
  window.visualViewport?.addEventListener("resize", fitCertificate);

  function showCert() {
    $("#cert-name").textContent = S.chef || "A Very Good Chef";
    $("#cert-body").innerHTML = `fulfilled ${GOAL} orders in <b>${mmss(S.elapsed)}</b>.`;
    $("#cert-date").textContent = new Date().toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
    certEl.classList.add("show");
    fitCertificate();
    sfx("win");
  }

  // ---------- Sound + toast ----------
  let audio;
  function sfx(kind) {
    try {
      audio = audio || new (window.AudioContext || window.webkitAudioContext)();
      const notes = { good: [660, 880, 1320], bad: [220, 165], bell: [1046, 1318], win: [523, 659, 784, 1046, 1318] }[kind];
      notes.forEach((f, i) => {
        const o = audio.createOscillator(), g = audio.createGain(), at = audio.currentTime + i * .09;
        o.type = kind === "bad" ? "sawtooth" : "triangle";
        o.frequency.value = f;
        g.gain.setValueAtTime(.0001, at);
        g.gain.exponentialRampToValueAtTime(.12, at + .02);
        g.gain.exponentialRampToValueAtTime(.0001, at + .22);
        o.connect(g).connect(audio.destination);
        o.start(at); o.stop(at + .25);
      });
    } catch (e) { /* audio is optional */ }
  }
  function toast(msg) {
    const t = $("#toast");
    t.textContent = msg; t.classList.add("show");
    clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove("show"), 2600);
  }

  // ---------- Layout: two panes on desktop; on phones one at a time ----------
  // Phones show one column at a time, switched by the tab bar.
  function setView(v) {
    shell.dataset.view = v;
    document.querySelectorAll("#m-tabs button").forEach(b => b.classList.toggle("on", b.dataset.arg === v));
    if (v === "line") renderCounter();
    if (v === "cp") { paneKey = ""; renderPane(); }
  }

  function select(id) {
    S.active = id;
    talkTo(active());
    renderAll();
    if (mobile.matches) setView("cp");
    if (stage(active()) === "prompt" && !mobile.matches) input.focus();
  }
  // Jump to what needs fixing: open the flagged plan step (or the failing check) and spotlight it.
  function goTo(id) {
    const o = S.orders.find(x => x.id === id);
    if (o?.flag?.length && stage(o) === "plan") o.open = o.flag[0];
    select(id);
    requestAnimationFrame(() => {
      const t = bodyEl.querySelector(".ck-fail") || bodyEl.querySelector(".steps li.open") || bodyEl.querySelector(".plan:not(.frozen)");
      if (!t) return;
      t.scrollIntoView({ block: "center", behavior: "smooth" });
      t.classList.remove("spot"); void t.offsetWidth; t.classList.add("spot");
      t.querySelector(".ch, .ck-fix:not([disabled])")?.focus({ preventScroll: true });
    });
  }
  function nextOrder() {
    const n = atRegister() || pickupList().find(o => o.status === "failing" || o.status === "ready" || o.status === "returned");
    if (n) return select(n.id);
    toast(S.served === TOTAL ? "Everyone's fed 🎉" : "Nothing needs you right now. Copilot's cooking 🍳");
    setView("line");
  }

  function restart() {
    overDlg.open && overDlg.close();
    stopTimer();
    modelNotices.clear();
    certEl.classList.remove("show");
    clearTimeout(cookT); cookT = null;
    newShift();
    counterEl.innerHTML = ""; kitchenEl.innerHTML = "";
    setView("line");
    startBtn.textContent = "Start shift";
    input.value = "";
    renderAll();
    if (!infoDlg.open) infoDlg.showModal();
    saveSoon();
  }

  // ---------- Input ----------
  document.addEventListener("click", e => {
    const b = e.target.closest("[data-act]");
    if (!b || b.disabled) return;
    if (b.dataset.act === "summary-close") { overDlg.close(); return; }
    if (b.dataset.act === "restart" && canvas && loaded && !lifecycleFailed && !controller.canEdit()) {
      controller.resume().then(ok => { if (ok) restart(); }).catch(() => {});
      return;
    }
    if (!canEdit()) return;
    const o = active(), arg = b.dataset.arg;
    switch (b.dataset.act) {
      case "order": return select(+arg);
      case "goto": return goTo(+arg);
      case "floor": return setView("line");
      case "view": return setView(arg);
      case "hubtab": hubTab = arg; return renderIssues();
      case "fixck": tryFix(active(), arg); return renderAll();
      case "serve": {
        const so = S.orders.find(x => x.id === +arg);
        if (HUB && so && so.status === "ready") {
          so.status = "deploying"; say(so, cpSay("🚀 Merged! The deploy workflow is taking it to the table…")); renderAll();
          so.delay = { deploy: 1200 };
          return;
        }
        serve(so); renderAll();
        // Phones: jump to the counter so you see them eat, say thanks, and tip
        if (mobile.matches) {
          setView("line");
          counterEl.querySelectorAll(".seat")[so?.seat]?.scrollIntoView({ block: "center", behavior: "smooth" });
        }
        return;
      }
      case "next": return nextOrder();
      case "restart": return restart();
      case "fleet-all": overDlg.close(); return fleetAll();
    }
    if (!o) return;
    switch (b.dataset.act) {
      case "cancelmodel": cancelModel(o); return renderPane();
      case "retrymodel": return send();
      case "dish":
        cancelModel(o);
        o.draft = { dish: arg, opts: o.draft.dish === arg ? o.draft.opts : [] };
        break;
      case "opt": {
        cancelModel(o);
        const has = o.draft.opts.includes(arg);
        o.draft.opts = has ? o.draft.opts.filter(x => x !== arg) : [...o.draft.opts, arg];
        break;
      }
      case "help": help(o); return renderPane();
      case "toggle": toggle(o, arg); return renderPane();
      case "expand": o.open = o.open === arg ? null : arg; return renderPane();
      case "pick": { const [id, on] = arg.split(":"); pickStep(o, id, on === "1"); return renderPane(); }
      case "reprompt":
        cancelModel(o);
        o.text = Copilot.promptText(o.dish, o.asked); o.draft = { dish: o.dish, opts: [...o.asked] };
        o.dish = null; o.sent = ""; o.help = null;
        say(o, cpSay("No problem. Change the prompt and send it again."));
        return renderPane();
      case "approve": approve(o); return renderAll();
      default: return;
    }
    // chip clicked: the chips write the prompt for you
    o.text = input.value = Copilot.promptText(o.draft.dish, o.draft.opts);
    o.help = null;
    renderPane();
  });
  input.addEventListener("input", () => {
    if (!canEdit()) return;
    const o = active();
    if (!o || stage(o) !== "prompt") return;
    cancelModel(o);
    o.text = input.value;
    const p = Copilot.parse(input.value);
    o.draft = { dish: p.dish, opts: p.opts };
    renderPane();
  });
  function send() {
    if (!canEdit()) return;
    const o = active();
    if (!o || stage(o) !== "prompt") return;
    if (modelRequests.has(o)) return;
    sendPrompt(o, input.value || Copilot.promptText(o.draft.dish, o.draft.opts));
    renderAll();
  }
  $("#send-msg").onclick = send;
  input.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); send(); } });
  mobile.addEventListener?.("change", () => setView("line"));
  window.addEventListener("resize", () => renderCounter());

  // ---------- Dialogs ----------
  $("#info-btn").onclick = () => {
    pauseShift();
    if (!infoDlg.open) infoDlg.showModal();
  };
  async function resumeShift() {
    if (!loaded || lifecycleFailed || hidden()) return;
    startBtn.disabled = true;
    if (canvas && !await controller.resume().catch(() => false)) { startBtn.disabled = lifecycleFailed; return; }
    $("#lifecycle-status").hidden = true;
    resumed = true;
    startBtn.disabled = false;
    if (infoDlg.open) infoDlg.close();
    beginShift();
    if (canvas) await controller.save().catch(() => {});
  }
  function dismissInfo() {
    if (S.phase === "shift") resumeShift();
    else infoDlg.close();
  }
  infoDlg.querySelector(".close").onclick = dismissInfo;
  infoDlg.addEventListener("click", e => { if (e.target === infoDlg) dismissInfo(); });
  infoDlg.addEventListener("cancel", e => { e.preventDefault(); dismissInfo(); });
  startBtn.onclick = resumeShift;
  nameInput.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); resumeShift(); } });
  // Standalone keeps its close-to-start behavior; canvas requires the Resume button.
  function beginShift() {
    if (!resumed) return;
    S.chef = nameInput.value.trim() || S.chef;
    if (S.phase === "welcome") {
      S.phase = "shift";
      while (S.queue.length && S.queue[0].at <= 0) arrive();
      startBtn.textContent = "Resume shift";
      if (!mobile.matches && !active() && atRegister()) { S.active = atRegister().id; talkTo(active()); }
      renderAll();
      startTimer();
      toast("🛎 Doors are open! Customers are lining up.");
    } else if (S.phase === "shift" && !S.timer) {
      renderAll();
      startTimer();
      toast("⏱ Shift resumed.");
    }
  }
  infoDlg.addEventListener("close", () => {
    if (!canvas && !resumed) { resumed = true; beginShift(); }
  });
  overDlg.addEventListener("cancel", e => {
    if (S.phase !== "won") e.preventDefault();
  });

  // Test hooks
  const api = { tryFix, tick, select, active: () => active(), sendPrompt, approve, serve, help, toggle, fleetAll, restart, renderAll,
    snapshot, pause: pauseShift, resume: resumeShift };
  window.__mo = api;

  newShift();
  renderAll();
  infoDlg.showModal();
  function snapshot() {
    const { timer, ...state } = S;
    return DinerSnapshot.validate(JSON.parse(JSON.stringify({
      version: DinerSnapshot.VERSION, view: HUB ? "hub" : "classic",
      state: { ...state, queue: S.queue.map(q => ({ ...q, d: q.d.id })) },
    })));
  }
  function saveSoon() {
    if (!canvas || !loaded || lifecycleFailed || !controller) return;
    controller.saveSoon();
  }
  function pauseShift() {
    stopTimer();
    if (canvas && controller) controller.pause().catch(() => {});
    if (S.phase === "shift" && !infoDlg.open) infoDlg.showModal();
  }
  document.addEventListener("click", saveSoon);
  input.addEventListener("input", saveSoon);
  nameInput.addEventListener("input", () => {
    if (!canEdit()) return;
    S.chef = nameInput.value.trim();
    renderHud();
    saveSoon();
  });
  document.addEventListener("visibilitychange", () => { if (document.hidden) pauseShift(); });
  window.addEventListener("pagehide", () => {
    pageClosed = true;
    initializationGeneration++;
    initializationAbort?.abort();
    stopTimer();
    if (controller) controller.close().catch(() => {});
  });
  if (canvas) {
    // Page Visibility alone does not detect an iframe hidden with CSS by its parent.
    const tracksVisibility = window.self !== window.top && "isVisible" in IntersectionObserverEntry.prototype;
    const visibleEntry = DinerLifecycle.createVisibilityTracker(tracksVisibility);
    const observer = new IntersectionObserver(([entry]) => {
      canvasVisible = visibleEntry(entry);
      if (!canvasVisible) pauseShift();
    }, tracksVisibility ? { trackVisibility: true, delay: 100 } : {});
    observer.observe(document.documentElement);
    window.addEventListener("pagehide", () => observer.disconnect(), { once: true });
  }
  if (canvas) {
    const retry = $("#retry-loading");
    function initializeCanvas() {
      if (initializing || pageClosed || loaded) return initializing;
      const attempt = ++initializationGeneration;
      const abort = new AbortController();
      initializationAbort = abort;
      const current = () => !pageClosed && attempt === initializationGeneration && !abort.signal.aborted;
      startBtn.disabled = true;
      retry.hidden = false; retry.disabled = true;
      $("#lifecycle-status").hidden = false;
      $("#lifecycle-message").textContent = "Loading diner configuration...";
      let candidate;
      initializing = (async () => {
        try {
          const configResponse = await fetch("/_diner/config", {
            signal: AbortSignal.any([abort.signal, AbortSignal.timeout(5000)]),
          });
          if (!configResponse.ok) throw new Error("Could not load diner configuration.");
          const config = await configResponse.json();
          if (!current()) return;
          if (!config || typeof config !== "object" ||
              typeof config.gameId !== "string" || !/^[a-z0-9_-]{1,64}$/.test(config.gameId) ||
              typeof config.capability !== "string" || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(config.capability) ||
              typeof config.copilot !== "boolean" || typeof config.copilotMessage !== "string") {
            throw new Error("Invalid diner configuration.");
          }
          candidate = DinerLifecycle.createController({
            snapshot, restore: () => {}, hidden,
            pause: () => { if (current()) stopTimer(); },
            error: message => { if (current()) lifecycleError(message); },
            interrupted: message => { if (current()) controlInterrupted(message); },
            transport: async body => {
              const payload = body ? JSON.stringify(body) : null;
              const keepalive = !!body && body.op === "release" && new TextEncoder().encode(payload).length <= 65536;
              const response = await fetch("/_diner/state", {
                method: body ? "POST" : "GET", keepalive,
                headers: { "X-Diner-Capability": config.capability, ...(body ? { "Content-Type": "application/json" } : {}) },
                ...(body ? { body: payload } : {}),
                signal: AbortSignal.any([abort.signal, AbortSignal.timeout(5000)]),
              });
              if (!response.ok) throw new Error(await response.text());
              const result = await response.json();
              if (!result || typeof result !== "object" ||
                  (!body && (typeof result.busy !== "boolean" || !Object.hasOwn(result, "snapshot")))) {
                throw new Error("Invalid diner state response.");
              }
              if (result.snapshot != null) DinerSnapshot.validate(result.snapshot);
              return result;
            },
          });
          await candidate.load();
          if (!current()) return;
          controller = candidate;
          initializationAbort = null;
          dinerConfig = config;
          liveAvailable = config.copilot === true;
          lifecycleFailed = false;
          loaded = true; startBtn.disabled = false;
          retry.hidden = true;
          $("#lifecycle-status").hidden = true;
          renderAll();
        } catch (e) {
          if (current()) {
            lifecycleError(e.name === "TimeoutError" ? "Diner loading timed out. Retry loading to try again." : e.message);
            retry.hidden = false;
          }
        } finally {
          if (candidate && candidate !== controller) await candidate.close();
          if (attempt === initializationGeneration) {
            initializing = null;
            retry.disabled = false;
            initializationAbort = null;
          }
        }
      })().catch(error => {
        if (current()) lifecycleError(error.message);
        console.error(error);
      });
      return initializing;
    }
    retry.onclick = initializeCanvas;
    initializeCanvas();
  }
})();
