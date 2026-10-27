import test from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { mkdtemp, mkdir, writeFile, symlink, rename, unlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createDinerHost, publicFiles, viewQuery } from "./hosting.mjs";

const root = fileURLToPath(new URL("../../../", import.meta.url));
function rawRequest(url, path, options = {}) {
    return new Promise((resolve, reject) => {
        const req = request(new URL(url), { path, ...options }, res => {
            const chunks = [];
            res.on("data", chunk => chunks.push(chunk));
            res.on("end", () => resolve({
                status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString(),
            }));
        });
        req.on("error", reject);
        req.end();
    });
}
async function fixture(t, directory = root, options) {
    const host = createDinerHost(directory, options);
    t.after(() => host.shutdown());
    return { host, url: await host.open("test") };
}

test("open input defaults, independent options, and rejection", () => {
    assert.equal(viewQuery(), "");
    assert.equal(viewQuery(null), "");
    assert.equal(viewQuery({ view: "hub", skin: "default" }), "");
    assert.equal(viewQuery({ view: "classic", skin: "cozy" }), "?fun=&skin=cozy");
    assert.equal(viewQuery({ skin: "cozy" }), "?skin=cozy");
    assert.equal(viewQuery({ inputMode: "deterministic" }), "");
    for (const input of [[], "classic", 7, { view: "fun" }, { skin: null }, { inputMode: "copilot" }, { path: "../" }]) {
        assert.throws(() => viewQuery(input), TypeError);
    }
});

test("every allowlisted asset is ready with correct content type; HEAD has no body", async t => {
    const { url } = await fixture(t);
    for (const name of publicFiles) {
        const result = await rawRequest(url, `/${name}`);
        assert.equal(result.status, 200, name);
        const type = name.endsWith(".svg") ? "image/svg+xml" : name.endsWith(".png") ? "image/png"
            : name.endsWith(".woff2") ? "font/woff2" : name.endsWith(".txt") ? "text/plain; charset=utf-8"
            : name.endsWith(".css") ? "text/css; charset=utf-8" : name.endsWith(".json") ? "application/json; charset=utf-8" : name.endsWith(".js")
                ? "text/javascript; charset=utf-8" : "text/html; charset=utf-8";
        assert.equal(result.headers["content-type"], type, name);
        assert.equal(result.headers["x-content-type-options"], "nosniff");
        assert.equal(result.headers["cache-control"], name === "index.html" ? "no-store" : "private, no-cache");
        assert.ok(Number(result.headers["content-length"]) > 0, name);
    }
    const get = await rawRequest(url, "/?skin=cozy");
    const head = await rawRequest(url, "/", { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(head.body, "");
    assert.equal(head.headers["content-length"], get.headers["content-length"]);
    assert.match(get.body, /src="game.js"/);
});

test("raw and encoded traversal, internals, unknown assets, methods, and foreign hosts are denied", async t => {
    const { url } = await fixture(t);
    for (const path of ["/../index.html", "/%2e%2e/index.html", "/assets/../../index.html",
        "/%5cindex.html", "/assets%5cfood%5cburger.svg", "/%00index.html", "/%ZZ"]) {
        assert.equal((await rawRequest(url, path)).status, 400, path);
    }
    for (const path of ["/README.md", "/.git/config", "/.github/extensions/mos-diner/extension.mjs",
        "/mockup/mos-diner-mockup.html", "/assets/private.svg", "/session-state/files/private.txt",
        "//index.html", "/index.html/"]) {
        assert.equal((await rawRequest(url, path)).status, 404, path);
    }
    const post = await rawRequest(url, "/", { method: "POST" });
    assert.equal(post.status, 405);
    assert.equal(post.headers.allow, "GET, HEAD");
    assert.equal((await rawRequest(url, "/", { headers: { host: "attacker.example" } })).status, 403);
});

test("static validators revalidate current files while HTML, APIs and errors stay uncached", async t => {
    const directory = await mkdtemp(join(tmpdir(), "diner-etag-test-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    await writeFile(join(directory, "styles.css"), "body { color: red; }");
    const { host, url } = await fixture(t, directory, { stateDirectory: join(directory, "state") });
    const first = await rawRequest(url, "/styles.css");
    const etag = first.headers.etag;
    assert.match(etag, /^"[a-f0-9]{64}"$/);
    for (const method of ["GET", "HEAD"]) {
        for (const validator of [etag, `W/${etag}`, `"different", ${etag}`, "*"]) {
            const result = await rawRequest(url, "/styles.css", { method, headers: { "If-None-Match": validator } });
            assert.equal(result.status, 304);
            assert.equal(result.body, "");
            assert.equal(result.headers.etag, etag);
        }
    }
    await writeFile(join(directory, "styles.css"), "body { color: blue; }");
    const changed = await rawRequest(url, "/styles.css", { headers: { "If-None-Match": etag } });
    assert.equal(changed.status, 200);
    assert.notEqual(changed.headers.etag, etag);
    assert.match(changed.body, /blue/);
    const head = await rawRequest(url, "/styles.css", { method: "HEAD" });
    assert.equal(head.body, "");
    assert.equal(head.headers["content-length"], changed.headers["content-length"]);
    await unlink(join(directory, "styles.css"));
    const missing = await rawRequest(url, "/styles.css", { headers: { "If-None-Match": changed.headers.etag } });
    assert.equal(missing.status, 404);
    assert.equal(missing.headers["cache-control"], "no-store");
    assert.equal(missing.headers.etag, undefined);
    await writeFile(join(directory, "index.html"), "<head></head>");
    const html = await rawRequest(url, "/", { headers: { "If-None-Match": "*" } });
    assert.equal(html.status, 200);
    assert.equal(html.headers["cache-control"], "no-store");
    assert.equal(html.headers.etag, undefined);
    const config = await rawRequest(url, "/_diner/config", { headers: { "If-None-Match": "*" } });
    assert.equal(config.headers["cache-control"], "no-store");
    assert.equal(config.headers.etag, undefined);
    const capability = JSON.parse(config.body).capability;
    const state = await rawRequest(url, "/_diner/state", { headers: { "X-Diner-Capability": capability, "If-None-Match": "*" } });
    assert.equal(state.status, 200);
    assert.equal(state.headers["cache-control"], "no-store");
    const sibling = await host.open("sibling");
    assert.notEqual(JSON.parse((await rawRequest(sibling, "/_diner/config")).body).capability, capability);
});

test("missing files and symlink/junction redirects cannot expose even in-repository data", async t => {
    const directory = await mkdtemp(join(tmpdir(), "mos-diner-test-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const app = join(directory, "app"), secrets = join(app, "private");
    await mkdir(secrets, { recursive: true });
    await writeFile(join(secrets, "mos-logo.svg"), "not public");
    await symlink(secrets, join(app, "assets"), process.platform === "win32" ? "junction" : "dir");
    const { url } = await fixture(t, app);
    assert.equal((await rawRequest(url, "/index.html")).status, 404);
    assert.equal((await rawRequest(url, "/assets/mos-logo.svg")).status, 403);
    assert.equal((await rawRequest(url, "/assets/mos-logo.svg", { headers: { "If-None-Match": "*" } })).status, 403);
    const outsideApp = join(directory, "other-app");
    await mkdir(outsideApp);
    await symlink(secrets, join(outsideApp, "assets"), process.platform === "win32" ? "junction" : "dir");
    const outside = await fixture(t, outsideApp);
    assert.equal((await rawRequest(outside.url, "/assets/mos-logo.svg")).status, 403);
});

test("path replacement after validation reads only from the validated file handle", async t => {
    const directory = await mkdtemp(join(tmpdir(), "mos-diner-race-test-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const app = join(directory, "app");
    const assets = join(app, "assets");
    const privateAssets = join(directory, "private");
    await mkdir(assets, { recursive: true });
    await mkdir(privateAssets);
    await writeFile(join(assets, "mos-logo.svg"), "public asset");
    await writeFile(join(privateAssets, "mos-logo.svg"), "private asset");
    let attempted = false;
    let replaced = false;
    let replacementBlocked = false;
    const { url } = await fixture(t, app, {
        async beforeRead() {
            if (attempted) return;
            attempted = true;
            try {
                await rename(assets, join(app, "original-assets"));
            } catch (error) {
                if (process.platform !== "win32" || error.code !== "EPERM") throw error;
                replacementBlocked = true;
                return;
            }
            await symlink(privateAssets, assets, process.platform === "win32" ? "junction" : "dir");
            replaced = true;
        },
    });
    const result = await rawRequest(url, "/assets/mos-logo.svg");
    assert.equal(result.status, 200);
    assert.equal(result.body, "public asset");
    assert.ok(replaced || replacementBlocked);
    const next = await rawRequest(url, "/assets/mos-logo.svg", { headers: { "If-None-Match": result.headers.etag } });
    if (replaced) assert.equal(next.status, 403);
    else assert.equal(next.status, 304);
});

test("concurrent opens reuse a port; independent instances and close/reopen clean up", async t => {
    const { host, url } = await fixture(t);
    const urls = await Promise.all(Array.from({ length: 8 }, () => host.open("test")));
    assert.ok(urls.every(value => value === url));
    assert.equal(await host.open("test", { view: "classic" }), url + "?fun=");
    const other = await host.open("other");
    assert.notEqual(other, url);
    await host.close("test");
    await assert.rejects(rawRequest(url, "/"));
    assert.equal((await rawRequest(other, "/")).status, 200);
    await host.close("test");
    const reopened = await host.open("test");
    assert.equal((await rawRequest(reopened, "/")).status, 200);
    await host.shutdown();
    await host.shutdown();
    await assert.rejects(rawRequest(other, "/"));
    await assert.rejects(rawRequest(reopened, "/"));
    await assert.rejects(host.open("late"), /shut down/);
});

test("close while server starts and startup failures do not leak entries", async () => {
    const host = createDinerHost(root);
    const opening = host.open("pending");
    await host.close("pending");
    await assert.rejects(rawRequest(await opening, "/"));
    await host.shutdown();
    const missing = createDinerHost(join(root, "nonexistent-root"));
    await assert.rejects(missing.open("bad"), { code: "ENOENT" });
    await assert.rejects(missing.open("bad"), { code: "ENOENT" });
    await missing.shutdown();
});
