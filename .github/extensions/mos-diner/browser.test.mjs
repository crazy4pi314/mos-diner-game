import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createDinerHost } from "./hosting.mjs";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
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
test("Edge: offline startup, retry, lifecycle and deterministic play", { timeout: 180000 }, async t => {
    const candidates = [process.env.DINER_EDGE, process.env["ProgramFiles(x86)"] && join(process.env["ProgramFiles(x86)"], "Microsoft", "Edge", "Application", "msedge.exe"),
        process.env.ProgramFiles && join(process.env.ProgramFiles, "Microsoft", "Edge", "Application", "msedge.exe")].filter(Boolean);
    let executable;
    for (const candidate of candidates) {
        try { await access(candidate); executable = candidate; break; } catch { /* Try the next installed location. */ }
    }
    if (!executable) return t.skip("Microsoft Edge not installed; set DINER_EDGE to run browser checks.");
    const directory = await mkdtemp(join(tmpdir(), "diner-edge-test-"));
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
            return { dish: "cookies-code-scanning-shake", opts: [], note: "Other details use house defaults." };
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
        for (const connection of connections) connection.close();
        if (browser) await browser.send("Browser.close").catch(() => {});
        edge.kill();
        await host.shutdown();
        await wait(500);
        await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    });
    const port = await until(async () => {
        try { return Number((await readFile(join(profile, "DevToolsActivePort"), "utf8")).split("\n")[0]); }
        catch { return false; }
    }, "Edge did not start its debugging endpoint.");
    const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
    browser = await connect(version.webSocketDebuggerUrl, false);
    async function page(address, { before = "", ready = true } = {}) {
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
        return connection;
    }
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
        await retrying.evaluate("__mo.resume()");
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
    await interrupted.evaluate("__mo.resume()");
    const beforeGap = await interrupted.evaluate("__mo.snapshot()");
    await interrupted.evaluate("__gap = 9000; __mo.tick()");
    assert.deepEqual(await interrupted.evaluate("__mo.snapshot()"), beforeGap);
    assert.equal(await interrupted.evaluate("__mo.S.timer"), null);
    assert.match(await interrupted.evaluate('document.querySelector("#lifecycle-message").textContent'), /interruption/);
    assert.equal(await interrupted.evaluate('document.querySelector("#start-shift").disabled'), false);
    await interrupted.evaluate('document.querySelector("#prompt").value = "cookies"; document.querySelector("#send-msg").onclick()');
    assert.deepEqual(await interrupted.evaluate("__mo.snapshot()"), beforeGap);
    await interrupted.evaluate("__mo.resume()");
    assert.equal(await interrupted.evaluate("__mo.S.elapsed"), beforeGap.state.elapsed);
    assert.notEqual(await interrupted.evaluate("__mo.S.timer"), null);
    await interrupted.evaluate("__mo.pause()");
    await host.close("suspended");
    await interrupted.closePage();

    const first = await page(url);
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
        certPink: getComputedStyle(document.querySelector(".certificate")).backgroundColor,
        icon: icon.getAttribute("href"),
        markSized: box.width > 40 && box.height > 16,
        markMask: getComputedStyle(header).maskImage.includes("mos-mark.svg"),
        lowercaseBrand: /\\bmo['\\u2019]s/.test(document.body.textContent)
      };
    })()`), {
        headerLabel: "Mo's Diner", welcomeAlt: "Mo's Diner",
        welcomeSrc: "assets/mos-lockup.svg", welcomeRendered: true,
        certSrc: "assets/mos-cert-logo.svg", certRendered: true, certPink: "rgb(238, 188, 215)",
        icon: "assets/invertocat-pink.svg", markSized: true, markMask: true, lowercaseBrand: false,
    });
    await first.evaluate("window.__mo.resume()");
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
      const collapsedFocus = document.activeElement.dataset.act;
      __mo.help(o); __mo.renderAll();
      return { promptFocused, expandedFocus, collapsedFocus,
        correctHint: [...document.querySelectorAll(".cp-hint")].at(-1).textContent.includes("The plan matches") };
    })()`), { promptFocused: true, expandedFocus: "expand", collapsedFocus: "expand", correctHint: true });
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
    await first.evaluate("__mo.resume()");
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
    await first.evaluate("__mo.resume()");
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
    const reopened = await host.open("fresh", { gameId: "browser" });
    const second = await page(reopened);
    assert.equal(await second.evaluate("__mo.S.phase"), "welcome");
    assert.equal(await second.evaluate("__mo.S.elapsed"), 0);
    assert.equal(await second.evaluate("__mo.S.orders.length"), 0);
    assert.equal(await second.evaluate("__mo.S.timer"), null);
    await second.evaluate("__mo.resume()");
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
    await second.evaluate('document.querySelector(\'#over-dialog [data-act="restart"]\').click()');
    assert.equal(await second.evaluate("__mo.S.phase"), "welcome");
    assert.equal(await second.evaluate("__mo.S.elapsed"), 0);
    assert.equal(await second.evaluate("__mo.S.banked"), 0);
    assert.equal(await second.evaluate("__mo.S.orders.length"), 0);
    assert.equal(await second.evaluate('document.querySelector("#info-dialog").open'), true);
    await second.evaluate("__mo.resume()");
    await second.evaluate("__mo.fleetAll()");
    assert.equal(await second.evaluate("__mo.S.phase"), "won");
    assert.equal(await second.evaluate("__mo.S.served"), 3);
    assert.equal(await second.evaluate('document.querySelector("#hud-served").textContent'), "3/3");
    await second.evaluate(`(() => {
      const a = __mo, o = a.S.orders.find(order => order.status !== "served");
      o.status = "ready"; a.serve(o);
    })()`);
    assert.equal(await second.evaluate("__mo.S.served"), 3);
    assert.match(await second.evaluate('document.querySelector("#cert-body").textContent'), /fulfilled 3 orders in/);
    assert.equal(await second.evaluate('document.querySelector("#cert").classList.contains("show")'), true);
    await second.evaluate(`(() => {
      document.querySelector("#cert-name").textContent = "ExtraordinarilyLongChefUsername";
    })()`);
    await second.send("Emulation.setDeviceMetricsOverride", { width: 320, height: 320, deviceScaleFactor: 1, mobile: true });
    const certificateBounds = await second.evaluate(`(() => {
      window.dispatchEvent(new Event("resize"));
      const rect = document.querySelector(".cert-inner").getBoundingClientRect();
      return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: innerWidth, height: innerHeight };
    })()`);
    assert.ok(certificateBounds.left >= 0 && certificateBounds.top >= 0 &&
      certificateBounds.right <= certificateBounds.width && certificateBounds.bottom <= certificateBounds.height,
      `certificate should fit a 320x320 viewport: ${JSON.stringify(certificateBounds)}`);
    await second.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await second.evaluate('window.dispatchEvent(new Event("resize"))');
    assert.equal(await second.evaluate('document.querySelector("#over-dialog").open'), true);
    assert.equal(await second.evaluate('document.querySelector("#over-title").textContent'), "Shift complete!");
    assert.equal(await second.evaluate('document.querySelectorAll("#over-orders li").length'), 3);
    assert.equal(await second.evaluate('document.querySelector("#over-restart").hidden'), true);
    assert.equal(await second.evaluate('document.querySelector("#over-close").hidden'), false);
    await second.evaluate('document.querySelector("#over-close").click()');
    assert.equal(await second.evaluate('document.querySelector("#over-dialog").open'), false);
    assert.equal(await second.evaluate('document.querySelector("#cert").classList.contains("show")'), true);
    await second.evaluate("__mo.restart()");
    await second.evaluate("__mo.resume()");
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

    // A canvas hidden with CSS has no Page Visibility event; intersection must pause it.
    const frameURL = await host.open("frame", { gameId: "frame" });
    const wrapperTarget = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" })).json();
    const wrapper = await connect(wrapperTarget.webSocketDebuggerUrl);
    connections.push(wrapper);
    await wrapper.evaluate(`document.body.innerHTML = '<iframe style="width:1100px;height:700px" src="${frameURL}"></iframe>'`);
    const frameContext = await until(() => wrapper.contexts.find(context => context.origin === new URL(frameURL).origin),
        "Edge did not expose the canvas iframe context.");
    const frame = { evaluate: expression => wrapper.evaluate(expression, frameContext.id) };
    await until(() => frame.evaluate('!!window.__mo && !document.querySelector("#start-shift").disabled'), "Frame did not load.")
        .catch(async error => { throw new Error(`${error.message} ${JSON.stringify(await frame.evaluate('({ text: document.body.innerText, secure: isSecureContext, crypto: typeof crypto.randomUUID })'))} ${JSON.stringify(wrapper.errors)}`); });
    await frame.evaluate("__mo.resume()");
    await wait(1100);
    assert.ok(await frame.evaluate("__mo.S.elapsed >= 1"));
    await wrapper.evaluate('document.querySelector("iframe").style.display = "none"');
    await until(() => frame.evaluate("__mo.S.timer === null"), "CSS-hidden canvas did not pause.");
    const frameTime = await frame.evaluate("__mo.S.elapsed");
    await wait(1200);
    assert.equal(await frame.evaluate("__mo.S.elapsed"), frameTime);
    await wrapper.evaluate('document.querySelector("iframe").style.display = "block"');
    await wait(1100);
    assert.equal(await frame.evaluate("__mo.S.elapsed"), frameTime);
    await host.close("frame");

    const classicURL = await host.open("classic", { gameId: "classic-browser", view: "classic" });
    const classic = await page(classicURL);
    await classic.evaluate("__mo.resume()");
    await classic.evaluate(`(() => {
      const a = __mo, o = a.active();
      a.sendPrompt(o, Copilot.promptText(o.want.dish, o.want.opts));
      o.status = "ready"; a.serve(o); a.renderAll();
    })()`);
    await classic.evaluate("__mo.pause()");
    const classicPaused = await classic.evaluate("__mo.snapshot()");
    await wait(1500);
    assert.deepEqual(await classic.evaluate("__mo.snapshot()"), classicPaused);
    await classic.evaluate("__mo.resume()");
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
                assert.deepEqual(details.categories.slice(0, 5), ["Appetizers", "All Day Breakfast", "Mains", "Soup", "Dessert"]);
                assert.equal(details.categories.includes("Secret Sauces"), dish.sauces);
                assert.deepEqual(details.selected, details.expected, `${skin}/${view}/${dish.id}: chips must round-trip`);
                assert.equal(details.steps, dish.sauces ? 7 : 4);
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
            for (const remove of [false, true]) {
                await menuPage.evaluate(`(async () => {
                  __mo.restart(); await __mo.resume();
                  const o = __mo.active(), d = Copilot.MENU[0], sauce = d.opts.find(option => option.addon);
                  o.want = { dish: d.id, opts: ${remove} ? [] : [sauce.id] }; o.failKind = null;
                  __mo.sendPrompt(o, Copilot.promptText(d.id, ${remove} ? [sauce.id] : []));
                  __mo.approve(o); __mo.renderAll();
                })()`);
                await until(() => menuPage.evaluate('__mo.active().status === "ready"'), "Wrong sauce order did not cook.");
                assert.equal(await menuPage.evaluate("__mo.active().prs.length"), remove ? 5 : 4);
                assert.deepEqual(await menuPage.evaluate(`(() => {
                  const o = __mo.active(), sauce = Copilot.dishOf(o.dish).opts.find(option => option.addon);
                  __mo.serve(o);
                  const status = o.status, flagged = o.flag;
                  __mo.toggle(o, sauce.id); __mo.approve(o); __mo.renderAll();
                  return { status, flagged, expected: [sauce.id], pending: o.pending.length };
                })()`), { status: "returned", flagged: ["secure-secrets-sauce"], expected: ["secure-secrets-sauce"], pending: 1 });
                await until(() => menuPage.evaluate('__mo.active().status === "ready"'), "Sauce correction did not finish.");
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
    await deterministic.evaluate("__mo.resume()");
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
    await missingRuntime.evaluate("__mo.resume()");
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
    await live.evaluate("__mo.resume()");
    assert.match(await live.evaluate('document.querySelector("#cp-body").innerText'), /sign-in, network and model access unverified/);
    await live.evaluate(`(() => {
      const o = __mo.active(); o.want = { dish: "cookies-code-scanning-shake", opts: ["no-callback-cream"] }; o.speech = "Cookies and code scanning shake, no callback cream.";
    })()`);
    modelBehavior = "wait";
    let previousCalls = modelCalls;
    await live.evaluate('void __mo.sendPrompt(__mo.active(), "Cookies and code scanning shake")');
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
    await live.evaluate('void __mo.sendPrompt(__mo.active(), "Cookies and code scanning shake")');
    await until(() => live.evaluate('!document.querySelector("#send-msg").disabled'), "Invalid reply did not unblock retry.");
    assert.equal(await live.evaluate("__mo.active().dish"), null);

    modelBehavior = "wait"; modelAborted = false;
    previousCalls = modelCalls;
    await live.evaluate('void __mo.sendPrompt(__mo.active(), "Cookies and code scanning shake")');
    await until(() => modelCalls > previousCalls, "Second request did not reach the provider.");
    await live.evaluate("__mo.pause()");
    await until(() => modelAborted, "Pausing did not abort the model.");
    const livePaused = await live.evaluate("__mo.snapshot()");
    await wait(200);
    assert.deepEqual(await live.evaluate("__mo.snapshot()"), livePaused);
    assert.equal(livePaused.state.orders[0].dish, null);
    assert.equal(livePaused.state.orders[0].text, "Cookies and code scanning shake");
    assert.equal(JSON.stringify(livePaused).includes("requestId"), false);
    await live.evaluate("__mo.resume()");
    assert.match(await live.evaluate('document.querySelector("#cp-body").innerText'), /interrupted by pause/);

    modelBehavior = "wait"; modelAborted = false;
    previousCalls = modelCalls;
    await live.evaluate('void __mo.sendPrompt(__mo.active(), "Cookies and code scanning shake")');
    await until(() => modelCalls > previousCalls, "Editable request did not reach the provider.");
    await live.evaluate(`(() => {
      const prompt = document.querySelector("#prompt"); prompt.value = "A code scanning shake";
      prompt.dispatchEvent(new Event("input", { bubbles: true }));
    })()`);
    await until(() => modelAborted, "Editing did not abort the previous prompt revision.");
    assert.equal(await live.evaluate("__mo.active().text"), "A code scanning shake");
    assert.equal(await live.evaluate("__mo.active().dish"), null);
    assert.equal(await live.evaluate('document.querySelector("#send-msg").disabled'), false);

    modelBehavior = "ok";
    await live.evaluate('__mo.sendPrompt(__mo.active(), "Cookies and code scanning shake")');
    assert.equal(await live.evaluate("__mo.active().dish"), "cookies-code-scanning-shake");
    assert.equal(await live.evaluate("__mo.active().status"), "ordering");
    assert.equal(await live.evaluate("__mo.active().prs.length"), 0);
    assert.deepEqual(await live.evaluate("__mo.active().set"), []);
    await live.evaluate("__mo.help(__mo.active()); __mo.renderAll()");
    assert.deepEqual(await live.evaluate("__mo.active().flag"), ["no-callback-cream"]);
    await live.evaluate(`(() => {
      __mo.toggle(__mo.active(), "no-callback-cream"); __mo.renderAll();
      document.querySelector('[data-act="approve"]').click();
    })()`);
    assert.equal(await live.evaluate("__mo.active().status"), "cooking");
    assert.deepEqual(await live.evaluate("__mo.active().set"), ["no-callback-cream"]);
    await live.evaluate("__mo.pause()");
    await until(async () => {
        const saved = JSON.parse(await readFile(join(stateDirectory, "live-browser.json"), "utf8"));
        return saved.owner === null && saved.snapshot.state.orders[0].status === "cooking";
    }, "Approved live plan was not checkpointed.");
    assert.equal(await live.evaluate("__mo.S.orders[0].status"), "cooking");
    assert.equal(await live.evaluate("__mo.S.timer"), null);
    assert.deepEqual(await live.evaluate("__mo.S.orders[0].set"), ["no-callback-cream"]);
    await live.evaluate("__mo.resume();");
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
      void __mo.sendPrompt(o, "Cookies and code scanning shake");
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
        await native.evaluate("__mo.resume()");
        assert.equal(await native.evaluate("__mo.active().dish"), null, "DINER_LIVE_URL must use a fresh gameId.");
        assert.equal(await native.evaluate(`document.querySelector(
            '[data-act="inputmode"][data-arg="copilot"]'
        )?.getAttribute("aria-pressed")`), "true",
        "DINER_LIVE_URL must select available Real Copilot input; deterministic fallback is not a live smoke test.");
        await native.evaluate('void __mo.sendPrompt(__mo.active(), "Cookies and code scanning shake, dark-mode scan and no callback cream")');
        await until(() => native.evaluate('!!__mo.active().dish || !!document.querySelector(\'#cp-body [role="alert"]\')'),
            "Actual extension did not finish the model request.", 450);
        assert.equal(await native.evaluate('document.querySelector(\'#cp-body [role="alert"]\')?.textContent ?? ""'), "");
        assert.equal(await native.evaluate("__mo.active().dish"), "cookies-code-scanning-shake");
        assert.deepEqual(await native.evaluate("__mo.active().set.slice().sort()"), ["dark-mode-scan", "no-callback-cream"]);
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
});
