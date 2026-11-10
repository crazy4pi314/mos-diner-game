import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createDinerHost } from "./hosting.mjs";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const trace = message => { if (process.env.DINER_BROWSER_TRACE) console.error(`[browser] ${message}`); };
async function until(action, message, attempts = 100) {
    for (let i = 0; i < attempts; i++) {
        const result = await action();
        if (result) return result;
        await wait(100);
    }
    throw new Error(message);
}
async function connect(url, runtime = true) {
    const socket = new WebSocket(url), pending = new Map(), errors = [], contexts = [];
    let id = 0;
    await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
    socket.onmessage = event => {
        const message = JSON.parse(event.data);
        if (message.method === "Runtime.exceptionThrown") errors.push(message.params.exceptionDetails);
        if (message.method === "Runtime.executionContextCreated") contexts.push(message.params.context);
        if (!message.id) return;
        const item = pending.get(message.id);
        if (!item) return;
        pending.delete(message.id);
        clearTimeout(item.timer);
        if (message.error) item.reject(new Error(message.error.message)); else item.resolve(message.result);
    };
    const send = (method, params = {}) => new Promise((resolve, reject) => {
        const number = ++id;
        const timer = setTimeout(() => { pending.delete(number); reject(new Error(`CDP timeout: ${method}`)); }, 10000);
        pending.set(number, { resolve, reject, timer });
        socket.send(JSON.stringify({ id: number, method, params }));
    });
    if (runtime) await send("Runtime.enable");
    return {
        send, errors, contexts, close: () => socket.close(),
        async evaluate(expression, contextId) {
            const response = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true,
                ...(contextId ? { contextId } : {}) });
            if (response.exceptionDetails) throw new Error(JSON.stringify(response.exceptionDetails));
            return response.result.value;
        },
    };
}
const accessibilityOnly = process.env.DINER_BROWSER_ACCESSIBILITY_ONLY === "1";
const ticketOnly = process.env.DINER_BROWSER_TICKET_ONLY === "1";
const recoveryOnly = process.env.DINER_BROWSER_RECOVERY_ONLY === "1";
test(recoveryOnly ? "Edge: save timeout recovery preserves the live shift"
    : ticketOnly ? "Edge: kitchen ticket and session best times"
    : accessibilityOnly ? "Edge: accessibility focus, modal, navigation, motion and reflow"
    : "Edge: offline startup, retry, lifecycle and deterministic play", { timeout: 240000 }, async t => {
    try {
    const candidates = [process.env.DINER_EDGE, process.env["ProgramFiles(x86)"] && join(process.env["ProgramFiles(x86)"], "Microsoft", "Edge", "Application", "msedge.exe"),
        process.env.ProgramFiles && join(process.env.ProgramFiles, "Microsoft", "Edge", "Application", "msedge.exe")].filter(Boolean);
    let executable;
    for (const candidate of candidates) {
        try { await access(candidate); executable = candidate; break; } catch { /* Try the next installed location. */ }
    }
    if (!executable) return t.skip("Microsoft Edge not installed; set DINER_EDGE to run browser checks.");
    const directory = await mkdtemp(join(root, ".diner-edge-test-"));
    const profile = join(directory, "profile"), stateDirectory = join(directory, "state");
    let modelBehavior = "ok", modelAborted = false, modelCalls = 0, finishModel;
    let runtimeAvailable = true;
    const host = createDinerHost(root, {
        stateDirectory,
        runtimeStatus: async () => ({
            available: runtimeAvailable,
            message: runtimeAvailable ? "CLI executable found; sign-in, network and model access unverified." :
                "No executable Copilot CLI found on PATH. Deterministic play is ready.",
        }),
        interpret: async (_, signal) => {
            modelCalls++;
            signal.throwIfAborted();
            if (modelBehavior === "fail") throw new Error("Model unavailable");
            if (modelBehavior === "invalid") return { dish: "merge-melt", opts: ["cold-cache"], note: "" };
            if (modelBehavior === "wait") await new Promise((resolve, reject) => {
                signal.addEventListener("abort", () => { modelAborted = true; reject(signal.reason); }, { once: true });
            });
            if (modelBehavior === "late") await new Promise(resolve => { finishModel = resolve; });
            return { dish: "stacked-pr-pancakes", opts: [], note: "Other details use house defaults." };
        },
    });
    host.onError = () => {};
    const url = await host.open("edge", { gameId: "browser" });
    const edge = spawn(executable, ["--headless=new", "--no-first-run", "--no-default-browser-check",
        "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--disable-background-timer-throttling", "about:blank"],
    { stdio: "ignore" });
    const connections = [];
    let browser;
    t.after(async () => {
        trace("cleaning up browser");
        for (const connection of connections) connection.close();
        if (browser) await browser.send("Browser.close").catch(() => {});
        if (process.platform === "win32") {
            const cleanup = spawn("powershell.exe", ["-NoProfile", "-Command",
                `$profilePath = '${profile.replaceAll("'", "''")}'; Get-CimInstance Win32_Process -Filter "Name = 'msedge.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($profilePath) } | ForEach-Object { Stop-Process -Id $_.ProcessId -ErrorAction SilentlyContinue }`],
            { stdio: "ignore" });
            await new Promise(resolve => cleanup.once("exit", resolve));
        }
        edge.kill();
        await host.shutdown();
        trace("host stopped");
        await wait(500);
        await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
        trace("browser profile removed");
    });
    const port = await until(async () => {
        try { return Number((await readFile(join(profile, "DevToolsActivePort"), "utf8")).split("\n")[0]); }
        catch { return false; }
    }, "Edge did not start its debugging endpoint.");
    const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
    browser = await connect(version.webSocketDebuggerUrl, false);
    async function page(address, { before = "", ready = true } = {}) {
        trace(`opening page ${connections.length + 1}`);
        const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" })).json();
        const connection = await connect(target.webSocketDebuggerUrl);
        connection.closePage = () => browser.send("Target.closeTarget", { targetId: target.id });
        connections.push(connection);
        await connection.send("Page.enable");
        await connection.send("Network.enable");
        await connection.send("Network.setBlockedURLs", { urls: ["https://*"] });
        if (before) await connection.send("Page.addScriptToEvaluateOnNewDocument", { source: before });
        await connection.send("Page.navigate", { url: address });
        await until(() => connection.evaluate(`!!window.__mo ${ready ? '&& !document.querySelector("#start-shift").disabled' : ""}`), "Game did not become ready.");
        // Headless tabs are not necessarily foreground. Control visibility explicitly.
        await connection.evaluate('Object.defineProperty(document, "hidden", { configurable: true, value: false })');
        trace(`page ${connections.length} ready`);
        return connection;
    }
    async function resume(connection) {
        trace("resuming shift");
        await until(() => connection.evaluate('!document.querySelector("#start-shift").disabled'),
            "The visible Start/Resume button did not become ready.");
        await connection.evaluate('document.querySelector("#start-shift").click()');
        await until(() => connection.evaluate('__mo.S.timer !== null && !document.querySelector("#info-dialog").open'),
            "The ready Start/Resume button did not start the shift.").catch(async error => {
                const state = await connection.evaluate(`({
                  phase: __mo.S.phase, hidden: document.hidden, dialog: document.querySelector("#info-dialog").open,
                  disabled: document.querySelector("#start-shift").disabled,
                  message: document.querySelector("#lifecycle-message").textContent
                })`);
                throw new Error(`${error.message} ${JSON.stringify(state)}`);
            });
        trace("shift running");
    }
    async function key(connection, value, modifiers = 0) {
        await connection.send("Input.dispatchKeyEvent", { type: "keyDown", key: value, modifiers });
        await connection.send("Input.dispatchKeyEvent", { type: "keyUp", key: value, modifiers });
    }
    if (recoveryOnly || (!accessibilityOnly && !ticketOnly)) {
        for (const committed of [false, true]) {
            const id = `save-timeout-${committed}`;
            const recovering = await page(await host.open(id, { gameId: id }), {
                before: `
                  window.__timeoutSave = false;
                  const originalFetch = window.fetch.bind(window);
                  window.fetch = async (path, options) => {
                    if (path === "/_diner/state" && options?.body &&
                        JSON.parse(options.body).op === "save" && window.__recordRecovery) {
                      window.__recordRecovery = false;
                      window.__recoverySnapshot = JSON.parse(options.body).snapshot;
                    }
                    if (path === "/_diner/state" && options?.body &&
                        JSON.parse(options.body).op === "save" && window.__timeoutSave) {
                      window.__timeoutSave = false;
                      if (${committed}) await originalFetch(path, options);
                      return new Promise((resolve, reject) => {
                        if (options.signal.aborted) reject(options.signal.reason);
                        else options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
                      });
                    }
                    return originalFetch(path, options);
                  };
                `,
            });
            await resume(recovering);
            await recovering.evaluate(`(() => {
              const o = __mo.active();
              __mo.sendPrompt(o, Copilot.promptText(o.want.dish, o.want.opts));
              __mo.approve(o); __mo.renderAll();
              window.__timeoutSave = true;
              document.body.dispatchEvent(new Event("click", { bubbles: true }));
            })()`);
            await until(() => recovering.evaluate('document.querySelector("#info-dialog").open && /timed out/.test(document.querySelector("#lifecycle-message").textContent)'),
                "A save timeout must pause with a recoverable explanation.");
            const paused = await recovering.evaluate("__mo.snapshot()");
            assert.equal(await recovering.evaluate("__mo.S.timer"), null);
            await until(() => recovering.evaluate('!document.querySelector("#start-shift").disabled'),
                "A save timeout must leave Resume available.");
            await wait(1100);
            assert.deepEqual(await recovering.evaluate("__mo.snapshot()"), paused, "Never advance offline time while recovering.");
            assert.deepEqual(await recovering.evaluate(`(async () => {
              window.__recordRecovery = true;
              await document.querySelector("#start-shift").onclick();
              return {
                running: __mo.S.timer !== null,
                dialogOpen: document.querySelector("#info-dialog").open,
                snapshot: window.__recoverySnapshot
              };
            })()`), { running: true, dialogOpen: false, snapshot: paused },
                "The first resumed save must keep the live shift; active clocks may advance while its response arrives.");
            assert.equal(await recovering.evaluate(`(() => {
              const elapsed = __mo.S.elapsed; __mo.tick(); return __mo.S.elapsed === elapsed + 1;
            })()`), true, "Gameplay must continue after recovery.");
            assert.deepEqual(recovering.errors, []);
            await recovering.evaluate("__mo.pause()");
            await host.close(id);
            await recovering.closePage();
        }
        trace("save timeout recovery before/after commit passed");
        if (recoveryOnly) return;
    }
    if (!accessibilityOnly && !ticketOnly) {
    for (const skin of ["default", "cozy"]) {
        for (const view of ["hub", "classic"]) {
            const id = `offline-${skin}-${view}`;
            const offline = await page(await host.open(id, { gameId: id, skin, view }));
            assert.deepEqual(await offline.evaluate('Array.from(document.querySelectorAll("#m-tabs button"), b => b.firstChild.textContent.replace(/[^A-Za-z]/g, ""))'),
                ["Orders", "Prep", "Kitchen"]);
            assert.deepEqual(await offline.evaluate('Array.from(document.querySelectorAll(".shell > section"), pane => pane.getAttribute("aria-label"))'),
                ["Orders", "Prep", "Kitchen"]);
            assert.equal(await offline.evaluate('document.querySelector(".k-head b").textContent'), "Kitchen");
            if (skin === "cozy") {
                assert.equal(await offline.evaluate(`(async () => {
                  await document.fonts.load('500 16px "Fredoka"');
                  await document.fonts.load('500 16px "DM Mono"');
                  return document.fonts.check('500 16px "Fredoka"') && document.fonts.check('500 16px "DM Mono"');
                })()`), true);
                assert.ok(await offline.evaluate('performance.getEntriesByType("resource").some(r => r.name.includes("/fonts/fredoka-latin.woff2"))'));
            } else {
                assert.equal(await offline.evaluate('performance.getEntriesByType("resource").some(r => /fredoka|dm-mono/.test(r.name))'), false);
            }
            assert.deepEqual(await offline.evaluate('performance.getEntriesByType("resource").filter(r => !r.name.startsWith(location.origin)).map(r => r.name)'), []);
            assert.equal(await offline.evaluate("__mo.S.phase"), "welcome");
            assert.equal(await offline.evaluate("__mo.S.timer"), null);
            await host.close(id);
            await offline.closePage();
        }
    }
    for (const failure of ["timeout", "http", "config", "state"]) {
        const id = `retry-${failure}`;
        const retrying = await page(await host.open(id, { gameId: id }), {
            ready: false,
            before: `
              const originalFetch = window.fetch.bind(window);
              window.__configCalls = 0; window.__stateCalls = 0;
              window.fetch = (path, options) => {
                if (path === "/_diner/config") {
                  window.__configCalls++;
                  if (__configCalls === 1) {
                    if ("${failure}" === "timeout") return new Promise((resolve, reject) =>
                      options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true }));
                    if ("${failure}" === "http") return Promise.resolve(new Response("Unavailable", { status: 503 }));
                    if ("${failure}" === "config") return Promise.resolve(Response.json({ gameId: "bad" }));
                  }
                }
                if (path === "/_diner/state") {
                  window.__stateCalls++;
                  if ("${failure}" === "state" && __stateCalls === 1) return Promise.resolve(Response.json({
                    revision: 0, busy: false, snapshot: { version: 99 }
                  }));
                }
                return originalFetch(path, options);
              };
            `,
        });
        await until(() => retrying.evaluate('!document.querySelector("#retry-loading").hidden && !document.querySelector("#retry-loading").disabled'),
            "Loading failure did not expose a usable retry.");
        assert.equal(await retrying.evaluate('document.querySelector("#start-shift").disabled'), true);
        assert.match(await retrying.evaluate('document.querySelector("#lifecycle-message").textContent'),
            failure === "timeout" ? /timed out/ : failure === "http" ? /configuration/ : failure === "config" ? /Invalid/ : /Unsupported/);
        await retrying.evaluate('document.querySelector("#retry-loading").onclick(); document.querySelector("#retry-loading").onclick()');
        await until(() => retrying.evaluate('!document.querySelector("#start-shift").disabled'), "Retry did not finish loading.");
        assert.equal(await retrying.evaluate("__configCalls"), 2, "Concurrent retry clicks must share initialization.");
        assert.equal(await retrying.evaluate('document.querySelector("#retry-loading").hidden'), true);
        assert.equal(await retrying.evaluate('document.querySelector("#lifecycle-status").hidden'), true);
        assert.equal(await retrying.evaluate("__mo.S.phase"), "welcome");
        assert.equal(await retrying.evaluate("__mo.S.timer"), null);
        await resume(retrying);
        assert.equal(await retrying.evaluate("__mo.S.phase"), "shift");
        await retrying.evaluate("__mo.pause()");
        await host.close(id);
        await retrying.closePage();
    }
    const late = await page(await host.open("late-initialization", { gameId: "late-initialization" }), {
        ready: false,
        before: `
          const originalFetch = window.fetch.bind(window);
          window.__stateCalls = 0;
          window.fetch = async (path, options) => {
            if (path === "/_diner/state") __stateCalls++;
            const response = await originalFetch(path, options);
            if (path === "/_diner/config") await new Promise(resolve => { window.__finishConfig = resolve; });
            return response;
          };
        `,
    });
    await until(() => late.evaluate("typeof __finishConfig === 'function'"), "Delayed configuration was not captured.");
    await late.evaluate('dispatchEvent(new Event("pagehide")); __finishConfig()');
    await wait(100);
    assert.equal(await late.evaluate("__stateCalls"), 0);
    assert.equal(await late.evaluate('document.querySelector("#start-shift").disabled'), true);
    assert.equal(await late.evaluate("__mo.S.timer"), null);
    await host.close("late-initialization");
    await late.closePage();

    const interrupted = await page(await host.open("suspended", { gameId: "suspended" }), {
        before: `
          window.__gap = 0;
          const clock = performance.now.bind(performance);
          Object.defineProperty(performance, "now", { value: () => clock() + window.__gap });
        `,
    });
    await resume(interrupted);
    const beforeGap = await interrupted.evaluate("__mo.snapshot()");
    await interrupted.evaluate("__gap = 9000; __mo.tick()");
    assert.deepEqual(await interrupted.evaluate("__mo.snapshot()"), beforeGap);
    assert.equal(await interrupted.evaluate("__mo.S.timer"), null);
    assert.match(await interrupted.evaluate('document.querySelector("#lifecycle-message").textContent'), /interruption/);
    await until(() => interrupted.evaluate('!document.querySelector("#start-shift").disabled'),
        "Resume must become available when the interruption dialog is visible.");
    await interrupted.evaluate('document.querySelector("#prompt").value = "cookies"; document.querySelector("#send-msg").onclick()');
    assert.deepEqual(await interrupted.evaluate("__mo.snapshot()"), beforeGap);
    await resume(interrupted);
    assert.equal(await interrupted.evaluate("__mo.S.elapsed"), beforeGap.state.elapsed);
    assert.notEqual(await interrupted.evaluate("__mo.S.timer"), null);
    await interrupted.evaluate("__mo.pause()");
    await host.close("suspended");
    await interrupted.closePage();
    }

    let first, second;
    if (!ticketOnly) {
    first = await page(url);
    assert.match(await first.evaluate("navigator.userAgent"), /Edg/);
    assert.deepEqual(await first.evaluate(`(async () => {
      const header = document.querySelector(".navbar-brand .brand-mark");
      const welcome = document.querySelector(".welcome-logo img");
      const cert = document.querySelector(".cert-brand");
      const icon = document.querySelector('link[rel="icon"]');
      await Promise.all([welcome.decode(), cert.decode()]);
      const box = header.getBoundingClientRect();
      return {
        headerLabel: header.getAttribute("aria-label"),
        welcomeAlt: welcome.alt,
        welcomeSrc: welcome.getAttribute("src"),
        welcomeRendered: welcome.naturalWidth > 0,
        certSrc: cert.getAttribute("src"),
        certRendered: cert.naturalWidth > 0,
        ticketPaper: getComputedStyle(document.querySelector(".certificate")).backgroundColor,
        icon: icon.getAttribute("href"),
        markSized: box.width > 40 && box.height > 16,
        markMask: getComputedStyle(header).maskImage.includes("mos-mark.svg"),
        lowercaseBrand: /\\bmo['\\u2019]s/.test(document.body.textContent)
      };
    })()`), {
        headerLabel: "Mo's Diner", welcomeAlt: "Mo's Diner",
        welcomeSrc: "assets/mos-lockup.svg", welcomeRendered: true,
        certSrc: "assets/mos-lockup.svg", certRendered: true, ticketPaper: "rgb(255, 255, 255)",
        icon: "assets/invertocat-pink.svg", markSized: true, markMask: true, lowercaseBrand: false,
    });
    await resume(first);
    for (const width of [1440, 1000, 901]) {
        await first.send("Emulation.setDeviceMetricsOverride", { width, height: 800, deviceScaleFactor: 1, mobile: false });
        await until(() => first.evaluate(`innerWidth === ${width} && !document.documentElement.classList.contains("tabbed")`),
            "Desktop layout did not settle after resizing.");
        assert.equal(await first.evaluate(`(() => {
          const cp = document.querySelector(".cp-head").getBoundingClientRect();
          const kitchen = document.querySelector(".k-head").getBoundingClientRect();
          return cp.height > 0 && cp.top === kitchen.top && cp.bottom === kitchen.bottom;
        })()`), true, `Pane headers must align at ${width}px.`);
    }
    assert.deepEqual(await first.evaluate(`(() => {
      const o = __mo.active(), name = o.name;
      o.name = "@" + "x".repeat(38); __mo.renderAll();
      const cp = document.querySelector(".cp-head").getBoundingClientRect();
      const kitchen = document.querySelector(".k-head").getBoundingClientRect();
      const aligned = cp.bottom === kitchen.bottom;
      const contained = [".cp-head", ".cp-body", ".composer", ".k-head", ".k-body"].every(selector => {
        const el = document.querySelector(selector), rect = el.getBoundingClientRect();
        const pane = el.closest(".pane").getBoundingClientRect();
        return rect.left >= pane.left && rect.right <= pane.right;
      });
      o.name = name; __mo.renderAll();
      return { aligned, contained };
    })()`), { aligned: true, contained: true }, "Long names must preserve aligned, horizontally contained panes.");
    await first.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 800, deviceScaleFactor: 1, mobile: false });
    assert.deepEqual(await first.evaluate(`(() => {
      const row = document.querySelector('.hi-row[data-act="order"]'), id = row.dataset.arg;
      row.focus(); __mo.renderAll();
      const rowPreserved = document.activeElement.dataset.arg === id && document.activeElement.matches(".hi-row");
      const closed = document.querySelector('[data-act="hubtab"][data-arg="closed"]');
      closed.focus(); closed.click(); __mo.renderAll();
      const filterPreserved = document.activeElement.dataset.act === "hubtab" && document.activeElement.dataset.arg === "closed";
      document.querySelector('[data-act="hubtab"][data-arg="open"]').click();
      const o = __mo.S.orders.find(o => String(o.id) === id), original = { ...o };
      document.querySelector('.hi-row[data-arg="' + id + '"]').focus();
      o.status = "served"; __mo.renderAll();
      const removedRowFallback = document.activeElement.dataset.act === "hubtab" && document.activeElement.dataset.arg === "open";
      Object.assign(o, original, { handed: true, dish: o.want.dish, status: "ready" }); __mo.renderAll();
      const action = () => document.querySelector('#kitchen [data-act="serve"][data-arg="' + id + '"]');
      action().focus(); __mo.renderAll();
      const actionPreserved = document.activeElement === action();
      o.status = "deploying"; __mo.renderAll();
      const changedActionFallback = document.activeElement.matches(".k-card-head") && document.activeElement.dataset.arg === id;
      o.status = "served"; __mo.renderAll();
      const removedCardFallback = document.activeElement.matches(".pane.kitchen");
      Object.assign(o, original); __mo.renderAll();
      return { rowPreserved, filterPreserved, removedRowFallback, actionPreserved, changedActionFallback, removedCardFallback };
    })()`), { rowPreserved: true, filterPreserved: true, removedRowFallback: true,
        actionPreserved: true, changedActionFallback: true, removedCardFallback: true });
    await first.send("Emulation.setDeviceMetricsOverride", { width: 800, height: 800, deviceScaleFactor: 1, mobile: false });
    await until(() => first.evaluate('document.documentElement.classList.contains("tabbed")'), "Compact layout did not settle.");
    for (const view of ["line", "cp", "kitchen"]) {
        assert.deepEqual(await first.evaluate(`(() => {
          document.querySelector('#m-tabs [data-arg="${view}"]').click();
          return [...document.querySelectorAll('#m-tabs [aria-current="page"]')].map(button => button.dataset.arg);
        })()`), [view], "Compact navigation must expose exactly one current view.");
    }
    assert.deepEqual(await first.evaluate(`["cp", "kitchen"].map(view =>
      document.querySelector('#m-tabs [data-arg="' + view + '"]').getAttribute("aria-label"))`),
        ["Prep, 1 order needs attention", "Kitchen, 0 orders ready to serve"]);
    await first.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 800, deviceScaleFactor: 1, mobile: false });
    await until(() => first.evaluate('innerWidth === 1440 && !document.documentElement.classList.contains("tabbed")'),
        "Desktop layout did not settle after compact navigation checks.");
    assert.deepEqual(await first.evaluate(`(() => {
      const chip = document.querySelector('[data-act="dish"]');
      chip.focus(); chip.click();
      const afterClick = document.activeElement.dataset.arg === chip.dataset.arg;
      __mo.renderAll();
      return { afterClick, afterRender: document.activeElement.dataset.arg === chip.dataset.arg,
        action: document.activeElement.dataset.act };
    })()`), { afterClick: true, afterRender: true, action: "dish" });
    assert.deepEqual(await first.evaluate(`(() => {
      const o = __mo.active(), wrong = Copilot.MENU.find(d => d.id !== o.want.dish);
      __mo.sendPrompt(o, Copilot.promptText(wrong.id, [])); __mo.renderAll();
      const help = document.querySelector('[data-act="help"]');
      help.focus(); help.click();
      const hint = [...document.querySelectorAll(".cp-hint")].at(-1).textContent;
      return { namesWantedDish: hint.includes(Copilot.dishOf(o.want.dish).name),
        namesWrongDish: hint.includes(wrong.name), editPrompt: hint.includes("Edit prompt"),
        approvesWrongDish: hint.includes("The plan matches"), focused: document.activeElement.dataset.act };
    })()`), { namesWantedDish: true, namesWrongDish: true, editPrompt: true, approvesWrongDish: false, focused: "help" });
    assert.deepEqual(await first.evaluate(`(() => {
      const edit = document.querySelector('[data-act="reprompt"]');
      edit.focus(); edit.click();
      const promptFocused = document.activeElement.id === "prompt";
      const o = __mo.active();
      __mo.sendPrompt(o, Copilot.promptText(o.want.dish, o.want.opts)); __mo.renderAll();
      const expand = document.querySelector('[data-act="expand"]');
      expand.focus(); expand.click();
      const expandedFocus = document.activeElement.dataset.act;
      const choice = document.querySelector('[data-act="pick"][aria-checked="true"]');
      choice.focus(); choice.click();
      const pickedFocus = document.activeElement.dataset.act;
      __mo.help(o); __mo.renderAll();
      return { promptFocused, expandedFocus, pickedFocus,
        correctHint: [...document.querySelectorAll(".cp-hint")].at(-1).textContent.includes("The plan matches") };
    })()`), { promptFocused: true, expandedFocus: "expand", pickedFocus: "pick", correctHint: true });
    for (const arrow of ["ArrowRight", "ArrowLeft", "ArrowUp", "ArrowDown", "Home", "End"]) {
        const before = await first.evaluate(`(() => {
          const radio = document.querySelector('[role="radio"][aria-checked="true"]'); radio.focus();
          return radio.dataset.arg;
        })()`);
        await key(first, arrow);
        assert.deepEqual(await first.evaluate(`(() => {
          const focused = document.activeElement, group = focused.closest('[role="radiogroup"]');
          return { selected: focused.getAttribute("aria-checked"), tabStops: group.querySelectorAll('[tabindex="0"]').length,
            expected: focused.dataset.arg.endsWith(":${arrow === "Home" ? 0 : arrow === "End" ? 1 : before.endsWith(":1") ? 0 : 1}"),
            status: __mo.active().status, prs: __mo.active().prs.length };
        })()`), { selected: "true", tabStops: 1, expected: true, status: "ordering", prs: 0 });
    }
    await key(first, "Tab");
    assert.equal(await first.evaluate('document.activeElement.getAttribute("role") === "radio"'), false,
        "Tab must leave the radio group, rather than stop on its unchecked option.");
    trace("Orders/Kitchen focus, compact semantics and radio keyboard checks passed");
    assert.deepEqual(await first.evaluate(`(() => {
      const o = __mo.active();
      o.status = "failing"; o.failKind = "flaky";
      o.fail = { ...Checks.FAILS.flaky(Copilot.dishOf(o.dish)), kind: "flaky" };
      o.checks = Checks.RUNS.map(check => ({ ...check, state: check.id === o.fail.check ? "fail" : "queued" }));
      o.ci = 0; __mo.renderAll();
      const wrongChoices = o.fail.fixes.filter(fix => !fix.ok).map(fix => {
        const button = document.querySelector('[data-act="fixck"][data-arg="' + fix.id + '"]');
        button.focus(); button.click();
        return document.activeElement === document.querySelector('.ck-fix:not([disabled])');
      });
      const correct = document.querySelector('[data-act="fixck"][data-arg="rerun"]');
      correct.focus(); correct.click();
      return { wrongChoices, status: o.status, focused: document.activeElement.dataset.act };
    })()`), { wrongChoices: [true, true], status: "checks", focused: "help" });
    // Live model controls are disabled; exercise their removal without starting a model.
    assert.deepEqual(await first.evaluate(`(() => ["cancelmodel", "retrymodel"].map(act => {
      const button = document.createElement("button");
      button.dataset.act = act; button.textContent = act;
      document.querySelector("#cp-body").append(button); button.focus();
      __mo.renderAll();
      return document.activeElement.dataset.act;
    }))()`), ["help", "help"]);
    await first.evaluate("__mo.restart();");
    assert.equal(await first.evaluate(`document.querySelector(".cp-head").getBoundingClientRect().bottom ===
      document.querySelector(".k-head").getBoundingClientRect().bottom`), true, "Empty-state headers must align.");
    await resume(first);
    await first.evaluate(`(() => {
      const a = window.__mo, o = a.active();
      a.sendPrompt(o, Copilot.promptText(o.want.dish, o.want.opts)); a.approve(o); a.renderAll();
    })()`);
    await wait(1100);
    const running = await first.evaluate("({ elapsed: __mo.S.elapsed, prs: __mo.S.orders[0].prs.length })");
    assert.ok(running.elapsed >= 1);
    assert.ok(running.prs > 0);
    await first.evaluate('Object.defineProperty(document, "hidden", { configurable: true, value: true }); document.dispatchEvent(new Event("visibilitychange"))');
    const paused = await first.evaluate("__mo.snapshot()");
    await wait(1300);
    assert.deepEqual(await first.evaluate("__mo.snapshot()"), paused);
    await first.evaluate('Object.defineProperty(document, "hidden", { configurable: true, value: false }); document.dispatchEvent(new Event("visibilitychange"))');
    await wait(700);
    assert.deepEqual(await first.evaluate("__mo.snapshot()"), paused);
    await resume(first);
    await first.evaluate(`(() => {
      const a = __mo, cooking = a.S.orders[0];
      cooking.status = "checks"; cooking.checks = Checks.RUNS.map(r => ({ ...r, state: "queued" })); cooking.ci = 0;
      const draft = a.S.orders.find(o => o.status === "line");
      if (draft) { a.select(draft.id); a.help(draft); }
      a.renderAll();
      document.querySelector("#prompt").dispatchEvent(new Event("input", { bubbles: true }));
    })()`);
    await first.evaluate("__mo.pause()");
    try {
        await until(async () => {
            const disk = JSON.parse(await readFile(join(stateDirectory, "browser.json"), "utf8"));
            return disk.owner === null;
        }, "Pause did not persist/release ownership.");
    } catch (error) {
        const lifecycle = await first.evaluate(`({
            visible: !document.querySelector("#lifecycle-status").hidden,
            message: document.querySelector("#lifecycle-message").textContent
        })`);
        throw new Error(`${error.message} Lifecycle: ${JSON.stringify(lifecycle)} Runtime errors: ${JSON.stringify(first.errors)}`);
    }
    await host.close("edge");
    await first.closePage();
    const reopened = await host.open("fresh", { gameId: "browser" });
    second = await page(reopened);
    assert.equal(await second.evaluate("__mo.S.phase"), "welcome");
    assert.equal(await second.evaluate("__mo.S.elapsed"), 0);
    assert.equal(await second.evaluate("__mo.S.orders.length"), 0);
    assert.equal(await second.evaluate("__mo.S.timer"), null);
    await resume(second);
    await wait(1100);
    const infoTime = await second.evaluate("__mo.S.elapsed");
    await second.evaluate('document.querySelector("#info-btn").click()');
    assert.equal(await second.evaluate('document.querySelector("#info-dialog").open'), true);
    assert.equal(await second.evaluate("__mo.S.timer"), null);
    await wait(1200);
    assert.equal(await second.evaluate("__mo.S.elapsed"), infoTime);
    await second.evaluate('document.querySelector("#info-dialog .close").click()');
    await until(() => second.evaluate("__mo.S.timer !== null"), "Closing info did not resume the shift.");
    await wait(1100);
    assert.ok(await second.evaluate("__mo.S.elapsed") > infoTime);
    await second.evaluate(`(() => {
      const a = __mo, o = a.S.orders[0];
      a.sendPrompt(o, Copilot.promptText(o.want.dish, o.want.opts)); a.approve(o);
      o.status = "ready"; o.failFixed = true; a.select(o.id); a.renderAll();
      document.querySelector('[data-act="serve"]').click();
    })()`);
    assert.equal(await second.evaluate("__mo.S.orders[0].status"), "deploying");
    await second.evaluate('document.querySelector("#info-btn").click()');
    const delay = await second.evaluate("__mo.S.orders[0].delay.deploy");
    await wait(1400);
    assert.equal(await second.evaluate("__mo.S.orders[0].delay.deploy"), delay);
    await second.evaluate('document.querySelector("#info-dialog .close").click()');
    await wait(1400);
    assert.equal(await second.evaluate("__mo.S.orders[0].status"), "served");
    assert.equal(await second.evaluate("__mo.S.tips"), 0);
    assert.equal(await second.evaluate("__mo.S.banked"), 0);
    assert.equal(await second.evaluate('document.querySelector("#hud-tips").closest(".chip").hidden'), true);
    assert.doesNotMatch(await second.evaluate("__mo.S.orders[0].log.join(' ')"), /\+\$\d+|tip/);
    await second.evaluate('document.querySelector(\'[data-act="hubtab"][data-arg="closed"]\').click()');
    assert.doesNotMatch(await second.evaluate('document.querySelector(".hi-row.done .hi-meta").textContent'), /\+\$\d+|tip/);
    await second.evaluate("__mo.S.left = 1; __mo.tick()");
    assert.equal(await second.evaluate("__mo.S.phase"), "over");
    assert.equal(await second.evaluate('document.querySelector("#over-dialog").open'), true);
    assert.equal(await second.evaluate('document.querySelector("#over-title").textContent'), "Shift's over!");
    assert.equal(await second.evaluate('document.querySelector("#over-summary").textContent'), "You served 1 of 3 orders before the shift ended.");
    assert.match(await second.evaluate('document.querySelector("#over-dialog .info-body").textContent'), /Nice work keeping the diner moving!/);
    assert.equal(await second.evaluate('document.querySelectorAll("#over-orders li").length'), 1);
    assert.match(await second.evaluate('document.querySelector("#over-orders li").textContent'), /@.+\s+.+ · .+/);
    assert.equal(await second.evaluate('document.querySelector(\'#over-dialog [data-act="restart"]\').textContent'), "Restart");
    assert.equal(await second.evaluate('document.querySelector("#over-close").hidden'), true);
    await until(() => second.evaluate('!document.querySelector("#start-shift").disabled'),
        "Results dialog must become visible before restarting.");
    await second.evaluate('document.querySelector(\'#over-dialog [data-act="restart"]\').click()');
    await until(() => second.evaluate('__mo.S.phase === "welcome"'), "Restart from results did not return to welcome.");
    assert.equal(await second.evaluate("__mo.S.elapsed"), 0);
    assert.equal(await second.evaluate("__mo.S.banked"), 0);
    assert.equal(await second.evaluate("__mo.S.orders.length"), 0);
    assert.equal(await second.evaluate('document.querySelector("#info-dialog").open'), true);
    await resume(second);
    await second.evaluate("__mo.fleetAll()");
    assert.equal(await second.evaluate("__mo.S.phase"), "won");
    assert.equal(await second.evaluate("__mo.S.served"), 3);
    assert.equal(await second.evaluate('document.querySelector("#hud-served").textContent'), "3/3");
    await second.evaluate(`(() => {
      const a = __mo, o = { ...a.S.orders[0], status: "ready" };
      a.serve(o);
    })()`);
    assert.equal(await second.evaluate("__mo.S.served"), 3);
    assert.equal(await second.evaluate('document.querySelector("#cert").open'), false,
        "The summary must be read before opening the best-times ticket.");
    assert.equal(await second.evaluate('document.querySelector("#over-dialog").open'), true);
    assert.equal(await second.evaluate('document.activeElement.id'), "over-title");
    assert.equal(await second.evaluate('document.querySelector("#over-title").textContent'), "Shift complete!");
    assert.equal(await second.evaluate('document.querySelectorAll("#over-orders li").length'), 3);
    assert.equal(await second.evaluate('document.querySelector("#over-restart").hidden'), true);
    assert.equal(await second.evaluate('document.querySelector("#over-close").hidden'), false);
    await second.evaluate('document.querySelector("#over-close").click()');
    assert.equal(await second.evaluate('document.querySelector("#over-dialog").open'), false);
    assert.match(await second.evaluate('document.querySelector("#cert-body").textContent'), /Your shift: \d+:\d{2} · 3\/3 served/);
    assert.doesNotMatch(await second.evaluate('document.querySelector("#cert").textContent'), /mug|redeem|gift certificate|booth/i);
    assert.equal(await second.evaluate(`(async () => {
      await document.fonts.load('400 25px "Kalam"');
      return document.fonts.check('400 25px "Kalam"') &&
        performance.getEntriesByType("resource").some(r => r.name.includes("/fonts/kalam-latin.woff2"));
    })()`), true, "The handwritten font must load locally with external requests blocked.");
    assert.deepEqual(await second.evaluate(`(() => {
      const dialog = document.querySelector("#cert");
      const initialFocus = document.activeElement.id;
      document.querySelector("#reset-btn").focus();
      return { nativeModal: dialog.matches("dialog:modal"), visible: dialog.classList.contains("show"),
        initialFocus, backgroundBlocked: dialog.contains(document.activeElement) };
    })()`), { nativeModal: true, visible: true, initialFocus: "cert-title", backgroundBlocked: true });
    for (const modifiers of [0, 0, 8, 8]) {
        await key(second, "Tab", modifiers);
        assert.equal(await second.evaluate('document.querySelector("#cert").contains(document.activeElement)'), true,
            "Tab and Shift+Tab must stay within the best-times ticket.");
    }
    await key(second, "Escape");
    assert.equal(await second.evaluate('document.querySelector("#cert").open'), true);
    assert.equal(await second.evaluate(`(() => {
      const luminance = color => {
        const rgb = color.match(/[\\d.]+/g).slice(0, 3).map(Number).map(value => value / 255)
          .map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
        return rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722;
      };
      const contrast = (foreground, background) => {
        const a = luminance(foreground), b = luminance(background);
        return (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
      };
      const paper = getComputedStyle(document.querySelector(".certificate")).backgroundColor;
      const selectors = [".cert-title", ".cert-subtitle", ".ticket-meta", ".ticket-chef", ".ticket-time",
        ".ticket-best", ".ticket-empty", ".cert-body", ".cert-small", ".cert-actions .btn"];
      return selectors.every(selector => {
        const element = document.querySelector(selector), style = getComputedStyle(element);
        const background = style.backgroundColor !== "rgba(0, 0, 0, 0)" ? style.backgroundColor
          : element.closest("tr.current") ? getComputedStyle(element.closest("tr")).backgroundColor : paper;
        return contrast(style.color, background) >= 4.5;
      });
    })()`), true, "Ticket text and replay must meet normal-text contrast.");
    await second.evaluate(`(() => {
      document.querySelector(".ticket-chef").textContent = "ExtraordinarilyLongChefUsername";
    })()`);
    await second.send("Emulation.setDeviceMetricsOverride", { width: 320, height: 320, deviceScaleFactor: 1, mobile: true });
    const certificateBounds = await second.evaluate(`(async () => {
      window.dispatchEvent(new Event("resize"));
      const dialog = document.querySelector("#cert"), inner = dialog.querySelector(".cert-inner");
      await document.fonts.ready;
      await Promise.all(dialog.getAnimations({ subtree: true }).map(animation => animation.finished));
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const rect = inner.getBoundingClientRect(), button = inner.querySelector("button");
      button.focus(); button.scrollIntoView({ block: "end", behavior: "instant" });
      const replay = button.getBoundingClientRect();
      return { left: rect.left, right: rect.right, width: innerWidth, transform: getComputedStyle(inner).transform,
        overflow: dialog.scrollWidth > dialog.clientWidth,
        replayVisible: replay.top >= 0 && replay.bottom <= innerHeight,
        replayHeight: replay.height, copySize: parseFloat(getComputedStyle(document.querySelector(".cert-small")).fontSize) };
    })()`);
    assert.ok(certificateBounds.left >= 0 && certificateBounds.right <= certificateBounds.width &&
      certificateBounds.transform === "none" && !certificateBounds.overflow && certificateBounds.replayVisible &&
      certificateBounds.replayHeight >= 44 && certificateBounds.copySize >= 14,
      `ticket should reflow and scroll without shrinking at 320x320: ${JSON.stringify(certificateBounds)}`);
    await second.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await second.evaluate('window.dispatchEvent(new Event("resize"))');
    assert.equal(await second.evaluate('document.querySelector("#cert").classList.contains("show")'), true);
    await until(() => second.evaluate('!document.querySelector("#start-shift").disabled'),
        "Ticket visibility must settle before replay.");
    await second.evaluate('document.querySelector(\'#cert [data-act="restart"]\').click()');
    await until(() => second.evaluate('__mo.S.phase === "welcome"'), "Ticket replay did not return to welcome.");
    assert.deepEqual(await second.evaluate(`({ certificate: document.querySelector("#cert").open,
      summary: document.querySelector("#over-dialog").open, welcome: document.querySelector("#info-dialog").open,
      focus: document.activeElement.id, timer: __mo.S.timer, orders: __mo.S.orders.length })`),
        { certificate: false, summary: false, welcome: true, focus: "chef-name", timer: null, orders: 0 });
    trace("ticket modal, contrast, reflow and replay checks passed");
    await resume(second);
    await second.evaluate(`(() => {
      const a = __mo;
      a.S.elapsed = 5; a.tick();
      a.S.orders.forEach((o, i) => {
        a.sendPrompt(o, Copilot.promptText(o.want.dish, o.want.opts));
        o.status = "ready";
        if (i < 2) a.serve(o);
        else { o.status = "deploying"; o.delay = { deploy: 100 }; }
      });
    })()`);
    await until(() => second.evaluate('__mo.S.phase === "won"'), "Concurrent deployments did not finish the shift.");
    assert.equal(await second.evaluate("__mo.S.served"), 3);
    assert.equal(await second.evaluate('__mo.S.orders.filter(o => o.status === "deploying").length'),
        await second.evaluate("__mo.S.orders.length - __mo.S.served"));
    assert.equal(await second.evaluate('document.querySelector("#hud-served").textContent'), "3/3");
    assert.equal(await second.evaluate('document.querySelectorAll("#over-orders li").length'), 3);
    await host.close("fresh");
    await second.closePage();
    }

    const scoresURL = await host.open("scores", { gameId: "scores", skin: "cozy" });
    const scores = await page(scoresURL);
    const readScores = () => scores.evaluate(`Array.from(document.querySelectorAll("#best-times tr"), row => ({
      chef: row.querySelector(".ticket-chef").textContent,
      time: row.querySelector(".ticket-clock")?.textContent ?? null,
      current: row.getAttribute("aria-current") === "true",
      best: !!row.querySelector(".ticket-best")
    }))`);
    async function scoreShift(chef, elapsed) {
        if (await scores.evaluate('__mo.S.phase !== "welcome"')) {
            await scores.evaluate("__mo.restart()");
            await scores.evaluate(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
            await wait(200);
        }
        await scores.evaluate(`document.querySelector("#chef-name").value = ${JSON.stringify(chef)}`);
        await resume(scores);
        await scores.evaluate(`__mo.S.elapsed = ${elapsed}; __mo.fleetAll(); document.querySelector("#over-close").click()`);
        return readScores();
    }
    assert.deepEqual(await scoreShift("Sunny", 42), [
        { chef: "Sunny", time: "0:42", current: true, best: true },
        { chef: "Your next shift", time: null, current: false, best: false },
        { chef: "Your next shift", time: null, current: false, best: false },
    ]);
    await scores.evaluate('document.querySelector("#cert").close(); document.querySelector("#over-close").click()');
    assert.equal((await readScores()).filter(row => row.time !== null).length, 1,
        "Reopening the same winning ticket must not record it twice.");
    await scoreShift("Mo", 51);
    await scoreShift("Pip", 63);
    assert.equal(await scores.evaluate(`(async () => {
      await document.fonts.ready;
      return document.fonts.check('400 25px "Kalam"') &&
        document.querySelector(".cert-brand").getAttribute("src") === "assets/mos-lockup.svg";
    })()`), true, "Use the real logo and the local handwriting font.");
    assert.deepEqual(await scores.evaluate(`(() => {
      const ticket = document.querySelector("#cert"), welcome = document.querySelector("#info-dialog");
      const replay = getComputedStyle(ticket.querySelector("button")), start = getComputedStyle(document.querySelector("#start-shift"));
      const properties = ["backgroundColor", "color", "borderRadius", "borderWidth", "boxShadow", "fontFamily", "fontSize", "fontWeight", "padding"];
      return {
        transparent: getComputedStyle(ticket).backgroundColor === "rgba(0, 0, 0, 0)",
        backdrop: getComputedStyle(ticket, "::backdrop").backgroundColor === getComputedStyle(welcome, "::backdrop").backgroundColor,
        surface: getComputedStyle(document.querySelector(".certificate")).backgroundColor === getComputedStyle(welcome).backgroundColor,
        button: properties.every(property => replay[property] === start[property])
      };
    })()`), { transparent: true, backdrop: true, surface: true, button: true },
    "Ticket must share the opening splash backdrop, surface and button styles.");
    if (process.env.DINER_TICKET_SCREENSHOT) {
        await scores.send("Emulation.setDeviceMetricsOverride", { width: 900, height: 900, deviceScaleFactor: 1, mobile: false });
        await scores.evaluate(`Promise.all(document.querySelector("#cert").getAnimations({ subtree: true }).map(a => a.finished))`);
        const screenshot = await scores.send("Page.captureScreenshot", { format: "png" });
        await writeFile(process.env.DINER_TICKET_SCREENSHOT, Buffer.from(screenshot.data, "base64"));
    }
    assert.deepEqual((await scoreShift("Tie", 42)).map(row => [row.chef, row.time]), [
        ["Sunny", "0:42"], ["Tie", "0:42"], ["Mo", "0:51"],
    ], "Keep only three times, with earlier completions first on ties.");
    assert.equal(await scores.evaluate('!!document.querySelector(".ticket-best")'), false,
        "A tied time is not a new best.");
    const markupName = '<img src=x onerror="alert(1)">';
    assert.deepEqual((await scoreShift(markupName, 38))[0],
        { chef: markupName, time: "0:38", current: true, best: true });
    assert.equal(await scores.evaluate('document.querySelectorAll("#best-times img").length'), 0,
        "Chef names must stay plain text.");
    const topThree = await readScores();
    assert.deepEqual((await scoreShift("Slow", 74)).map(row => [row.chef, row.time]),
        topThree.map(row => [row.chef, row.time]), "A slower fourth score must not displace a best time.");
    assert.equal(await scores.evaluate('!!document.querySelector("#best-times .current")'), false);
    assert.equal(await scores.evaluate('document.querySelector("#cert-body").textContent'), "Your shift: 1:14 · 3/3 served");
    await scores.send("Emulation.setDeviceMetricsOverride", { width: 320, height: 320, deviceScaleFactor: 1, mobile: true });
    const narrowTicket = await scores.evaluate(`(async () => {
      await document.fonts.ready;
      await Promise.all(document.querySelector("#cert").getAnimations({ subtree: true }).map(a => a.finished));
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const dialog = document.querySelector("#cert"), button = dialog.querySelector("button");
      button.focus(); button.scrollIntoView({ block: "end", behavior: "instant" });
      const rect = button.getBoundingClientRect();
      return { scrollWidth: dialog.scrollWidth, clientWidth: dialog.clientWidth,
        top: rect.top, bottom: rect.bottom, height: rect.height, viewport: innerHeight };
    })()`);
    assert.ok(narrowTicket.scrollWidth <= narrowTicket.clientWidth && narrowTicket.top >= 0 &&
        narrowTicket.bottom <= narrowTicket.viewport && narrowTicket.height >= 44,
        `Long names must wrap and replay must remain reachable: ${JSON.stringify(narrowTicket)}`);
    await key(scores, "Tab");
    assert.equal(await scores.evaluate('document.querySelector("#cert").contains(document.activeElement)'), true);
    await key(scores, "Escape");
    assert.equal(await scores.evaluate('document.querySelector("#cert").matches(":modal")'), true);
    await scores.send("Emulation.setDeviceMetricsOverride", { width: 900, height: 900, deviceScaleFactor: 1, mobile: false });
    await scores.evaluate("__mo.restart()");
    await resume(scores);
    await scores.evaluate('__mo.S.elapsed = 3; __mo.S.left = 1; __mo.tick()');
    assert.equal(await scores.evaluate("__mo.S.phase"), "over");
    assert.deepEqual((await scoreShift("After timeout", 60)).map(row => [row.chef, row.time]),
        topThree.map(row => [row.chef, row.time]), "Incomplete shifts must not enter the board.");
    await scores.send("Page.reload");
    await until(() => scores.evaluate('!!window.__mo && __mo.S.phase === "welcome" && !document.querySelector("#start-shift").disabled'),
        "The refreshed canvas did not initialize.");
    assert.deepEqual((await scoreShift("Fresh", 50)).map(row => [row.chef, row.time]), [
        ["Fresh", "0:50"], ["Your next shift", null], ["Your next shift", null],
    ], "Refreshing starts a new session board.");
    const independent = await page(await host.open("independent", { gameId: "independent" }));
    await resume(independent);
    await independent.evaluate('__mo.S.elapsed = 55; __mo.fleetAll(); document.querySelector("#over-close").click()');
    assert.equal(await independent.evaluate('document.querySelectorAll("#best-times .ticket-clock").length'), 1,
        "Separate canvases must not share best times.");
    assert.equal(scores.errors.length + independent.errors.length, 0);
    await host.close("independent");
    await independent.closePage();
    await host.close("scores");
    await scores.closePage();
    trace("session best times: ranking, ties, replay, timeout, escaping and isolation passed");
    if (ticketOnly) {
        const direct = await page(pathToFileURL(join(root, "index.html")).href);
        await resume(direct);
        await direct.evaluate('__mo.S.elapsed = 45; __mo.fleetAll(); document.querySelector("#over-close").click()');
        assert.equal(await direct.evaluate('document.querySelector(".ticket-clock").textContent'), "0:45");
        assert.doesNotMatch(await direct.evaluate('document.querySelector("#cert").textContent'), /mug|redeem|gift certificate|booth/i);
        assert.equal(direct.errors.length, 0);
        await direct.closePage();
        return;
    }

    let wrapper, classic;
    if (!accessibilityOnly) {
    // A canvas hidden with CSS has no Page Visibility event; intersection must pause it.
    const frameURL = await host.open("frame", { gameId: "frame" });
    const wrapperTarget = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" })).json();
    wrapper = await connect(wrapperTarget.webSocketDebuggerUrl);
    connections.push(wrapper);
    await wrapper.evaluate(`document.body.innerHTML = '<iframe style="width:1100px;height:700px" src="${frameURL}"></iframe>'`);
    const frameContext = await until(() => wrapper.contexts.find(context => context.origin === new URL(frameURL).origin),
        "Edge did not expose the canvas iframe context.");
    const frame = { evaluate: expression => wrapper.evaluate(expression, frameContext.id) };
    await until(() => frame.evaluate('!!window.__mo && !document.querySelector("#start-shift").disabled'), "Frame did not load.")
        .catch(async error => { throw new Error(`${error.message} ${JSON.stringify(await frame.evaluate('({ text: document.body.innerText, secure: isSecureContext, crypto: typeof crypto.randomUUID })'))} ${JSON.stringify(wrapper.errors)}`); });
    await frame.evaluate('document.querySelector("#start-shift").click()');
    await wait(1100);
    await until(() => frame.evaluate("__mo.S.elapsed >= 1"), "Embedded start button did not advance the clock.", 30)
        .catch(async error => { throw new Error(`${error.message} ${JSON.stringify(await frame.evaluate('({ phase: __mo.S.phase, timer: __mo.S.timer, hidden: document.hidden, disabled: document.querySelector("#start-shift").disabled, message: document.querySelector("#lifecycle-message").textContent, dialog: document.querySelector("#info-dialog").open })'))}`); });
    await frame.evaluate('document.querySelector("#info-btn").click()');
    await wait(300);
    assert.equal(await frame.evaluate("__mo.S.timer"), null);
    await frame.evaluate('document.querySelector("#start-shift").click()');
    await until(() => frame.evaluate('__mo.S.timer !== null && !document.querySelector("#info-dialog").open'),
        "Visible embedded canvas did not resume from the welcome dialog button.");
    await wrapper.evaluate('document.querySelector("iframe").style.display = "none"');
    await until(() => frame.evaluate("__mo.S.timer === null"), "CSS-hidden canvas did not pause.");
    const frameTime = await frame.evaluate("__mo.S.elapsed");
    await wait(1200);
    assert.equal(await frame.evaluate("__mo.S.elapsed"), frameTime);
    await wrapper.evaluate('document.querySelector("iframe").style.display = "block"');
    await wait(1100);
    assert.equal(await frame.evaluate("__mo.S.elapsed"), frameTime);
    await frame.evaluate('document.querySelector("#start-shift").click()');
    await until(() => frame.evaluate('__mo.S.timer !== null && !document.querySelector("#info-dialog").open'),
        "Visible embedded canvas did not resume after being hidden.");
    await host.close("frame");
    await browser.send("Target.closeTarget", { targetId: wrapperTarget.id });

    const classicURL = await host.open("classic", { gameId: "classic-browser", view: "classic" });
    classic = await page(classicURL);
    await resume(classic);
    await classic.evaluate(`(() => {
      const a = __mo, o = a.active();
      a.sendPrompt(o, Copilot.promptText(o.want.dish, o.want.opts));
      o.status = "ready"; a.serve(o); a.renderAll();
    })()`);
    await classic.evaluate("__mo.pause()");
    const classicPaused = await classic.evaluate("__mo.snapshot()");
    await wait(1500);
    assert.deepEqual(await classic.evaluate("__mo.snapshot()"), classicPaused);
    await resume(classic);
    await wait(1500);
    assert.equal(await classic.evaluate("__mo.S.banked"), 0);
    assert.equal(await classic.evaluate('document.querySelector("#hud-tips").closest(".chip").hidden'), true);
    assert.equal(await classic.evaluate('document.querySelector(".cash")'), null);
    await classic.evaluate(`(() => {
      const a = __mo, o = a.S.orders.find(o => o.status !== "served");
      a.select(o.id); a.sendPrompt(o, Copilot.promptText(o.want.dish, o.want.opts));
      o.status = "ready"; a.serve(o); a.restart();
    })()`);
    await wait(4500);
    assert.equal(await classic.evaluate("__mo.S.banked"), 0);
    assert.equal(await classic.evaluate("__mo.S.orders.length"), 0);
    await host.close("classic");
    await classic.closePage();
    }

    for (const skin of ["default", "cozy"]) {
        for (const view of ["hub", "classic"]) {
            const menuURL = pathToFileURL(join(root, "index.html"));
            if (skin === "cozy") menuURL.searchParams.set("skin", skin);
            if (view === "classic") menuURL.searchParams.set("fun", "");
            const menuPage = await page(menuURL.href, { before: `
              const originalTimeout = window.setTimeout.bind(window);
              window.setTimeout = (fn, delay, ...args) => originalTimeout(fn, delay === 450 ? 1 : delay, ...args);
            ` });
            const dishes = await menuPage.evaluate("Copilot.MENU.map(d => ({ id: d.id, emoji: d.emoji, art: d.art, sauces: d.sauces }))");
            for (const dish of dishes) {
                const details = await menuPage.evaluate(`(async () => {
                  __mo.restart(); await __mo.resume();
                  const d = Copilot.dishOf(${JSON.stringify(dish.id)}), o = __mo.active();
                  o.want = { dish: d.id, opts: d.opts.map(option => option.id) }; o.failKind = null;
                  document.querySelector('[data-act="dish"][data-arg="' + d.id + '"]').click();
                  const categories = [...document.querySelectorAll(".chips-card h3")].map(h => h.textContent);
                  for (const option of d.opts) {
                    document.querySelector('[data-act="opt"][data-arg="' + option.id + '"]').click();
                  }
                  document.querySelector("#send-msg").click();
                  const selected = [...o.set], expected = d.opts.map(option => option.id);
                  document.querySelector('[data-act="approve"]').click();
                  return { categories, selected, expected, steps: o.pending.length };
                })()`);
                assert.deepEqual(details.categories, ["All Day Breakfast", "Details"]);
                assert.equal(details.expected.length, 3);
                assert.deepEqual(details.selected, details.expected, `${skin}/${view}/${dish.id}: chips must round-trip`);
                assert.equal(details.steps, 4);
                await until(() => menuPage.evaluate('__mo.active().status === "ready"'), `${dish.id} did not finish cooking.`);
                assert.equal(await menuPage.evaluate('__mo.active().prs.length'), details.steps);
                if (!dish.art) {
                    assert.equal(await menuPage.evaluate('document.querySelector(".kp-emoji:last-child").textContent'), dish.emoji);
                }
                await menuPage.evaluate("__mo.serve(__mo.active()); __mo.renderAll()");
                assert.equal(await menuPage.evaluate("__mo.S.served"), 1);
                assert.equal(await menuPage.evaluate("__mo.S.orders[0].returns"), 0);
                if (view === "classic" && !dish.art) {
                    assert.equal(await menuPage.evaluate('document.querySelector(".seat.eating .dish-food").textContent'), dish.emoji);
                }
            }
            await menuPage.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "no-preference" }] });
            assert.deepEqual(await menuPage.evaluate(`(async () => {
              __mo.restart(); await __mo.resume();
              const button = () => document.querySelector('[data-act="help"]');
              const animation = () => getComputedStyle(button().querySelector(".help-sparkle")).animationName;
              __mo.S.left = 16; __mo.renderAll();
              const before = animation(), width = button().getBoundingClientRect().width;
              __mo.tick();
              const boundary = { left: __mo.S.left, animation: animation() };
              __mo.renderAll();
              const rerender = animation(), stableWidth = button().getBoundingClientRect().width === width;
              __mo.pause();
              const paused = animation();
              await __mo.resume();
              const resumed = animation();
              __mo.S.left = 20; __mo.renderAll();
              const extended = animation();
              __mo.S.left = 1; __mo.renderAll();
              const finalSecond = animation();
              __mo.tick();
              const ended = animation();
              __mo.restart();
              return { before, boundary, rerender, stableWidth, paused, resumed, extended, finalSecond, ended,
                reset: document.querySelector(".shell").classList.contains("help-urgent") };
            })()`), { before: "none", boundary: { left: 15, animation: "help-twinkle" },
                rerender: "help-twinkle", stableWidth: true, paused: "none", resumed: "help-twinkle",
                extended: "none", finalSecond: "help-twinkle", ended: "none", reset: false });
            await menuPage.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
            assert.deepEqual(await menuPage.evaluate(`(async () => {
              await __mo.resume(); __mo.S.left = 15; __mo.renderAll();
              const button = document.querySelector('[data-act="help"]');
              return [getComputedStyle(button.querySelector(".help-sparkle")).animationName,
                getComputedStyle(button, "::before").animationName, getComputedStyle(button, "::after").animationName];
            })()`), ["none", "none", "none"]);
            await menuPage.send("Emulation.setDeviceMetricsOverride", { width: 600, height: 800, deviceScaleFactor: 1, mobile: false });
            await until(() => menuPage.evaluate('innerWidth === 600 && document.documentElement.classList.contains("tabbed")'),
                "Compact layout did not settle before scrolling and focus checks.");
            await key(menuPage, "Tab");
            assert.deepEqual(await menuPage.evaluate(`(async () => {
              const o = __mo.active();
              __mo.sendPrompt(o, Copilot.promptText(o.want.dish, o.want.opts));
              Object.assign(o, { handed: true, status: "cooking", pending: Copilot.cookingPlan(o.dish, o.set, {}), prs: [] });
              __mo.renderAll();
              const spinner = getComputedStyle(document.querySelector(".bstep.now .pr-st")).animationName;
              o.pending = []; o.status = "checks";
              o.checks = Checks.RUNS.map((check, i) => ({ ...check, state: i ? "queued" : "running" }));
              __mo.renderAll();
              const checkBlink = getComputedStyle(document.querySelector(".ck.running .ck-ic")).animationName;
              o.status = "returned"; o.flag = [Copilot.dishOf(o.dish).opts[0].id]; __mo.renderAll();
              const scrolls = [], original = Element.prototype.scrollIntoView;
              try {
                Element.prototype.scrollIntoView = function(options) { scrolls.push(options.behavior); };
                document.querySelector('#kitchen [data-act="goto"]').click();
                await new Promise(resolve => requestAnimationFrame(resolve));
                o.set = [...o.want.opts]; o.status = "ready"; __mo.renderAll();
                document.querySelector('#kitchen [data-act="serve"]').click();
              } finally { Element.prototype.scrollIntoView = original; }
              __mo.restart(); await __mo.resume();
              document.querySelector('#m-tabs [data-arg="cp"]').click();
              const prompt = document.querySelector("#prompt"); prompt.focus();
              const style = getComputedStyle(prompt), rect = prompt.getBoundingClientRect();
              const card = prompt.closest(".compose-box").getBoundingClientRect();
              const outline = parseFloat(style.outlineWidth) + parseFloat(style.outlineOffset);
              return { spinner, checkBlink, scrolls, visibleFocus: style.outlineStyle !== "none" && outline >= 2,
                focusContained: rect.left - outline >= card.left && rect.right + outline <= card.right &&
                  rect.top - outline >= card.top && rect.bottom + outline <= card.bottom };
            })()`), { spinner: "none", checkBlink: "none", scrolls: view === "classic" ? ["instant", "instant"] : ["instant"],
                visibleFocus: true, focusContained: true }, `${skin}/${view}: reduced motion and keyboard prompt focus`);
            trace(`${skin}/${view}: reduced-motion descendants, scrolling and prompt focus passed`);
            await menuPage.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
            await until(() => menuPage.evaluate('innerWidth === 1440 && !document.documentElement.classList.contains("tabbed")'),
                "Desktop layout did not settle after scrolling and focus checks.");
            await menuPage.send("Emulation.setEmulatedMedia", { features: [] });
            for (const remove of [false, true]) {
                await menuPage.evaluate(`(async () => {
                  __mo.restart(); await __mo.resume();
                  const o = __mo.active(), d = Copilot.MENU[0], option = d.opts[0];
                  o.want = { dish: d.id, opts: ${remove} ? [] : [option.id] }; o.failKind = null;
                  __mo.sendPrompt(o, Copilot.promptText(d.id, ${remove} ? [option.id] : []));
                  __mo.approve(o); __mo.renderAll();
                })()`);
                await until(() => menuPage.evaluate('__mo.active().status === "ready"'), "Wrong breakfast order did not cook.");
                assert.equal(await menuPage.evaluate("__mo.active().prs.length"), 4);
                assert.deepEqual(await menuPage.evaluate(`(() => {
                  const o = __mo.active(), option = Copilot.dishOf(o.dish).opts[0];
                  __mo.serve(o);
                  const status = o.status, flagged = o.flag;
                  __mo.toggle(o, option.id); __mo.approve(o); __mo.renderAll();
                  return { status, flagged, expected: [option.id], pending: o.pending.length };
                })()`), { status: "returned", flagged: ["berry-good-review"], expected: ["berry-good-review"], pending: 1 });
                await until(() => menuPage.evaluate('__mo.active().status === "ready"'), "Breakfast correction did not finish.");
                await menuPage.evaluate("__mo.serve(__mo.active()); __mo.renderAll()");
                assert.equal(await menuPage.evaluate("__mo.S.served"), 1);
            }
            await until(() => menuPage.evaluate('Array.from(document.images).every(img => !img.getAttribute("src") || (img.complete && img.naturalWidth > 0))'),
                "Menu visuals must not request missing dish or plating assets.");
            assert.deepEqual(menuPage.errors, []);
            await menuPage.evaluate("__mo.pause()");
            await menuPage.closePage();
        }
    }
    if (accessibilityOnly) {
        assert.equal(connections.reduce((count, connection) => count + connection.errors.length, 0), 0);
        trace("all accessibility checks passed");
        return;
    }

    const standalone = await page(pathToFileURL(join(root, "index.html")).href);
    await standalone.evaluate('document.querySelector("#info-dialog").close()');
    await wait(1100);
    assert.equal(await standalone.evaluate("__mo.S.phase"), "shift");
    assert.ok(await standalone.evaluate("__mo.S.elapsed >= 1"));
    await standalone.evaluate("__mo.pause()");
    assert.equal(await standalone.evaluate('document.querySelector(\'[data-act="inputmode"]\')'), null);
    await standalone.evaluate(`(() => {
      const o = __mo.active(); __mo.sendPrompt(o, Copilot.promptText(o.want.dish, o.want.opts));
      __mo.approve(o);
    })()`);
    assert.equal(await standalone.evaluate("__mo.active().status"), "cooking");

    const deterministicURL = await host.open("deterministic-only", { gameId: "deterministic-only", inputMode: "deterministic" });
    const deterministic = await page(deterministicURL);
    await resume(deterministic);
    assert.equal(await deterministic.evaluate('document.querySelector(\'[data-act="inputmode"]\')'), null);
    await deterministic.evaluate('__mo.sendPrompt(__mo.active(), Copilot.promptText(__mo.active().want.dish, __mo.active().want.opts))');
    assert.equal(await deterministic.evaluate("__mo.active().dish === __mo.active().want.dish"), true);
    assert.equal(modelCalls, 0);
    await deterministic.evaluate("__mo.pause()");
    await host.close("deterministic-only");

    // Retain the end-to-end live-input checks while the feature is temporarily disabled.
    const LIVE_INPUT_ENABLED = false;
    if (LIVE_INPUT_ENABLED) {
    runtimeAvailable = false;
    const missingURL = await host.open("missing-runtime", { gameId: "missing-runtime", inputMode: "copilot" });
    const missingRuntime = await page(missingURL);
    await resume(missingRuntime);
    assert.equal(await missingRuntime.evaluate('document.querySelector(\'[data-arg="copilot"]\').disabled'), true);
    assert.match(await missingRuntime.evaluate('document.querySelector("#cp-body").innerText'), /No executable Copilot CLI/);
    await missingRuntime.evaluate('__mo.sendPrompt(__mo.active(), Copilot.promptText(__mo.active().want.dish, __mo.active().want.opts))');
    assert.equal(await missingRuntime.evaluate("__mo.active().dish === __mo.active().want.dish"), true);
    assert.equal(modelCalls, 0);
    await missingRuntime.evaluate("__mo.pause()");
    await host.close("missing-runtime");
    runtimeAvailable = true;
    const liveURL = await host.open("live", { gameId: "live-browser", inputMode: "copilot" });
    const live = await page(liveURL);
    await resume(live);
    assert.match(await live.evaluate('document.querySelector("#cp-body").innerText'), /sign-in, network and model access unverified/);
    await live.evaluate(`(() => {
      const o = __mo.active(); o.want = { dish: "stacked-pr-pancakes", opts: ["async-syrup"] }; o.speech = "Stacked PR Pancakes, async syrup.";
    })()`);
    modelBehavior = "wait";
    let previousCalls = modelCalls;
    await live.evaluate('void __mo.sendPrompt(__mo.active(), "Stacked PR Pancakes")');
    await until(() => modelCalls > previousCalls, "Live request did not reach the provider.");
    assert.equal(await live.evaluate('document.querySelector("#send-msg").disabled'), true);
    assert.match(await live.evaluate('document.querySelector("#cp-body").innerText'), /Copilot is proposing/);
    await live.evaluate("__mo.approve(__mo.active())");
    assert.equal(await live.evaluate("__mo.active().status"), "ordering");
    assert.equal(await live.evaluate("__mo.active().dish"), null);
    await live.evaluate('document.querySelector(\'[data-act="cancelmodel"]\').click()');
    await until(() => modelAborted, "Cancellation did not abort the provider.");
    assert.equal(await live.evaluate('document.querySelector("#send-msg").disabled'), false);
    assert.match(await live.evaluate('document.querySelector("#cp-body").innerText'), /cancelled/);

    modelBehavior = "fail";
    await live.evaluate('document.querySelector(\'[data-act="retrymodel"]\').click()');
    await until(() => live.evaluate('document.querySelector("#cp-body").innerText.includes("could not propose")'), "Model failure was not shown.");
    assert.equal(await live.evaluate("__mo.active().dish"), null);
    modelBehavior = "invalid";
    await live.evaluate('void __mo.sendPrompt(__mo.active(), "Stacked PR Pancakes")');
    await until(() => live.evaluate('!document.querySelector("#send-msg").disabled'), "Invalid reply did not unblock retry.");
    assert.equal(await live.evaluate("__mo.active().dish"), null);

    modelBehavior = "wait"; modelAborted = false;
    previousCalls = modelCalls;
    await live.evaluate('void __mo.sendPrompt(__mo.active(), "Stacked PR Pancakes")');
    await until(() => modelCalls > previousCalls, "Second request did not reach the provider.");
    await live.evaluate("__mo.pause()");
    await until(() => modelAborted, "Pausing did not abort the model.");
    const livePaused = await live.evaluate("__mo.snapshot()");
    await wait(200);
    assert.deepEqual(await live.evaluate("__mo.snapshot()"), livePaused);
    assert.equal(livePaused.state.orders[0].dish, null);
    assert.equal(livePaused.state.orders[0].text, "Stacked PR Pancakes");
    assert.equal(JSON.stringify(livePaused).includes("requestId"), false);
    await resume(live);
    assert.match(await live.evaluate('document.querySelector("#cp-body").innerText'), /interrupted by pause/);

    modelBehavior = "wait"; modelAborted = false;
    previousCalls = modelCalls;
    await live.evaluate('void __mo.sendPrompt(__mo.active(), "Stacked PR Pancakes")');
    await until(() => modelCalls > previousCalls, "Editable request did not reach the provider.");
    await live.evaluate(`(() => {
      const prompt = document.querySelector("#prompt"); prompt.value = "A sandbox deli sandwich";
      prompt.dispatchEvent(new Event("input", { bubbles: true }));
    })()`);
    await until(() => modelAborted, "Editing did not abort the previous prompt revision.");
    assert.equal(await live.evaluate("__mo.active().text"), "A sandbox deli sandwich");
    assert.equal(await live.evaluate("__mo.active().dish"), null);
    assert.equal(await live.evaluate('document.querySelector("#send-msg").disabled'), false);

    modelBehavior = "ok";
    await live.evaluate('__mo.sendPrompt(__mo.active(), "Stacked PR Pancakes")');
    assert.equal(await live.evaluate("__mo.active().dish"), "stacked-pr-pancakes");
    assert.equal(await live.evaluate("__mo.active().status"), "ordering");
    assert.equal(await live.evaluate("__mo.active().prs.length"), 0);
    assert.deepEqual(await live.evaluate("__mo.active().set"), []);
    await live.evaluate("__mo.help(__mo.active()); __mo.renderAll()");
    assert.deepEqual(await live.evaluate("__mo.active().flag"), ["async-syrup"]);
    await live.evaluate(`(() => {
      __mo.toggle(__mo.active(), "async-syrup"); __mo.renderAll();
      document.querySelector('[data-act="approve"]').click();
    })()`);
    assert.equal(await live.evaluate("__mo.active().status"), "cooking");
    assert.deepEqual(await live.evaluate("__mo.active().set"), ["async-syrup"]);
    await live.evaluate("__mo.pause()");
    await until(async () => {
        const saved = JSON.parse(await readFile(join(stateDirectory, "live-browser.json"), "utf8"));
        return saved.owner === null && saved.snapshot.state.orders[0].status === "cooking";
    }, "Approved live plan was not checkpointed.");
    assert.equal(await live.evaluate("__mo.S.orders[0].status"), "cooking");
    assert.equal(await live.evaluate("__mo.S.timer"), null);
    assert.deepEqual(await live.evaluate("__mo.S.orders[0].set"), ["async-syrup"]);
    await resume(live);
    modelBehavior = "fail";
    await live.evaluate(`(() => {
      for (let i = 0; i < 6; i++) __mo.tick();
      const o = __mo.S.orders.find(o => o.status === "line"); __mo.select(o.id);
      document.querySelector('[data-act="inputmode"][data-arg="deterministic"]').click();
      __mo.sendPrompt(o, Copilot.promptText(o.want.dish, o.want.opts)); __mo.approve(o);
    })()`);
    assert.equal(await live.evaluate("__mo.active().status"), "cooking");
    modelBehavior = "late"; previousCalls = modelCalls;
    await live.evaluate(`(() => {
      const o = __mo.S.orders.find(o => o.status === "line"); __mo.select(o.id);
      document.querySelector('[data-act="inputmode"][data-arg="copilot"]').click();
      void __mo.sendPrompt(o, "Stacked PR Pancakes");
    })()`);
    await until(() => modelCalls > previousCalls, "Late request did not reach the provider.");
    await live.evaluate("__mo.restart()");
    finishModel();
    await wait(200);
    assert.equal(await live.evaluate("__mo.S.phase"), "welcome");
    assert.equal(await live.evaluate("__mo.S.orders.length"), 0);
    assert.equal(await live.evaluate("__mo.S.elapsed"), 0);
    await live.evaluate("__mo.pause()");
    await host.close("live");

    // Optional signed-in check against the actual extension provider, not a mock.
    if (process.env.DINER_LIVE_URL) {
        const native = await page(process.env.DINER_LIVE_URL);
        await resume(native);
        assert.equal(await native.evaluate("__mo.active().dish"), null, "DINER_LIVE_URL must use a fresh gameId.");
        assert.equal(await native.evaluate(`document.querySelector(
            '[data-act="inputmode"][data-arg="copilot"]'
        )?.getAttribute("aria-pressed")`), "true",
        "DINER_LIVE_URL must select available Real Copilot input; deterministic fallback is not a live smoke test.");
        await native.evaluate('void __mo.sendPrompt(__mo.active(), "Stacked PR Pancakes, berry good review and async syrup")');
        await until(() => native.evaluate('!!__mo.active().dish || !!document.querySelector(\'#cp-body [role="alert"]\')'),
            "Actual extension did not finish the model request.", 450);
        assert.equal(await native.evaluate('document.querySelector(\'#cp-body [role="alert"]\')?.textContent ?? ""'), "");
        assert.equal(await native.evaluate("__mo.active().dish"), "stacked-pr-pancakes");
        assert.deepEqual(await native.evaluate("__mo.active().set.slice().sort()"), ["async-syrup", "berry-good-review"]);
        assert.equal(await native.evaluate("__mo.active().status"), "ordering");
        assert.equal(await native.evaluate("__mo.active().prs.length"), 0);
        await native.evaluate("__mo.pause()");
        assert.equal(native.errors.length, 0);
    }
    }

    await writeFile(join(stateDirectory, "browser.json"), "broken snapshot");
    const brokenURL = await host.open("broken", { gameId: "browser" });
    const target = await (await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(brokenURL)}`, { method: "PUT" })).json();
    const broken = await connect(target.webSocketDebuggerUrl);
    connections.push(broken);
    await until(() => broken.evaluate('!!document.querySelector("#lifecycle-status") && !document.querySelector("#lifecycle-status").hidden'),
        "Load error was not visible.");
    assert.equal(await broken.evaluate('document.querySelector("#start-shift").disabled'), true);
    assert.equal(await broken.evaluate('document.querySelector("#info-dialog").open'), true);
    assert.equal(await broken.evaluate("__mo.S.timer"), null);
    assert.equal(first.errors.length + second.errors.length + broken.errors.length + classic.errors.length + standalone.errors.length + wrapper.errors.length + deterministic.errors.length, 0);
    } catch (error) {
        trace(error.stack);
        throw error;
    }
});
