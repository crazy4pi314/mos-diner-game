import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import LivePlan from "../../../live-plan.js";
import { createModelInterpreter, sessionConfig, findRuntime, runtimeStatus } from "./model.mjs";
import { createDinerHost, viewQuery } from "./hosting.mjs";
import { createStateStore } from "./state.mjs";

const good = { dish: "browser-cookies", opts: ["fork-batch", "headless"], note: "House defaults for other details." };
const root = fileURLToPath(new URL("../../../", import.meta.url));
test("runtime discovery validates configured and PATH executables without starting a model", async t => {
    const directory = await mkdtemp(join(tmpdir(), "diner-runtime-test-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    assert.equal((await runtimeStatus({ PATH: "" })).available, false);
    for (const path of ["copilot", join(directory, "missing.exe"), directory]) {
        assert.equal((await runtimeStatus({ PATH: directory, COPILOT_CLI_PATH: path })).available, false);
        await assert.rejects(findRuntime({ COPILOT_CLI_PATH: path }), /absolute executable/);
    }
    const binary = join(directory, process.platform === "win32" ? "copilot.exe" : "copilot");
    await writeFile(binary, "not an executable");
    assert.equal((await runtimeStatus({ PATH: directory })).available, false);
    assert.equal((await runtimeStatus({ COPILOT_CLI_PATH: binary })).available, false);
    if (process.platform === "win32") {
        const image = Buffer.alloc(68);
        image.write("MZ"); image.writeUInt32LE(64, 60); image.set([80, 69, 0, 0], 64);
        await writeFile(binary, image);
    } else {
        await writeFile(binary, "#!/bin/sh\nexit 0\n");
        await chmod(binary, 0o700);
    }
    assert.equal(await findRuntime({ PATH: directory }), binary);
    assert.equal(await findRuntime({ COPILOT_CLI_PATH: binary }), binary);
    const status = await runtimeStatus({ COPILOT_CLI_PATH: binary });
    assert.equal(status.available, true);
    assert.match(status.message, /unverified until you send/);
    assert.equal((await runtimeStatus({ PATH: directory, COPILOT_CLI_PATH: join(directory, "missing") })).available, false,
        "An invalid explicit override must not silently use PATH.");
});

test("config fails closed on unverified callbacks and discovery failures, without invoking the interpreter", async t => {
    const directory = await mkdtemp(join(tmpdir(), "diner-config-test-"));
    let interpreted = false, available = false, failed = false;
    const errors = [];
    const options = {
        stateDirectory: directory,
        interpret: async () => { interpreted = true; return good; },
        runtimeStatus: async () => {
            if (failed) throw new Error("Discovery I/O failure");
            return { available, message: available ? "Executable found; account unverified." : "Invalid executable; deterministic play is ready." };
        },
    };
    const host = createDinerHost(root, options);
    host.onError = error => errors.push(error.message);
    t.after(async () => { await host.shutdown(); await rm(directory, { recursive: true, force: true }); });
    const url = await host.open("config");
    const config = async () => (await fetch(url + "_diner/config")).json();
    assert.equal((await config()).copilot, false);
    assert.match((await config()).copilotMessage, /Invalid executable/);
    available = true;
    assert.equal((await config()).copilot, true);
    assert.match((await config()).copilotMessage, /account unverified/);
    failed = true;
    assert.equal((await config()).copilot, false);
    assert.match((await config()).copilotMessage, /Could not check/);
    assert.ok(errors.includes("Discovery I/O failure"));
    delete options.runtimeStatus;
    assert.equal((await config()).copilot, false);
    assert.match((await config()).copilotMessage, /availability is unverified/);
    assert.equal(interpreted, false);
});

test("strict menu validation rejects wrong-dish options, duplicates, missing fields and unsafe text", () => {
    assert.deepEqual(LivePlan.validate(good), good);
    for (const value of [null, {}, { ...good, dish: "pizza" }, { ...good, opts: ["cold-cache"] },
        { ...good, opts: ["fork-batch", "fork-batch"] }, { ...good, opts: ["constructor"] },
        { ...good, note: "<img onerror=alert(1)>" }, { ...good, note: "x".repeat(301) },
        { ...good, note: "\0" }, { ...good, approve: true }, { dish: "browser-cookies", opts: [] }]) {
        assert.throws(() => LivePlan.validate(value), /invalid menu plan/);
    }
    for (const text of [null, "", " ", "x".repeat(2001)]) assert.throws(() => LivePlan.validatePrompt(text));
    assert.equal(LivePlan.validatePrompt(" Browser Cookies "), "Browser Cookies");
    assert.equal(viewQuery({ inputMode: "deterministic" }), "");
    assert.throws(() => viewQuery({ inputMode: "copilot" }), TypeError);
    assert.throws(() => viewQuery({ inputMode: "automatic" }), TypeError);
});

function fakeClient(reply = JSON.stringify(good)) {
    const calls = [];
    const session = {
        sessionId: "isolated",
        async sendAndWait(options, timeout) { calls.push(["send", options, timeout]); return { data: { content: reply } }; },
        async abort() { calls.push(["abort"]); },
    };
    return {
        calls, session,
        async createSession(config) { calls.push(["create", config]); return session; },
        async deleteSession(id) { calls.push(["delete", id]); },
    };
}
test("SDK boundary uses isolated no-tool config, structured response and cleans up without approval", async () => {
    const client = fakeClient(), abort = new AbortController();
    assert.deepEqual(await createModelInterpreter(client)("fork the batch and make the Browser Cookies headless", abort.signal), good);
    assert.deepEqual(sessionConfig.availableTools, []);
    assert.equal(sessionConfig.skipCustomInstructions, true);
    assert.equal(sessionConfig.enableSkills, false);
    assert.equal((await sessionConfig.onPermissionRequest()).kind, "denied-by-permission-request-hook");
    assert.equal(client.calls[0][1], sessionConfig);
    assert.equal(client.calls[1][1].responseSchema, LivePlan.schema);
    assert.equal(client.calls[1][2], 30000);
    assert.deepEqual(JSON.parse(client.calls[1][1].prompt), { playerPrompt: "fork the batch and make the Browser Cookies headless" });
    assert.deepEqual(client.calls.slice(-2), [["abort"], ["delete", "isolated"]]);
});
test("SDK invalid/missing/failed responses and startup failure propagate recoverably", async () => {
    for (const reply of ["not json", "null", "{}", JSON.stringify({ ...good, opts: ["cold-cache"] }), undefined]) {
        const client = fakeClient(reply);
        if (reply === undefined) client.session.sendAndWait = async () => undefined;
        await assert.rejects(createModelInterpreter(client)("Browser Cookies", new AbortController().signal));
        assert.deepEqual(client.calls.at(-1), ["delete", "isolated"]);
    }
    const client = fakeClient();
    client.session.sendAndWait = async () => { throw new Error("Network unavailable"); };
    await assert.rejects(createModelInterpreter(client)("Browser Cookies", new AbortController().signal), /Network unavailable/);
    assert.equal(client.calls.at(-1)[0], "delete");
    client.createSession = async () => { throw new Error("Login unavailable"); };
    await assert.rejects(createModelInterpreter(client)("Browser Cookies", new AbortController().signal), /Login unavailable/);
});
test("cancellation before/during session creation and model completion cannot return a plan", async () => {
    const client = fakeClient(), abort = new AbortController();
    abort.abort();
    await assert.rejects(createModelInterpreter(client)("Browser Cookies", abort.signal), { name: "AbortError" });
    assert.equal(client.calls.length, 0);
    const during = new AbortController();
    client.createSession = async () => { during.abort(); return client.session; };
    await assert.rejects(createModelInterpreter(client)("Browser Cookies", during.signal), { name: "AbortError" });
    assert.equal(client.calls.some(c => c[0] === "send"), false);
    assert.equal(client.calls.at(-1)[0], "delete");
    const late = new AbortController(), second = fakeClient();
    second.session.sendAndWait = async () => { late.abort(); return { data: { content: JSON.stringify(good) } }; };
    await assert.rejects(createModelInterpreter(second)("Browser Cookies", late.signal), { name: "AbortError" });
    assert.equal(second.calls.at(-1)[0], "delete");
});
test("cancellation settles stalled session creation and disposes a late session", { timeout: 1000 }, async () => {
    const client = fakeClient(), abort = new AbortController();
    let resolveSession, resolveDisposed;
    const disposed = new Promise(resolve => { resolveDisposed = resolve; });
    client.createSession = () => new Promise(resolve => { resolveSession = resolve; });
    client.deleteSession = async id => {
        client.calls.push(["delete", id]);
        resolveDisposed();
    };
    const pending = createModelInterpreter(client)("burger", abort.signal);
    abort.abort();
    await assert.rejects(pending, { name: "AbortError" });
    assert.equal(client.calls.some(call => call[0] === "send"), false);

    resolveSession(client.session);
    await disposed;
    assert.deepEqual(client.calls.slice(-2), [["abort"], ["delete", "isolated"]]);
});

function checkpoint() {
    return { version: 1, view: "hub", state: {
        phase: "shift", left: 60, elapsed: 0, active: 40, pr: 101, tips: 0, banked: 0, served: 0, chef: "",
        queue: Array.from({ length: 3 }, (_, i) => ({ at: i + 1, n: i + 1, d: "browser-cookies", who: ["chef", "face"] })),
        orders: [{ id: 40, seat: 0, status: "ordering", name: "chef", face: "face", speech: "Browser Cookies", text: "Browser Cookies", sent: "", complaint: "",
            patience: 100, returns: 0, tip: 0, miss: 0, ci: 0, handed: false, fleet: false, failFixed: false,
            want: { dish: "browser-cookies", opts: [] }, draft: { dish: null, opts: [] }, dish: null,
            asked: [], set: [], flag: [], tried: [], log: [], built: {}, prs: [], pending: [], checks: [],
            failKind: null, fail: null }],
    } };
}
test("protected plan HTTP boundary, ownership, approval, body bounds, failure and cancellation", async t => {
    const directory = await mkdtemp(join(tmpdir(), "diner-model-test-"));
    let reject = false, blocked = false, entered, wasAborted = false, calls = 0;
    const host = createDinerHost(root, {
        stateDirectory: directory,
        interpret: async (_, signal) => {
            calls++;
            if (reject) throw new Error("Offline");
            if (blocked) await new Promise((resolve, fail) => {
                entered();
                signal.addEventListener("abort", () => { wasAborted = true; fail(signal.reason); }, { once: true });
            });
            return good;
        },
    });
    host.onError = () => {};
    t.after(async () => { await host.shutdown(); await rm(directory, { recursive: true, force: true }); });
    const url = await host.open("model", { gameId: "model" }), config = await (await fetch(url + "_diner/config")).json();
    const owner = randomUUID(), store = createStateStore(directory), value = checkpoint();
    await store.claim("model", owner, 0); await store.save("model", owner, 0, value);
    const request = (body, headers = {}) => fetch(url + "_diner/plan", {
        method: "POST", headers: { "Content-Type": "application/json", "X-Diner-Capability": config.capability, ...headers },
        body: typeof body === "string" ? body : JSON.stringify(body),
    });
    const body = { op: "interpret", requestId: randomUUID(), owner, orderId: 40, prompt: "Browser Cookies" };
    assert.equal((await request(body, { "X-Diner-Capability": "wrong" })).status, 403);
    assert.equal((await request(body, { Origin: "http://foreign.example" })).status, 403);
    assert.equal((await request(body, { "Sec-Fetch-Site": "cross-site" })).status, 403);
    assert.equal((await request(body, { "Content-Type": "text/plain" })).status, 415);
    assert.equal((await request("bad")).status, 400);
    assert.equal((await request("x".repeat(16385))).status, 413);
    assert.equal((await request({ ...body, prompt: "" })).status, 400);
    assert.equal((await request({ ...body, owner: randomUUID() })).status, 409);
    assert.equal((await request({ ...body, orderId: 41 })).status, 409);
    assert.equal(calls, 0);
    assert.deepEqual(await (await request(body)).json(), good);
    // Proposing a plan never writes an approved order or starts cooking.
    assert.deepEqual((await store.load("model")).snapshot, value);
    reject = true;
    assert.equal((await request({ ...body, requestId: randomUUID() })).status, 503);
    reject = false; blocked = true;
    let ready = new Promise(resolve => { entered = resolve; });
    const pending = request(body);
    await ready;
    assert.equal((await request({ ...body, op: "cancel" })).status, 200);
    assert.equal((await pending).status, 503);
    assert.equal(wasAborted, true);
    wasAborted = false;
    ready = new Promise(resolve => { entered = resolve; });
    const releasing = request(body); await ready;
    const saved = await fetch(url + "_diner/state", {
        method: "POST", headers: { "Content-Type": "application/json", "X-Diner-Capability": config.capability },
        body: JSON.stringify({ op: "release", owner, revision: 1, snapshot: value }),
    });
    assert.equal(saved.status, 200);
    assert.equal((await releasing).status, 503);
    assert.equal(wasAborted, true);
    assert.equal((await request(body)).status, 409);
});
