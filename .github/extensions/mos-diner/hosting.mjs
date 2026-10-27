import { createServer } from "node:http";
import { open, realpath, stat } from "node:fs/promises";
import { resolve, relative, isAbsolute, extname } from "node:path";
import { homedir } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { createStateStore, validGameId, StateError } from "./state.mjs";
import Snapshot from "../../../snapshot.js";
import LivePlan from "../../../live-plan.js";

export const inputSchema = {
    type: ["object", "null"],
    additionalProperties: false,
    properties: {
        view: { type: "string", enum: ["hub", "classic"], default: "hub" },
        skin: { type: "string", enum: ["default", "cozy"], default: "default" },
        gameId: { type: "string", pattern: "^[a-z0-9_-]{1,64}$", default: "default" },
        inputMode: { type: "string", enum: ["deterministic"], default: "deterministic" },
    },
};

export const publicFiles = new Set([
    "index.html", "styles.css", "theme-cozy.css", "theme-hub.css", "menu.json",
    "menu-file.js", "orders.js", "copilot.js", "checks.js", "game.js", "snapshot.js", "lifecycle.js", "live-plan.js",
    "assets/copilot-chef.png", "assets/checker-icon.svg", "assets/invertocat-pink.svg", "assets/mos-logo.svg", "assets/mos-mark.svg", "assets/mos-lockup.svg", "assets/mos-badge.svg", "assets/mos-cert-logo.svg",
    "assets/fonts/mona-sans-medium.woff2", "assets/fonts/OFL.txt",
    "assets/fonts/fredoka-latin.woff2", "assets/fonts/fredoka-latin-ext.woff2",
    "assets/fonts/fredoka-hebrew.woff2", "assets/fonts/Fredoka-OFL.txt",
    "assets/fonts/dm-mono-latin.woff2", "assets/fonts/dm-mono-latin-ext.woff2",
    "assets/fonts/DM-Mono-OFL.txt",
    "assets/diner/cash.svg", "assets/diner/coffee.svg", "assets/diner/condiments.svg",
    "assets/diner/napkins.svg", "assets/diner/plate.svg", "assets/diner/splatter.svg",
    "assets/food/burger.svg", "assets/food/eggs.svg", "assets/food/grilled-cheese.svg",
    "assets/food/pancakes.svg", "assets/food/pie.svg", "assets/food/shake.svg",
    "assets/food/plating/plate.svg", "assets/food/plating/qc.svg", "assets/food/plating/qc-fail.svg",
    "assets/food/plating/burger-1.svg", "assets/food/plating/burger-2.svg",
    "assets/food/plating/burger-3.svg", "assets/food/plating/burger-4.svg",
    "assets/food/plating/eggs-1.svg", "assets/food/plating/eggs-2.svg", "assets/food/plating/eggs-3.svg",
    "assets/food/plating/grilled-cheese-1.svg", "assets/food/plating/grilled-cheese-2.svg",
    "assets/food/plating/grilled-cheese-3.svg",
    "assets/food/plating/pancakes-1.svg", "assets/food/plating/pancakes-2.svg", "assets/food/plating/pancakes-3.svg",
    "assets/food/plating/pie-1.svg", "assets/food/plating/pie-2.svg", "assets/food/plating/pie-3.svg",
    "assets/food/plating/shake-1.svg", "assets/food/plating/shake-2.svg", "assets/food/plating/shake-3.svg",
]);
const contentTypes = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".woff2": "font/woff2",
    ".txt": "text/plain; charset=utf-8",
};

export function viewQuery(input) {
    if (input != null && (typeof input !== "object" || Array.isArray(input))) {
        throw new TypeError("Open input must be an object or null.");
    }
    const options = input ?? {};
    if (Object.keys(options).some(key => !["view", "skin", "gameId", "inputMode"].includes(key)) ||
        (options.view !== undefined && !["hub", "classic"].includes(options.view)) ||
        (options.skin !== undefined && !["default", "cozy"].includes(options.skin)) ||
        (options.gameId !== undefined && !validGameId(options.gameId)) ||
        (options.inputMode !== undefined && options.inputMode !== "deterministic")) {
        throw new TypeError("Use view: hub/classic, skin: default/cozy, inputMode: deterministic, and a 1-64 character lowercase alphanumeric gameId (hyphens/underscores allowed).");
    }
    const query = new URLSearchParams();
    if (options.view === "classic") query.set("fun", "");
    if (options.skin === "cozy") query.set("skin", "cozy");
    return query.size ? `?${query}` : "";
}

function respond(res, status, message) {
    res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(message);
}

export function createDinerHost(repositoryRoot, options = {}) {
    const entries = new Map();
    const store = createStateStore(options.stateDirectory ?? resolve(homedir(), ".copilot", "mos-diner", "mos-diner-game"));
    let stopped = false;
    const host = {
        onError: (error) => console.error(`Mo's Diner asset server: ${error.message}`),
        async open(instanceId, input) {
            const query = viewQuery(input);
            if (stopped) throw new Error("The diner host has shut down.");
            let entry = entries.get(instanceId);
            if (!entry) {
                entry = startServer(input?.gameId ?? "default");
                entries.set(instanceId, entry);
            }
            try {
                const ready = await entry;
                if (ready.gameId !== (input?.gameId ?? "default")) throw new TypeError("Close this instance before changing gameId.");
                return ready.url + query;
            } catch (error) {
                // Invalid options must not orphan an already-running server.
                if (!(error instanceof TypeError) && entries.get(instanceId) === entry) entries.delete(instanceId);
                throw error;
            }
        },
        async close(instanceId) {
            const entry = entries.get(instanceId);
            if (!entry) return;
            entries.delete(instanceId);
            const ready = await entry;
            await closeServer(ready);
            await Promise.all([...ready.owners].map(owner => store.release(ready.gameId, owner)));
        },
        async shutdown() {
            stopped = true;
            await Promise.all([...entries.keys()].map(id => host.close(id)));
        },
    };
    async function startServer(gameId) {
        const root = await realpath(repositoryRoot);
        const capability = randomUUID(), owners = new Set(), pending = new Set(), requests = new Map();
        const server = createServer((req, res) => {
            res.setHeader("X-Content-Type-Options", "nosniff");
            res.setHeader("Cache-Control", "no-store");
            res.setHeader("Referrer-Policy", "no-referrer");
            res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
            const task = route(req, res).catch(error => {
                host.onError(error);
                if (!res.headersSent) respond(res, error instanceof StateError ? error.status : 500,
                    error instanceof StateError ? error.message : "Could not load or save diner state/assets. No new shift was started.");
                else res.destroy();
            }).finally(() => pending.delete(task));
            pending.add(task);
        });
        async function route(req, res) {
            if (req.headers.host !== `127.0.0.1:${server.address().port}`) {
                return respond(res, 403, "Loopback host required.");
            }
            const origin = `http://127.0.0.1:${server.address().port}`;
            if (req.url?.startsWith("/_diner/") && ((req.headers.origin && req.headers.origin !== origin) ||
                (req.headers["sec-fetch-site"] && !["same-origin", "none"].includes(req.headers["sec-fetch-site"])))) {
                return respond(res, 403, "Same-origin requests required.");
            }
            if (req.url === "/_diner/config" && req.method === "GET") {
                let status = { available: false, message: options.interpret
                    ? "Real Copilot runtime availability is unverified in this host. Deterministic play is ready."
                    : "This canvas uses local deterministic prompts. No model runtime is required." };
                if (options.interpret && options.runtimeStatus) {
                    try { status = await options.runtimeStatus(); }
                    catch (error) {
                        host.onError(error);
                        status = { available: false, message: "Could not check the Copilot CLI executable. Reload to retry; deterministic play is ready." };
                    }
                }
                res.writeHead(200, { "Content-Type": "application/json" });
                return res.end(JSON.stringify({ gameId, capability, copilot: status.available === true, copilotMessage: status.message }));
            }
            if (req.url === "/_diner/plan") {
                if (req.headers["x-diner-capability"] !== capability) return respond(res, 403, "Diner capability required.");
                if (req.method !== "POST") return respond(res, 405, "Method not allowed.");
                if (req.headers["content-type"] !== "application/json") return respond(res, 415, "JSON required.");
                const chunks = []; let bytes = 0;
                for await (const chunk of req) {
                    bytes += chunk.length;
                    if (bytes > 16384) return respond(res, 413, "Prompt request too large.");
                    chunks.push(chunk);
                }
                let body;
                try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
                catch { return respond(res, 400, "Invalid JSON."); }
                if (!body || typeof body.owner !== "string" || !/^[a-f0-9-]{36}$/.test(body.owner) ||
                    typeof body.requestId !== "string" || !/^[a-f0-9-]{36}$/.test(body.requestId) ||
                    Object.keys(body).some(k => !["owner", "requestId", "op", "orderId", "prompt"].includes(k)) ||
                    !["interpret", "cancel"].includes(body.op)) return respond(res, 400, "Invalid plan request.");
                const key = `${body.owner}:${body.requestId}`;
                if (body.op === "cancel") {
                    requests.get(key)?.abort();
                    return respond(res, 200, "Cancelled.");
                }
                if (!options.interpret) return respond(res, 503, "Real Copilot is unavailable. Use deterministic mode.");
                let prompt;
                try { prompt = LivePlan.validatePrompt(body.prompt); }
                catch (error) { return respond(res, 400, error.message); }
                await store.checkOrder(gameId, body.owner, body.orderId);
                if (res.destroyed) return;
                if (requests.size >= 2 || requests.has(key)) return respond(res, 429, "Copilot is busy. Cancel an outstanding request or retry shortly.");
                const abort = new AbortController();
                requests.set(key, abort);
                const disconnected = () => { if (!res.writableEnded) abort.abort(); };
                res.once("close", disconnected);
                try {
                    const plan = LivePlan.validate(await options.interpret(prompt, AbortSignal.any([abort.signal, AbortSignal.timeout(35000)])));
                    abort.signal.throwIfAborted();
                    await store.checkOrder(gameId, body.owner, body.orderId);
                    res.writeHead(200, { "Content-Type": "application/json" });
                    res.end(JSON.stringify(plan));
                } catch (error) {
                    host.onError(error);
                    if (!res.destroyed) respond(res, error instanceof StateError ? error.status : 503,
                        "Copilot could not propose a plan (cancelled, invalid response, or unavailable). Retry or use deterministic mode.");
                } finally {
                    requests.delete(key);
                    res.removeListener("close", disconnected);
                }
                return;
            }
            if (req.url === "/_diner/state") {
                if (req.headers["x-diner-capability"] !== capability) return respond(res, 403, "Diner capability required.");
                let result;
                if (req.method === "GET") result = await store.load(gameId);
                else if (req.method === "POST") {
                    if (req.headers["content-type"] !== "application/json") return respond(res, 415, "JSON required.");
                    const chunks = []; let bytes = 0;
                    for await (const chunk of req) {
                        bytes += chunk.length;
                        if (bytes > Snapshot.MAX_BYTES + 4096) return respond(res, 413, "Snapshot too large.");
                        chunks.push(chunk);
                    }
                    let body;
                    try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
                    catch { return respond(res, 400, "Invalid JSON."); }
                    if (!body || typeof body.owner !== "string" || !/^[a-f0-9-]{36}$/.test(body.owner) ||
                        !Number.isInteger(body.revision) || body.revision < 0 ||
                        !["claim", "save", "release"].includes(body.op)) return respond(res, 400, "Invalid state request.");
                    if (body.op === "claim") {
                        result = await store.claim(gameId, body.owner, body.revision);
                        owners.add(body.owner);
                    } else {
                        try { Snapshot.validate(body.snapshot); }
                        catch (error) { return respond(res, 400, error.message); }
                        result = await store.save(gameId, body.owner, body.revision, body.snapshot, body.op === "release");
                        if (body.op === "release") {
                            owners.delete(body.owner);
                            for (const [key, request] of requests) if (key.startsWith(`${body.owner}:`)) request.abort();
                        }
                    }
                } else return respond(res, 405, "Method not allowed.");
                res.writeHead(200, { "Content-Type": "application/json" });
                return res.end(JSON.stringify(result));
            }
            if (!["GET", "HEAD"].includes(req.method)) {
                res.setHeader("Allow", "GET, HEAD");
                return respond(res, 405, "Method not allowed.");
            }
            // Inspect the raw path, not URL.pathname, which normalizes traversal.
            const rawPath = (req.url ?? "").split("?")[0];
            let path;
            try { path = decodeURIComponent(rawPath); }
            catch { return respond(res, 400, "Malformed path."); }
            if (!path.startsWith("/") || /[\\\0]/.test(path) ||
                path.split("/").some(part => part === "." || part === "..")) {
                return respond(res, 400, "Invalid path.");
            }
            const name = path === "/" ? "index.html" : path.slice(1);
            if (!publicFiles.has(name)) return respond(res, 404, "Not found.");
            const file = resolve(root, name);
            const within = relative(root, file);
            if (within.startsWith("..") || isAbsolute(within)) return respond(res, 403, "Forbidden.");
            try {
                let data = await readPublicFile(file, options.beforeRead);
                if (name === "index.html") data = Buffer.from(data.toString().replace("<head>", '<head><meta name="diner-canvas" content="1" />'));
                else {
                    const etag = `"${createHash("sha256").update(data).digest("hex")}"`;
                    res.setHeader("Cache-Control", "private, no-cache");
                    res.setHeader("ETag", etag);
                    const validators = req.headers["if-none-match"]?.split(",").map(value => value.trim().replace(/^W\//, ""));
                    if (validators?.includes(etag) || validators?.includes("*")) {
                        res.writeHead(304);
                        return res.end();
                    }
                }
                res.writeHead(200, {
                    "Content-Type": contentTypes[extname(file)],
                    "Content-Length": data.length,
                });
                res.end(req.method === "HEAD" ? undefined : data);
            } catch (error) {
                if (["ENOENT", "ENOTDIR"].includes(error.code)) return respond(res, 404, "Not found.");
                if (["EACCES", "EPERM", "ELOOP"].includes(error.code)) return respond(res, 403, "Forbidden.");
                throw error;
            }
        }
        await new Promise((resolve, reject) => {
            server.once("error", reject);
            server.listen(0, "127.0.0.1", resolve);
        });
        server.on("error", error => host.onError(error));
        return { server, gameId, owners, pending, requests, url: `http://127.0.0.1:${server.address().port}/` };
    }
    return host;
}

async function readPublicFile(file, beforeRead) {
    const handle = await open(file, "r");
    try {
        const opened = await handle.stat({ bigint: true });
        const canonical = await realpath(file);
        const current = await stat(file, { bigint: true });
        const sameFile = opened.ino === current.ino &&
            opened.size === current.size &&
            opened.mtimeNs === current.mtimeNs &&
            opened.birthtimeNs === current.birthtimeNs &&
            (current.dev === 0n || opened.dev === current.dev);
        if (!opened.isFile() || canonical !== file || !sameFile) {
            const error = new Error("Asset path changed while opening.");
            error.code = "EACCES";
            throw error;
        }
        await beforeRead?.(file);
        return await handle.readFile();
    } finally {
        await handle.close();
    }
}

async function closeServer({ server, pending, requests }) {
    for (const request of requests.values()) request.abort();
    await new Promise((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve());
        server.closeAllConnections();
    });
    await Promise.all([...pending]);
}
