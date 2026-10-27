// Copilot, the cook: reads your prompt, proposes a plan (calling out what it assumed),
// and builds exactly what the approved plan says. It never guesses details you didn't give it.
(function (root) {
  function create({ MENU, DISHES = MENU }) {
    const dishOf = id => DISHES.find(d => d.id === id) || null;
    const promptTextPart = value => String(value).normalize("NFKC")
      .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff`@<>{}\[\]]/g, " ")
      .replace(/\s+/g, " ").trim();

    // Free-typed prompt → { dish, opts }. Chips write the same text, so both paths agree.
    function parse(text) {
      const dish = MENU.find(d => d.re.test(text)) || null;
      const opts = dish ? dish.opts.filter(o => o.re.test(text)).map(o => o.id) : [];
      return { dish: dish && dish.id, opts };
    }
    function promptText(dishId, opts) {
      const d = dishOf(dishId);
      if (!d) return "";
      const alts = d.opts.filter(o => opts.includes(o.id)).map(o => promptTextPart(o.alt));
      return `@copilot one ${promptTextPart(d.name).toLowerCase()}${alts.length ? ", " + alts.join(", ") : ""}`;
    }

    // The plan: one PR per step. `set` = option ids turned on; `asked` = ids that came from your prompt.
    function plan(dishId, set) {
      const d = dishOf(dishId);
      return d.steps.map(([emoji, title], i) => {
        const o = d.opts.find(x => x.step === i);
        const on = !!o && set.includes(o.id);
        return { i, emoji, title: on ? o.to : title, opt: o ? o.id : null, on };
      });
    }

    // What the customer actually wants vs. what the plan will make.
    function diff(order, set) {
      const d = dishOf(order.want.dish);
      if (order.dish !== order.want.dish) return { dish: true, opts: [] };
      return { dish: false, opts: d.opts.filter(o => set.includes(o.id) !== order.want.opts.includes(o.id)) };
    }
    return { MENU, DISHES, dishOf, parse, promptText, plan, diff };
  }

  const source = root.Menu || require("./orders.js");
  const api = {};
  if (source.ready) api.ready = source.ready.then(data => Object.assign(api, create(data)));
  else Object.assign(api, create(source));
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.Copilot = api;
})(typeof window === "undefined" ? globalThis : window);
