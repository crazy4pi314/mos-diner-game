# Agent instructions

## Project and scope

Mo's Diner is a self-contained JavaScript browser game with an optional Copilot
canvas host. Read `README.md`, `CONTRIBUTING.md`, and `docs/DEVELOPMENT.md` before
changing the relevant behavior. Keep changes focused; preserve unrelated work.
Use diner-themed welcoming copy, but keep technical instructions and policies
straightforward.

Public installation instructions must use the GitHub Copilot app canvas only.
Direct-file browser support remains a developer regression-test target, not an
alternative player installation path.

There is no package manifest or dependency installation step. Development uses
Node.js 22 or newer and built-in modules; browser checks use Microsoft Edge.
Do not introduce a framework, build pipeline, or runtime dependency for a change
that can use the existing structure.

## Source map

- `index.html` and the stylesheets: UI and layouts.
- `game.js`: shift, customers, rendering, and interaction.
- `menu.json`: menu source; `menu-file.js` is generated, not manually edited.
- `orders.js`, `copilot.js`, `checks.js`: menu compilation, deterministic
  interpretation, plan generation, and simulated checks.
- `lifecycle.js`, `snapshot.js`: controller lifecycle and snapshot validation.
- `live-plan.js`: shared model-result validation.
- `.github/extensions/mos-diner/extension.mjs`: canvas registration.
- `.github/extensions/mos-diner/hosting.mjs`, `state.mjs`: loopback hosting,
  asset allowlist, persistence, and leases.
- `.github/extensions/mos-diner/model.mjs`: isolated, non-production model
  integration; it must not be wired into ordinary gameplay.

## Invariants

- Standalone play must work by opening `index.html` directly, offline.
- Ordinary gameplay remains deterministic and local, without model calls,
  Copilot usage, real pull requests, or external network dependencies.
- Keep user approval before cooking and explicit Start/Resume behavior.
  Hidden or clipped canvases must pause; never advance offline time or silently
  restore old shifts.
- Preserve reduced-motion support and keyboard access. CSS and navigation
  must agree on responsive breakpoints.
- Add canvas-served assets explicitly to `hosting.mjs`'s allowlist. Preserve
  real-path checks, request capabilities, origin validation, schema validation,
  body limits, and exclusive controller ownership.
- Surface load/save failures; do not replace corrupt state with empty success.
  Do not remove locks without confirming that their recorded process is dead.
- Keep font license notices and distinguish project licensing from branding
  rights. Never include tokens, private session data, or personal paths in docs.

After menu changes, run `node scripts\build-menu-file.mjs` and include
`menu-file.js`. Frontend edits need a page refresh; extension or menu changes
also need an extension reload in a compatible host.

## Validation and handoff

Run the smallest applicable checks from the repository root:

```powershell
node --test .github\extensions\mos-diner\menu.test.mjs
node --test .github\extensions\mos-diner\extension.test.mjs .github\extensions\mos-diner\hosting.test.mjs .github\extensions\mos-diner\lifecycle.test.mjs
node --test .github\extensions\mos-diner\model.test.mjs
node --test --test-timeout=240000 .github\extensions\mos-diner\browser.test.mjs
git diff --check
```

Select relevant suites; do not run the browser and model suites concurrently.
If Edge is not detected, set `DINER_EDGE` to its executable path. Report skips
and unverified native-host behavior explicitly. Documentation-only edits do not
need game tests; check relative links and command accuracy.

Use `.github/pull_request_template.md` for PRs. Record exact validation commands
and outcomes, and include screenshots when useful for visible changes. Update
directly affected docs. Do not change repository settings, publish, or create
a release unless requested.
