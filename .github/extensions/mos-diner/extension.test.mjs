import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { createDinerHost, inputSchema } from "./hosting.mjs";

test("extension keeps panels alive after chat completion and cleans up on provider exit", async t => {
    const sourceUrl = new URL("./extension.mjs", import.meta.url);
    const original = await readFile(sourceUrl, "utf8");
    assert.doesNotMatch(original, /from ["'](?:@github\/copilot-sdk["']|\.\/model\.mjs)/);
    const source = original
        .replace(/^import .+;$/gm, "")
        .replaceAll("import.meta.url", JSON.stringify(sourceUrl.href));
    const signals = new Map(), hosts = [], logs = [];
    let configuration, exited = false;
    // Exercise the entry point with SDK/process boundaries stubbed, but real HTTP hosting.
    const bindings = {
        fileURLToPath, homedir, resolve, inputSchema,
        CopilotClient: class { constructor() { throw new Error("No model call expected."); } },
        RuntimeConnection: {},
        createModelInterpreter: () => { throw new Error("No model call expected."); },
        findRuntime: () => { throw new Error("No model call expected."); },
        runtimeStatus: async () => ({ available: false, message: "No executable CLI found; deterministic play is ready." }),
        createCanvas: value => value,
        CanvasError: Error,
        createDinerHost: (...args) => {
            const host = createDinerHost(...args);
            hosts.push(host);
            return host;
        },
        joinSession: async config => {
            configuration = config;
            return { log: async message => logs.push(message) };
        },
        process: { env: {}, once: (name, handler) => signals.set(name, handler),
            exit: code => { assert.equal(code, 0); exited = true; } },
    };
    t.after(async () => { for (const host of hosts) await host.shutdown(); });
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    await new AsyncFunction(...Object.keys(bindings), source)(...Object.values(bindings));
    const canvas = configuration.canvases[0];
    const context = { instanceId: "between-turns", input: {} };
    const first = await canvas.open(context);
    assert.equal((await fetch(first.url)).status, 200);
    const config = await (await fetch(first.url + "_diner/config")).json();
    assert.equal(config.copilot, false);
    assert.match(config.copilotMessage, /local deterministic/);
    const plan = await fetch(first.url + "_diner/plan", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Diner-Capability": config.capability },
        body: JSON.stringify({ owner: "00000000-0000-0000-0000-000000000000",
            requestId: "00000000-0000-0000-0000-000000000001", op: "interpret" }),
    });
    assert.equal(plan.status, 503);
    await configuration.hooks?.onSessionEnd?.({ reason: "complete" });
    assert.equal((await fetch(first.url)).status, 200, "Chat completion must not close the server.");
    assert.equal((await canvas.open(context)).url, first.url);
    await canvas.onClose(context);
    await assert.rejects(fetch(first.url));
    const reopened = await canvas.open(context);
    assert.equal((await fetch(reopened.url)).status, 200);
    await signals.get("disconnect")();
    assert.equal(exited, true);
    await assert.rejects(fetch(reopened.url));
    assert.deepEqual(logs, []);
});
