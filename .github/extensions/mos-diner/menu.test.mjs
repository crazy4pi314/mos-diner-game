import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import vm from "node:vm";

const require = createRequire(import.meta.url);
const Menu = require("../../../orders.js");
const source = JSON.parse(await readFile(new URL("../../../menu.json", import.meta.url), "utf8"));

test("menu JSON enables only the pun dishes and compiles prompt patterns", () => {
    assert.equal(Menu.MENU.length, 4);
    assert.deepEqual(Menu.MENU.map(dish => dish.name), [
        "Full-Stack Pancakes", "Raspberry Pi à la Mode", "Browser Cookies", "SHA-256 Hash Browns",
    ]);
    const cookies = Menu.MENU.find(dish => dish.id === "browser-cookies");
    assert.ok(cookies.re.test("browser cookies"));
    assert.deepEqual(cookies.opts.filter(option => option.re.test("fork the batch and make them headless")).map(option => option.id),
        ["fork-batch", "headless"]);
    assert.equal(Menu.MENU.find(dish => dish.id === "full-stack-pancakes").opts
        .find(option => option.id === "async-syrup").re.test("syrup async"), true);
    assert.equal(Menu.MENU.find(dish => dish.id === "sha256-hash-browns").re.test("hash browns"), true);
    assert.equal(cookies.checks.ingredient, "all-purpose-flour");
    assert.match(cookies.checks.test.bad, /cookies/);
});

test("dish and option enabled flags remove items without editing application code", () => {
    const changed = structuredClone(source);
    changed.dishes.find(dish => dish.id === "sha256-hash-browns").enabled = false;
    changed.dishes.find(dish => dish.id === "full-stack-pancakes").options.find(option => option.id === "scale-out").enabled = false;
    changed.dishes.find(dish => dish.id === "browser-cookies").options.forEach(option => { option.enabled = false; });
    const compiled = Menu.compile(changed);
    assert.equal(compiled.MENU.some(dish => dish.id === "sha256-hash-browns"), false);
    assert.equal(compiled.MENU.find(dish => dish.id === "full-stack-pancakes").opts.some(option => option.id === "scale-out"), false);
    assert.deepEqual(compiled.MENU.find(dish => dish.id === "browser-cookies").opts, []);
});

test("standalone menu fallback is generated from the JSON source", async () => {
    const expected = `// Generated from menu.json by scripts/build-menu-file.mjs. Do not edit directly.\nwindow.DinerMenuData = ${JSON.stringify(source)};\n`;
    const actual = (await readFile(new URL("../../../menu-file.js", import.meta.url), "utf8")).replace(/\r\n/g, "\n");
    assert.equal(actual, expected);
});

test("menu compiler validates customer pairs and sanitizes model-facing text", () => {
    const malformed = structuredClone(source);
    malformed.customers[0] = ["@name"];
    assert.throws(() => Menu.compile(malformed), /name\/emoji pair/);

    const unsafe = structuredClone(source);
    unsafe.dishes[0].name = "Pancakes\n@system";
    assert.throws(() => Menu.compile(unsafe), /unsafe prompt characters/);

    const invisible = structuredClone(source);
    invisible.greetings[0] = "Hello\u202e there";
    assert.equal(Menu.compile(invisible).HELLO[0], "Hello there");
});

test("menu readiness failures disable Start and show a visible error", async () => {
    const game = await readFile(new URL("../../../game.js", import.meta.url), "utf8");
    const nodes = {
        "#info-dialog": { open: false, showModal() { this.open = true; } },
        "#lifecycle-message": { textContent: "" },
        "#lifecycle-status": { hidden: true },
        "#start-shift": { disabled: false },
    };
    vm.runInNewContext(game, {
        window: {
            Menu: { ready: Promise.reject(new Error("broken menu")) },
            Copilot: { ready: Promise.resolve() },
            DinerLivePlan: { ready: Promise.resolve() },
        },
        document: { querySelector: selector => nodes[selector] },
        console: { error() {} },
        Promise,
    });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(nodes["#start-shift"].disabled, true);
    assert.equal(nodes["#lifecycle-status"].hidden, false);
    assert.equal(nodes["#info-dialog"].open, true);
    assert.match(nodes["#lifecycle-message"].textContent, /broken menu/);
});
