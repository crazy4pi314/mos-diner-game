(function (root) {
  const MAX_PROMPT = 2000;
  function create({ MENU }) {
    const schema = {
      type: "object", additionalProperties: false, required: ["dish", "opts", "note"],
      properties: {
        dish: { type: "string", enum: MENU.map(d => d.id) },
        opts: { type: "array", items: { type: "string", enum: MENU.flatMap(d => d.opts.map(o => o.id)) } },
        note: { type: "string" },
      },
    };
    function validate(value) {
      const d = value && MENU.find(d => d.id === value.dish);
      if (!d || Object.keys(value).sort().join(",") !== "dish,note,opts" ||
          !Array.isArray(value.opts) || new Set(value.opts).size !== value.opts.length ||
          !value.opts.every(id => d.opts.some(o => o.id === id)) ||
          typeof value.note !== "string" || value.note.length > 300 || /[<>\u0000-\u001f]/.test(value.note)) {
        throw new Error("Copilot returned an invalid menu plan. Edit the prompt and retry, or use deterministic mode.");
      }
      return { dish: d.id, opts: [...value.opts], note: value.note };
    }
    return { schema, validate };
  }
  function validatePrompt(text) {
    if (typeof text !== "string" || !text.trim() || text.length > MAX_PROMPT) {
      throw new Error(`Enter a prompt of 1-${MAX_PROMPT} characters.`);
    }
    return text.trim();
  }
  const source = root.Menu || require("./orders.js");
  const api = { validatePrompt, MAX_PROMPT };
  if (source.ready) api.ready = source.ready.then(data => Object.assign(api, create(data)));
  else Object.assign(api, create(source));
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.DinerLivePlan = api;
})(typeof window === "undefined" ? globalThis : window);
