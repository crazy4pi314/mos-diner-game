import { mkdir, readFile, writeFile, rename, unlink, open, lstat } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import Snapshot from "../../../snapshot.js";

export const LEASE_MS = 8000;
export const validGameId = id => typeof id === "string" && /^[a-z0-9_-]{1,64}$/.test(id);
export class StateError extends Error {
    constructor(status, message) { super(message); this.status = status; }
}
export function createStateStore(directory, now = Date.now) {
    async function read(path) {
        try {
            const info = await lstat(path);
            if (!info.isFile() || info.isSymbolicLink() || info.size > Snapshot.MAX_BYTES + 4096) {
                throw new Error("Invalid diner state file.");
            }
            const data = JSON.parse(await readFile(path, "utf8"));
            if (data.version !== 1 || !Number.isInteger(data.revision) || data.revision < 0 ||
                !(data.owner === null || (typeof data.owner === "string" && Number.isFinite(data.expires)))) {
                throw new Error("Unsupported or corrupt diner state file.");
            }
            if (data.snapshot !== null) Snapshot.validate(data.snapshot);
            return data;
        } catch (error) {
            if (error.code === "ENOENT") return { version: 1, revision: 0, owner: null, expires: 0, snapshot: null };
            throw error;
        }
    }
    async function transaction(id, action) {
        if (!validGameId(id)) throw new StateError(400, "Invalid game ID.");
        await mkdir(directory, { recursive: true, mode: 0o700 });
        const path = join(directory, `${id}.json`), lock = join(directory, `${id}.lock`);
        let handle;
        for (let attempt = 0; attempt < 100; attempt++) {
            try {
                handle = await open(lock, "wx", 0o600);
                await handle.writeFile(String(process.pid));
                break;
            } catch (error) {
                if (handle) {
                    await handle.close();
                    await unlink(lock);
                    throw error;
                }
                if (error.code !== "EEXIST") throw error;
                const pid = Number(await readFile(lock, "utf8").catch(e => {
                    if (e.code === "ENOENT") return process.pid;
                    throw e;
                }));
                if (Number.isInteger(pid) && pid > 0) {
                    try { process.kill(pid, 0); }
                    catch (e) {
                        if (e.code !== "ESRCH") throw e;
                        // Never race another provider by removing its newly-acquired lock.
                        throw new StateError(503, `Diner writer (PID ${pid}) stopped during a transaction. After confirming that PID is no longer running, remove only ${id}.lock from the diner state directory and reload.`);
                    }
                }
                await new Promise(resolve => setTimeout(resolve, 10));
            }
        }
        if (!handle) throw new StateError(503, "Diner state is busy. Retry shortly.");
        const temp = `${path}.${randomUUID()}.tmp`;
        try {
            const data = await read(path);
            const result = await action(data);
            if (result.write) {
                await writeFile(temp, JSON.stringify(data), { mode: 0o600, flag: "wx" });
                await rename(temp, path);
            }
            return { revision: data.revision, snapshot: data.snapshot, ...result.value };
        } finally {
            try {
                await unlink(temp).catch(e => { if (e.code !== "ENOENT") throw e; });
            } finally {
                await handle.close();
                await unlink(lock);
            }
        }
    }
    return {
        checkOrder: (id, owner, orderId) => transaction(id, data => {
            if (data.owner !== owner || data.expires <= now()) {
                throw new StateError(409, "Resume this shift before asking Copilot.");
            }
            const order = data.snapshot?.state.orders.find(o => o.id === orderId);
            if (data.snapshot?.state.phase !== "shift" || !order ||
                !["ordering", "returned"].includes(order.status) || order.dish !== null) {
                throw new StateError(409, "This order is no longer accepting prompts.");
            }
            return {};
        }),
        load: id => transaction(id, data => ({ value: { busy: data.owner !== null && data.expires > now() } })),
        claim: (id, owner, revision) => transaction(id, data => {
            if (data.owner !== null && data.expires > now() && data.owner !== owner) {
                throw new StateError(409, "This game is controlled by another view. Pause or close that view first.");
            }
            if (revision !== data.revision) throw new StateError(409, "This game changed in another view. Reload before resuming.");
            data.owner = owner; data.expires = now() + LEASE_MS;
            return { write: true };
        }),
        save: (id, owner, revision, snapshot, release = false) => transaction(id, data => {
            if (data.owner !== owner || data.expires <= now() || revision !== data.revision) {
                throw new StateError(409, "Diner control expired or changed. Reload to restore the latest paused shift.");
            }
            Snapshot.validate(snapshot);
            // Lease refresh still persists expires. Identical game state must not bump revision.
            if (JSON.stringify(data.snapshot) !== JSON.stringify(snapshot)) {
                data.snapshot = snapshot;
                data.revision++;
            }
            data.owner = release ? null : owner;
            data.expires = release ? 0 : now() + LEASE_MS;
            return { write: true };
        }),
        release: (id, owner) => transaction(id, data => {
            if (data.owner !== owner) return {};
            data.owner = null; data.expires = 0;
            return { write: true };
        }),
    };
}
