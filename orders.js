// Mo's Diner menu loader. Editable dish data lives in menu.json.
(function (root) {
  function assert(condition, message) {
    if (!condition) throw new Error(`Invalid menu.json: ${message}`);
  }
  function sanitizeText(value, context, max = 160) {
    assert(typeof value === "string", `${context} must be a string`);
    const text = value.normalize("NFKC")
      .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g, " ")
      .replace(/\s+/g, " ").trim();
    assert(text.length > 0 && text.length <= max, `${context} must contain 1-${max} safe characters`);
    return text;
  }
  function sanitizePromptText(value, context) {
    const text = sanitizeText(value, context, 80);
    assert(!/[`@<>{}\[\]]/.test(text), `${context} contains unsafe prompt characters`);
    return text;
  }
  function sanitizeStringArray(values, context, max = 160) {
    assert(Array.isArray(values) && values.length, `${context} must be a non-empty array`);
    return values.map((value, index) => sanitizeText(value, `${context}[${index}]`, max));
  }
  function compileChecks(checks, context) {
    assert(checks && typeof checks === "object" && !Array.isArray(checks), `${context}.checks is required`);
    assert(typeof checks.ingredient === "string" && /^[a-z0-9-]+$/.test(checks.ingredient), `${context}.checks.ingredient must be a package id`);
    assert(Array.isArray(checks.prep) && checks.prep.length === 2, `${context}.checks.prep must be a command/message pair`);
    assert(checks.test && typeof checks.test === "object", `${context}.checks.test is required`);
    const test = {};
    for (const key of ["t", "exp", "at", "file", "what", "bad"]) {
      test[key] = sanitizeText(checks.test[key], `${context}.checks.test.${key}`, 160);
    }
    return {
      ingredient: checks.ingredient,
      prep: checks.prep.map((value, index) => sanitizeText(value, `${context}.checks.prep[${index}]`, 160)),
      test,
    };
  }
  function compilePattern(pattern, context) {
    const safePattern = sanitizeText(pattern, `${context} pattern`, 200);
    try { return new RegExp(safePattern, "i"); }
    catch (error) { throw new Error(`Invalid menu.json: ${context} pattern "${safePattern}": ${error.message}`); }
  }
  function compile(data) {
    assert(data && Array.isArray(data.dishes), "dishes must be an array");
    assert(Array.isArray(data.customers) && data.customers.length >= 6, "customers must contain at least 6 entries");
    const customers = data.customers.map((customer, index) => {
      assert(Array.isArray(customer) && customer.length === 2, `customers[${index}] must be a name/emoji pair`);
      return [
        sanitizeText(customer[0], `customers[${index}][0]`, 40),
        sanitizeText(customer[1], `customers[${index}][1]`, 16),
      ];
    });
    const greetings = sanitizeStringArray(data.greetings, "greetings", 80);
    const sauces = data.sauces ?? [];
    assert(Array.isArray(sauces), "sauces must be an array");
    const sauceIds = new Set();
    for (const [index, sauce] of sauces.entries()) {
      const context = `sauces[${index}]`;
      assert(sauce && typeof sauce.id === "string" && /^[a-z0-9-]+$/.test(sauce.id), `${context}.id must be kebab-case`);
      assert(!sauceIds.has(sauce.id), `duplicate sauce id "${sauce.id}"`);
      sauceIds.add(sauce.id);
      sanitizePromptText(sauce.alt, `${context}.alt`);
      sanitizeText(sauce.emoji, `${context}.emoji`, 16);
      sanitizeText(sauce.to, `${context}.to`, 120);
      sanitizeText(sauce.say, `${context}.say`, 120);
      assert(Array.isArray(sauce.patterns) && sauce.patterns.length, `${context}.patterns must be a non-empty array`);
      sauce.patterns.forEach(pattern => compilePattern(pattern, context));
    }
    const dishIds = new Set();
    const dishes = data.dishes.map((dish, dishIndex) => {
      const context = `dishes[${dishIndex}]`;
      assert(dish && typeof dish.id === "string" && /^[a-z0-9-]+$/.test(dish.id), `${context}.id must be kebab-case`);
      assert(!dishIds.has(dish.id), `duplicate dish id "${dish.id}"`);
      dishIds.add(dish.id);
      const name = sanitizePromptText(dish.name, `${context}.name`);
      const emoji = sanitizeText(dish.emoji, `${context}.emoji`, 16);
      const category = dish.category === undefined ? "Dishes" : sanitizePromptText(dish.category, `${context}.category`);
      assert(dish.art === null || (typeof dish.art === "string" && /^[a-z0-9-]+$/.test(dish.art)), `${context}.art must be an asset id or null`);
      assert(dish.sauces === undefined || typeof dish.sauces === "boolean", `${context}.sauces must be a boolean`);
      const checks = compileChecks(dish.checks, context);
      const say = sanitizeStringArray(dish.say, `${context}.say`, 120);
      assert(Array.isArray(dish.steps) && dish.steps.length >= 2 && dish.steps.every(step =>
        Array.isArray(step) && step.length === 2 && step.every(value => typeof value === "string" && value.length)), `${context}.steps must contain emoji/title pairs`);
      const additions = dish.sauces ? sauces.filter(sauce => sauce.enabled !== false) : [];
      const recipe = [...dish.steps, ...additions.map(sauce => [sauce.emoji, `Serve without ${sauce.alt}`])];
      const steps = recipe.map((step, index) => [
        sanitizeText(step[0], `${context}.steps[${index}][0]`, 16),
        sanitizeText(step[1], `${context}.steps[${index}][1]`, 120),
      ]);
      assert(Array.isArray(dish.options), `${context}.options must be an array`);
      const optionIds = new Set();
      const options = [...dish.options.map(option => ({ ...option, addon: false })),
        ...additions.map((sauce, index) => ({ ...sauce, step: dish.steps.length + index, addon: true }))];
      const allOptions = options.map((option, optionIndex) => {
        const optionContext = `${context}.options[${optionIndex}]`;
        assert(option && typeof option.id === "string" && /^[a-z0-9-]+$/.test(option.id), `${optionContext}.id must be kebab-case`);
        assert(!optionIds.has(option.id), `duplicate option id "${option.id}"`);
        optionIds.add(option.id);
        const alt = sanitizePromptText(option.alt, `${optionContext}.alt`);
        assert(Number.isInteger(option.step) && option.step >= 0 && option.step < steps.length, `${optionContext}.step is out of range`);
        const to = sanitizeText(option.to, `${optionContext}.to`, 120);
        const optionSay = sanitizeText(option.say, `${optionContext}.say`, 120);
        assert(Array.isArray(option.patterns) && option.patterns.length, `${optionContext}.patterns must be a non-empty array`);
        const patterns = option.patterns.map(pattern => sanitizeText(pattern, `${optionContext}.patterns`, 200));
        return { ...option, alt, to, say: optionSay, patterns,
          re: new RegExp(patterns.map(pattern => `(?:${compilePattern(pattern, optionContext).source})`).join("|"), "i") };
      });
      const opts = allOptions.filter(option => option.enabled !== false);
      assert(new Set(opts.map(option => option.step)).size === opts.length, `${context} enabled options must target different steps`);
      assert(Array.isArray(dish.patterns) && dish.patterns.length, `${context}.patterns must be a non-empty array`);
      const patterns = dish.patterns.map(pattern => sanitizeText(pattern, `${context}.patterns`, 200));
      return { ...dish, name, emoji, category, checks, say, steps, recipeSteps: dish.steps.length, opts, patterns,
        re: new RegExp(patterns.map(pattern => `(?:${compilePattern(pattern, context).source})`).join("|"), "i") };
    });
    const menu = dishes.filter(dish => dish.enabled !== false);
    assert(menu.length >= 1, "at least 1 dish must be enabled");
    return { MENU: menu, DISHES: dishes, CUSTOMERS: customers, HELLO: greetings };
  }

  if (typeof module !== "undefined" && module.exports) {
    const api = compile(require("./menu.json"));
    module.exports = { ...api, compile };
    return;
  }

  async function load() {
    if (location.protocol === "file:") {
      if (!root.DinerMenuData) throw new Error("Could not load the standalone menu data.");
      return compile(root.DinerMenuData);
    }
    const response = await fetch("menu.json", { cache: "no-store" });
    if (!response.ok) throw new Error(`Could not load menu.json (${response.status}).`);
    return compile(await response.json());
  }
  root.Menu = { ready: load() };
})(typeof window === "undefined" ? globalThis : window);
