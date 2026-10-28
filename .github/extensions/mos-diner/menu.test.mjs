import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import vm from "node:vm";
import { access } from "node:fs/promises";

const require = createRequire(import.meta.url);
const Menu = require("../../../orders.js");
const Copilot = require("../../../copilot.js");
const source = JSON.parse(await readFile(new URL("../../../menu.json", import.meta.url), "utf8"));

test("menu enables only the three breakfast dishes", () => {
    assert.equal(Menu.MENU.length, 3);
    assert.deepEqual(Menu.MENU.map(dish => dish.name), [
        "Stacked PR Pancakes",
        "Eggs your way with Copilot code review", "Bacon, eggs, and balanced code reviews",
    ]);
    assert.deepEqual([...new Set(Menu.MENU.map(dish => dish.category))],
        ["All Day Breakfast"]);
    for (const dish of Menu.MENU) {
        assert.equal(dish.opts.filter(option => !option.addon).length, 3, dish.id);
        assert.equal(Menu.MENU.filter(item => item.category === dish.category).length, 3);
    }
});

test("disabled categories cannot be ordered through typed prompts or model plans", () => {
    const LivePlan = require("../../../live-plan.js");
    const disabled = Menu.DISHES.filter(dish => dish.enabled === false);
    assert.equal(disabled.length, 12);
    for (const dish of disabled) {
        for (const text of [dish.name, ...dish.say]) {
            assert.deepEqual(Copilot.parse(text), { dish: null, opts: [] }, text);
        }
        assert.throws(() => LivePlan.validate({ dish: dish.id, opts: [], note: "" }), /invalid menu plan/);
    }
});

test("every dish, customer phrase and option combination parses without collisions", () => {
    for (const dish of Menu.MENU) {
        for (let mask = 0; mask < 2 ** dish.opts.length; mask++) {
            const options = dish.opts.filter((_, index) => mask & (1 << index));
            const expected = { dish: dish.id, opts: options.map(option => option.id) };
            const prompt = Copilot.promptText(dish.id, expected.opts);
            assert.deepEqual(Copilot.parse(prompt), expected, prompt);
            for (const name of dish.say) {
                const request = `${name}, ${options.map(option => option.say).join(" and ")}`;
                assert.deepEqual(Copilot.parse(request), expected, request);
            }
        }
        for (const option of dish.opts) {
            const changed = Copilot.plan(dish.id, [option.id])[option.step];
            assert.equal(changed.title, option.to);
            assert.notEqual(changed.title, dish.steps[option.step][1]);
        }
    }
});

test("breakfast dishes have no sauce options, requests, or cooking steps", () => {
    const LivePlan = require("../../../live-plan.js");
    for (const dish of Menu.MENU) {
        assert.equal(dish.opts.length, 3);
        assert.ok(dish.opts.every(option => !option.addon));
        assert.equal(dish.steps.length, 4);
        assert.equal(Copilot.cookingPlan(dish.id, []).length, 4);
        for (const sauce of source.sauces) {
            assert.deepEqual(Copilot.parse(`${dish.name}, ${sauce.alt}`), { dish: dish.id, opts: [] });
            assert.throws(() => LivePlan.validate({ dish: dish.id, opts: [sauce.id], note: "" }), /invalid menu plan/);
        }
    }
});

test("shared sauce support remains available if explicitly re-enabled in menu data", () => {
    const enabled = structuredClone(source);
    enabled.sauces.forEach(sauce => { sauce.enabled = true; });
    const compiled = Menu.compile(enabled);
    const sauceIds = source.sauces.map(sauce => sauce.id);
    assert.equal(sauceIds.length, 3);
    for (const dish of compiled.MENU) {
        assert.deepEqual(dish.opts.filter(option => option.addon).map(option => option.id), sauceIds);
        assert.equal(dish.steps.length, 7);
    }
    assert.ok(sauceIds.every(id => !Menu.MENU.some(dish => dish.id === id)));
});

test("every configured illustration and intermediate plating asset exists", async () => {
    for (const dish of Menu.MENU.filter(dish => dish.art)) {
        await access(new URL(`../../../assets/food/${dish.art}.svg`, import.meta.url));
        for (let step = 1; step < dish.recipeSteps; step++) {
            await access(new URL(`../../../assets/food/plating/${dish.art}-${step}.svg`, import.meta.url));
        }
    }
});

test("dish and option enabled flags remove items without editing application code", () => {
    const changed = structuredClone(source);
    changed.dishes.find(dish => dish.id === "bacon-eggs-balanced-reviews").enabled = false;
    changed.dishes.find(dish => dish.id === "stacked-pr-pancakes").options.find(option => option.id === "stack-another-commit").enabled = false;
    const eggs = changed.dishes.find(dish => dish.id === "eggs-your-way");
    eggs.options.forEach(option => { option.enabled = false; });
    eggs.sauces = false;
    changed.sauces[0].enabled = false;
    const compiled = Menu.compile(changed);
    assert.equal(compiled.MENU.some(dish => dish.id === "bacon-eggs-balanced-reviews"), false);
    assert.equal(compiled.MENU.find(dish => dish.id === "stacked-pr-pancakes").opts.some(option => option.id === "stack-another-commit"), false);
    assert.deepEqual(compiled.MENU.find(dish => dish.id === "eggs-your-way").opts, []);
    assert.ok(compiled.MENU.every(dish => !dish.opts.some(option => option.id === changed.sauces[0].id)));
    assert.equal(compiled.MENU.find(dish => dish.id === "bacon-eggs-balanced-reviews"), undefined);
    assert.equal(compiled.MENU.find(dish => dish.id === "stacked-pr-pancakes").steps.length, 4);
});

test("menu compiler rejects invalid categories, sauce definitions and option step collisions", () => {
    for (const change of [
        menu => { menu.dishes[0].category = "<unsafe>"; },
        menu => { menu.dishes[0].sauces = "yes"; },
        menu => { menu.sauces = {}; },
        menu => { menu.sauces.push(structuredClone(menu.sauces[0])); },
        menu => { menu.sauces[0].patterns = ["["]; },
        menu => { menu.sauces[0].alt = "@unsafe"; },
        menu => { menu.sauces[0].emoji = ""; },
        menu => { menu.sauces[0].enabled = true; menu.dishes[0].options[0].id = menu.sauces[0].id; },
        menu => { menu.dishes[0].options[1].step = menu.dishes[0].options[0].step; },
    ]) {
        const changed = structuredClone(source);
        change(changed);
        assert.throws(() => Menu.compile(changed), /Invalid menu.json/);
    }
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
