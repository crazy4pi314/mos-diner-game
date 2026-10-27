import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import Snapshot from "../../../snapshot.js";
import Lifecycle from "../../../lifecycle.js";
import { createStateStore, LEASE_MS } from "./state.mjs";
import { createDinerHost, viewQuery } from "./hosting.mjs";

const root = fileURLToPath(new URL("../../../", import.meta.url));
function snapshot() {
    return {
        version: 1, view: "hub",
        state: { phase: "shift", left: 51, elapsed: 9, active: null, pr: 105, tips: 0, banked: 0, served: 0, chef: "octocat",
            queue: Array.from({ length: 6 }, (_, n) => ({ at: n, n, d: "burger", who: ["chef", "face"] })), orders: [] },
    };
}
async function directory(t) {
    const path = await mkdtemp(join(tmpdir(), "diner-state-test-"));
    t.after(() => rm(path, { recursive: true, force: true }));
    return path;
}
test("stable IDs, versioned serializable snapshots, paused reload across providers", async t => {
    const path = await directory(t), first = createStateStore(path), second = createStateStore(path);
    const owner = randomUUID(), value = snapshot();
    assert.equal((await first.load("game")).snapshot, null);
    await first.claim("game", owner, 0);
    const saved = await first.save("game", owner, 0, value, true);
    assert.equal(saved.revision, 1);
    assert.deepEqual((await second.load("game")).snapshot, value);
    assert.equal((await second.load("other")).snapshot, null);
    assert.equal((await second.load("game")).busy, false);
    assert.throws(() => viewQuery({ gameId: "../escape" }), TypeError);
    assert.equal(viewQuery({ gameId: "booth-1" }), "");
    assert.throws(() => viewQuery({ gameId: "Booth" }), TypeError);
    await assert.rejects(first.load("Booth"), { status: 400 });
    assert.throws(() => Snapshot.validate({ ...value, version: 2 }), /Unsupported/);
    assert.throws(() => Snapshot.validate({ ...value, state: { ...value.state, timer: 12 } }), /Invalid/);
    assert.throws(() => Snapshot.validate({ ...value, state: { ...value.state, elapsed: null } }), /Invalid/);
    const unknownQueueFailure = structuredClone(value);
    unknownQueueFailure.state.queue[0].fail = "unknown";
    assert.throws(() => Snapshot.validate(unknownQueueFailure), /queue/);
    const unknownOrderFailure = structuredClone(value);
    const queued = unknownOrderFailure.state.queue.shift();
    unknownOrderFailure.state.orders.push({
        id: 40 + queued.n, name: queued.who[0], face: queued.who[1], speech: "", text: "", sent: "", complaint: "",
        status: "line", patience: 100, returns: 0, tip: 0, miss: 0, ci: 0, seat: 0,
        handed: false, fleet: false, failFixed: false, want: { dish: queued.d, opts: [] },
        draft: { dish: null, opts: [] }, dish: null, asked: [], set: [], flag: [], tried: [], log: [],
        built: {}, prs: [], pending: [], checks: [], failKind: null, fail: null,
    });
    Snapshot.validate(unknownOrderFailure);
    unknownOrderFailure.state.orders[0].failKind = "unknown";
    assert.throws(() => Snapshot.validate(unknownOrderFailure), /order/);
    assert.throws(() => Snapshot.validate({ ...value, metadata: "x".repeat(Snapshot.MAX_BYTES) }), /too large/);
    assert.throws(() => Snapshot.validate({ ...value, metadata: "\u00e9".repeat(Snapshot.MAX_BYTES / 2) }), /too large/);
});
test("corrupt/unsupported disk state and write failures are errors, never new shifts", async t => {
    const path = await directory(t), store = createStateStore(path);
    for (const content of ["not json", '{"version":99}', JSON.stringify({ version: 1, revision: 1, owner: null, snapshot: { version: 9 } })]) {
        await writeFile(join(path, "bad.json"), content);
        await assert.rejects(store.load("bad"));
        assert.equal(await readFile(join(path, "bad.json"), "utf8"), content);
    }
    const file = join(path, "not-directory");
    await writeFile(file, "file");
    await assert.rejects(createStateStore(file).load("game"));
});
test("duplicate providers cannot claim, write stale revisions, or outlive their lease", async t => {
    const path = await directory(t);
    let now = 0;
    const a = createStateStore(path, () => now), b = createStateStore(path, () => now);
    const first = randomUUID(), second = randomUUID();
    const claims = await Promise.allSettled([a.claim("game", first, 0), b.claim("game", second, 0)]);
    assert.equal(claims.filter(x => x.status === "fulfilled").length, 1);
    const winner = claims[0].status === "fulfilled" ? first : second, loser = winner === first ? second : first;
    await assert.rejects(b.save("game", loser, 0, snapshot()), { status: 409 });
    await a.save("game", winner, 0, snapshot());
    await assert.rejects(a.save("game", winner, 0, snapshot()), { status: 409 });
    now = LEASE_MS + 1;
    await b.claim("game", loser, 1);
    await assert.rejects(a.save("game", winner, 1, snapshot()), { status: 409 });
    await b.release("game", loser);
    assert.equal((await a.load("game")).busy, false);
});
test("controller restores paused; hidden, timeout, persistence failure and cleanup stop advancement", async () => {
    let now = 0, hidden = false, restores = 0, pauses = 0, cancelled = 0, failSave = false;
    let revision = 1, heartbeat;
    const operations = [], errors = [];
    const controller = Lifecycle.createController({
        now: () => now, hidden: () => hidden, snapshot, restore: () => restores++, pause: () => pauses++,
        error: message => errors.push(message),
        schedule: callback => { heartbeat = callback; return 1; }, cancel: () => cancelled++,
        transport: async body => {
            if (!body) return { revision, snapshot: snapshot() };
            operations.push(body.op);
            assert.equal(body.revision, revision);
            if (body.op === "save" && failSave) throw new Error("Disk unavailable");
            if (body.op !== "claim") revision++;
            return { revision };
        },
    });
    await controller.load();
    assert.equal(restores, 1);
    assert.equal(controller.canAdvance(), false);
    assert.equal(await controller.resume(), true);
    assert.equal(controller.canAdvance(), true);
    hidden = true;
    assert.equal(controller.canAdvance(), false);
    await controller.pause();
    hidden = false;
    assert.equal(controller.canAdvance(), false);
    assert.equal(await controller.resume(), true);
    await controller.save();
    heartbeat();
    await controller.save();
    now = 4000;
    failSave = true;
    await assert.rejects(controller.save(), /Disk unavailable/);
    assert.equal(controller.canAdvance(), false);
    assert.ok(errors.includes("Disk unavailable"));
    await controller.close();
    assert.equal(cancelled, 2);
    assert.ok(pauses >= 3);
    assert.deepEqual(operations.slice(0, 4), ["claim", "release", "claim", "save"]);

    now = 0;
    const timed = Lifecycle.createController({
        now: () => now, hidden: () => false, snapshot, restore() {}, pause() {}, error: m => errors.push(m),
        interrupted: m => errors.push(m),
        schedule: () => 1, cancel() {}, transport: async () => ({ revision: 0 }),
    });
    await timed.resume();
    now = 6000;
    assert.equal(timed.canAdvance(), false);
    assert.match(errors.at(-1), /interruption/);
    await timed.close();
});
test("a delayed heartbeat expires before edits or writes, then explicit resume reclaims unchanged state", async t => {
    const path = await directory(t);
    let now = 0, heartbeat, cancelled = 0, interruptions = 0, restores = 0;
    const store = createStateStore(path, () => now), ops = [], errors = [];
    const controller = Lifecycle.createController({
        now: () => now, hidden: () => false, snapshot, restore: () => restores++, pause() {},
        interrupted: () => interruptions++, error: message => errors.push(message),
        schedule: callback => { heartbeat = callback; return 1; }, cancel: () => cancelled++,
        transport: async body => {
            ops.push(body?.op ?? "load");
            if (!body) return store.load("game");
            if (body.op === "claim") return store.claim("game", body.owner, body.revision);
            return store.save("game", body.owner, body.revision, body.snapshot, body.op === "release");
        },
    });
    await controller.load();
    await controller.resume();
    await controller.save();
    const original = JSON.parse(await readFile(join(path, "game.json"), "utf8"));
    now = LEASE_MS + 1;
    heartbeat();
    assert.equal(controller.canEdit(), false);
    assert.equal(controller.canAdvance(), false);
    await controller.save();
    await controller.pause();
    assert.equal(interruptions, 1);
    assert.equal(cancelled, 1);
    assert.deepEqual(ops, ["load", "claim", "save"]);
    assert.deepEqual(JSON.parse(await readFile(join(path, "game.json"), "utf8")), original);
    assert.equal(await controller.resume(), true);
    assert.deepEqual(ops.slice(-2), ["load", "claim"]);
    assert.equal(restores, 0, "Recovery must not restore a saved snapshot into the live shift.");
    assert.equal(controller.canEdit(), true);
    assert.equal(controller.canAdvance(), true);
    assert.deepEqual(errors, []);
    await controller.close();
});
test("expired control cannot reclaim another owner's lease or overwrite a changed revision", async t => {
    for (const changed of [false, true]) {
        const path = await directory(t);
        let now = 0;
        const store = createStateStore(path, () => now), errors = [];
        const controller = Lifecycle.createController({
            now: () => now, hidden: () => false, snapshot, restore() {}, pause() {}, error: m => errors.push(m),
            schedule: () => 1, cancel() {},
            transport: body => {
                if (!body) return store.load("game");
                if (body.op === "claim") return store.claim("game", body.owner, body.revision);
                return store.save("game", body.owner, body.revision, body.snapshot, body.op === "release");
            },
        });
        await controller.resume();
        await controller.save();
        now = LEASE_MS + 1;
        assert.equal(controller.canEdit(), false);
        const other = randomUUID();
        await store.claim("game", other, 1);
        if (changed) {
            const next = snapshot(); next.state.elapsed++;
            await store.save("game", other, 1, next, true);
        }
        await assert.rejects(controller.resume(), changed ? /changed in another view/ : /controlled by another view/);
        assert.equal(controller.canEdit(), false);
        const disk = JSON.parse(await readFile(join(path, "game.json"), "utf8"));
        assert.equal(disk.owner, changed ? null : other);
        assert.equal(disk.revision, changed ? 2 : 1);
        assert.equal(errors.length, 1);
        await controller.close();
    }
});
test("late saves and queued work cannot resume clocks or write an obsolete snapshot after expiry", async () => {
    let now = 0, finishSave, readCurrent, value = snapshot(), pauses = 0;
    const ops = [];
    const controller = Lifecycle.createController({
        now: () => now, hidden: () => false, snapshot: () => structuredClone(value),
        restore() {}, pause: () => pauses++, error() {}, schedule: () => 1, cancel() {},
        transport: body => {
            ops.push(body?.op ?? "load");
            if (!body) return new Promise(resolve => { readCurrent = resolve; });
            if (body.op === "save") return new Promise(resolve => { finishSave = resolve; });
            return Promise.resolve({ revision: body.revision });
        },
    });
    await controller.resume();
    const saving = controller.save();
    await new Promise(resolve => setImmediate(resolve));
    value.state.elapsed++;
    const queued = controller.save();
    now = 9000;
    assert.equal(controller.canEdit(), false);
    finishSave({ revision: 1 });
    await Promise.all([saving, queued]);
    assert.deepEqual(ops, ["claim", "save"]);
    assert.equal(controller.canAdvance(), false);
    const resuming = controller.resume();
    await new Promise(resolve => setImmediate(resolve));
    const pausing = controller.pause();
    readCurrent({ revision: 1 });
    assert.equal(await resuming, false);
    await pausing;
    assert.deepEqual(ops, ["claim", "save", "load"]);
    assert.ok(pauses >= 2);
    await controller.close();
});
test("a resume delayed in the task queue must check expiry again before writing", async () => {
    let now = 0, interruptions = 0;
    const ops = [];
    const controller = Lifecycle.createController({
        now: () => now, hidden: () => false, snapshot, restore() {}, pause() {}, error() {},
        interrupted: () => interruptions++, schedule: () => 1, cancel() {},
        transport: async body => { ops.push(body?.op ?? "load"); return { revision: 0 }; },
    });
    await controller.resume();
    const delayed = controller.resume();
    now = 9000;
    assert.equal(await delayed, false);
    assert.equal(interruptions, 1);
    assert.deepEqual(ops, ["claim"]);
    assert.equal(await controller.resume(), true);
    assert.deepEqual(ops, ["claim", "load", "claim"]);
    await controller.close();
});
test("late persistence failures remain explicit errors even after the control deadline", async () => {
    let now = 0, interruptions = 0;
    const errors = [];
    const controller = Lifecycle.createController({
        now: () => now, hidden: () => false, snapshot, restore() {}, pause() {},
        error: message => errors.push(message), interrupted: () => interruptions++,
        schedule: () => 1, cancel() {},
        transport: async body => {
            if (body.op === "save") {
                now = 9000;
                throw new Error("Disk unavailable");
            }
            return { revision: 0 };
        },
    });
    await controller.resume();
    await assert.rejects(controller.save(), /Disk unavailable/);
    assert.deepEqual(errors, ["Disk unavailable"]);
    assert.equal(interruptions, 0);
    assert.equal(await controller.resume(), false);
    await controller.close();
});
test("controller load failure does not restore or enable play; hiding during claim releases control", async () => {
    let restored = false;
    const failed = Lifecycle.createController({
        snapshot, restore: () => { restored = true; }, pause() {}, error() {},
        transport: async () => { throw new Error("Unsupported snapshot"); },
    });
    await assert.rejects(failed.load(), /Unsupported/);
    assert.equal(restored, false);
    assert.equal(await failed.resume(), false);
    let hidden = false;
    const ops = [];
    const controller = Lifecycle.createController({
        snapshot, restore() {}, pause() {}, error() {}, hidden: () => hidden,
        transport: async body => { ops.push(body.op); hidden = true; return { revision: 0 }; },
    });
    assert.equal(await controller.resume(), false);
    assert.deepEqual(ops, ["claim", "release"]);
});
test("pause invalidates an in-flight resume before it can restart clocks", async () => {
    let finishClaim;
    const operations = [];
    const controller = Lifecycle.createController({
        snapshot, restore() {}, pause() {}, error() {}, hidden: () => false,
        transport: body => {
            operations.push(body.op);
            if (body.op === "claim") return new Promise(resolve => { finishClaim = resolve; });
            return Promise.resolve({ revision: 1 });
        },
    });
    const resuming = controller.resume();
    await new Promise(resolve => setImmediate(resolve));
    const pausing = controller.pause();
    finishClaim({ revision: 0 });
    assert.equal(await resuming, false);
    await pausing;
    assert.deepEqual(operations, ["claim", "release"]);
    assert.equal(controller.canAdvance(), false);
    assert.equal(controller.canEdit(), false);
});
test("unchanged snapshot refreshes the lease without a new revision", async t => {
    const path = await directory(t);
    let now = 0;
    const store = createStateStore(path, () => now);
    const owner = randomUUID(), value = snapshot();
    await store.claim("game", owner, 0);
    const first = await store.save("game", owner, 0, value);
    assert.equal(first.revision, 1);
    now = 1000;
    const second = await store.save("game", owner, 1, structuredClone(value));
    assert.equal(second.revision, 1);
    const disk = JSON.parse(await readFile(join(path, "game.json"), "utf8"));
    assert.equal(disk.revision, 1);
    assert.equal(disk.expires, 1000 + LEASE_MS);
    const changed = snapshot();
    changed.state.elapsed = 10;
    assert.equal((await store.save("game", owner, 1, changed)).revision, 2);
});
test("unchanged saves skip the network until the lease needs a refresh", async () => {
    let now = 0;
    const ops = [];
    const controller = Lifecycle.createController({
        now: () => now, hidden: () => false, snapshot, restore() {}, pause() {}, error() {},
        schedule: () => 1, cancel() {},
        transport: async body => {
            ops.push(body.op);
            return { revision: body?.revision ?? 0 };
        },
    });
    await controller.resume();
    await controller.save();
    await controller.save();
    assert.deepEqual(ops, ["claim", "save"]);
    now = 3000;
    await controller.save();
    assert.deepEqual(ops, ["claim", "save", "save"]);
    await controller.close();
});
test("heartbeat always posts while debounced unchanged saves still skip", async () => {
    let now = 0, heartbeat = null, scheduled = null;
    const ops = [];
    const controller = Lifecycle.createController({
        now: () => now, hidden: () => false, snapshot, restore() {}, pause() {}, error() {},
        schedule: callback => { heartbeat = callback; return 1; }, cancel() {},
        defer: fn => { scheduled = fn; return 1; },
        cancelDefer: () => { scheduled = null; },
        transport: async body => {
            ops.push(body.op);
            return { revision: body?.revision ?? 0 };
        },
    });
    await controller.resume();
    await controller.save();
    now = 2000;
    heartbeat();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(ops, ["claim", "save", "save"]);
    controller.saveSoon();
    scheduled();
    await new Promise(resolve => setImmediate(resolve));
    await controller.save();
    assert.deepEqual(ops, ["claim", "save", "save"]);
    await controller.close();
});
test("delayed A to B to A save waits for the in-flight write before skipping", async () => {
    let now = 0, state = snapshot(), releaseB;
    state.state.elapsed = 1;
    const persisted = [];
    const controller = Lifecycle.createController({
        now: () => now, hidden: () => false, snapshot: () => structuredClone(state),
        restore() {}, pause() {}, error() {}, schedule: () => 1, cancel() {},
        transport: async body => {
            if (body?.op === "save") {
                if (body.snapshot.state.elapsed === 2) await new Promise(resolve => { releaseB = resolve; });
                persisted.push(structuredClone(body.snapshot));
            }
            return { revision: body?.revision ?? 0 };
        },
    });
    await controller.resume();
    await controller.save();
    state = snapshot();
    state.state.elapsed = 2;
    const savingB = controller.save();
    await new Promise(resolve => setImmediate(resolve));
    state = snapshot();
    state.state.elapsed = 1;
    let settled = false;
    const savingA = controller.save().then(() => { settled = true; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(settled, false);
    assert.equal(persisted.length, 1);
    releaseB();
    await savingB;
    await savingA;
    assert.deepEqual(persisted.map(value => value.state.elapsed), [1, 2, 1]);
    await controller.close();
});
test("save after pause is not skipped when the snapshot matches the pre-release cache", async () => {
    let now = 0, state = snapshot();
    state.state.elapsed = 1;
    const persisted = [];
    const controller = Lifecycle.createController({
        now: () => now, hidden: () => false, snapshot: () => structuredClone(state),
        restore() {}, pause() {}, error() {}, schedule: () => 1, cancel() {},
        transport: async body => {
            if (body?.snapshot) persisted.push(body.snapshot.state.elapsed);
            return { revision: body?.revision ?? 0 };
        },
    });
    await controller.resume();
    await controller.save();
    state = snapshot();
    state.state.elapsed = 2;
    await controller.pause();
    state = snapshot();
    state.state.elapsed = 1;
    assert.equal(await controller.resume(), true);
    await controller.save();
    assert.deepEqual(persisted, [1, 2, 1]);
    await controller.close();
});
test("saveSoon coalesces and does not run after pause", async () => {
    let scheduled = null;
    const ops = [];
    const controller = Lifecycle.createController({
        snapshot, restore() {}, pause() {}, error() {}, hidden: () => false,
        schedule: () => 1, cancel() {},
        defer: fn => { scheduled = fn; return 1; },
        cancelDefer: () => { scheduled = null; },
        transport: async body => { ops.push(body.op); return { revision: 0 }; },
    });
    await controller.resume();
    controller.saveSoon();
    controller.saveSoon();
    assert.deepEqual(ops, ["claim"]);
    scheduled();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(ops, ["claim", "save"]);
    controller.saveSoon();
    await controller.pause();
    assert.equal(scheduled, null);
});
test("visibility tracking ignores an unconfirmed headless signal and pauses after visible becomes hidden", () => {
    const visible = Lifecycle.createVisibilityTracker(true);
    const entry = (isVisible, width = 100, height = 100) => ({
        isVisible, isIntersecting: width > 0 && height > 0, intersectionRect: { width, height },
    });
    assert.equal(visible(entry(false)), true);
    assert.equal(visible(entry(true)), true);
    assert.equal(visible(entry(false)), false);
    assert.equal(visible(entry(true, 0, 0)), false);
});
test("HTTP capabilities, origins, JSON/size limits, scoped IDs and close cleanup", async t => {
    const stateDirectory = await directory(t);
    const host = createDinerHost(root, { stateDirectory });
    host.onError = () => {};
    t.after(() => host.shutdown());
    const url = await host.open("first", { gameId: "game" });
    const config = await (await fetch(url + "_diner/config")).json();
    const headers = { "X-Diner-Capability": config.capability, "Content-Type": "application/json" };
    const owner = randomUUID();
    const post = body => fetch(url + "_diner/state", { method: "POST", headers, body: JSON.stringify(body) });
    assert.equal((await fetch(url + "_diner/state")).status, 403);
    assert.equal((await fetch(url + "_diner/state", { headers: { ...headers, Origin: "http://evil.example" } })).status, 403);
    assert.equal((await fetch(url + "_diner/state", { headers: { ...headers, "Sec-Fetch-Site": "cross-site" } })).status, 403);
    assert.equal((await fetch(url + "_diner/state", { method: "POST", headers: { "X-Diner-Capability": config.capability }, body: "{}" })).status, 415);
    assert.equal((await fetch(url + "_diner/state", { method: "POST", headers, body: "{" })).status, 400);
    assert.equal((await fetch(url + "_diner/state", { method: "POST", headers, body: " ".repeat(Snapshot.MAX_BYTES + 5000) })).status, 413);
    assert.equal((await post({ op: "claim", owner, revision: 0 })).status, 200);
    assert.equal((await post({ op: "save", owner, revision: 0, snapshot: snapshot() })).status, 200);
    const otherURL = await host.open("second", { gameId: "game" });
    const otherConfig = await (await fetch(otherURL + "_diner/config")).json();
    assert.equal((await fetch(otherURL + "_diner/state", { method: "POST",
        headers: { ...headers, "X-Diner-Capability": otherConfig.capability },
        body: JSON.stringify({ op: "claim", owner: randomUUID(), revision: 1 }) })).status, 409);
    await assert.rejects(host.open("first", { gameId: "different" }), /Close this instance/);
    assert.equal((await fetch(url)).status, 200);
    await host.close("first");
    const restored = await (await fetch(otherURL + "_diner/state", { headers: { "X-Diner-Capability": otherConfig.capability } })).json();
    assert.deepEqual(restored.snapshot, snapshot());
    assert.equal(restored.busy, false);
    await writeFile(join(stateDirectory, "game.json"), "{bad");
    assert.equal((await fetch(otherURL + "_diner/state", { headers: { "X-Diner-Capability": otherConfig.capability } })).status, 500);
});
