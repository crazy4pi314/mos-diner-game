# Contributing to Mo's Diner

## Local setup

Open `index.html` in a modern browser for standalone play. To work on the canvas
host, open the repository in a Copilot host with project-extension support and
load `.github/extensions/mos-diner/`.

Development scripts and tests use Node.js with built-in modules; no dependency
installation is required. The browser integration suite also needs Microsoft
Edge. If Edge is installed outside its usual location, set `DINER_EDGE` to its
executable path.

## Making changes

- Keep changes focused and update documentation when behavior changes.
- Treat `menu.json` as the menu source. After editing it, run
  `node scripts\build-menu-file.mjs` and include the generated `menu-file.js`.
- Add new canvas-served assets to the explicit allowlist in
  `.github/extensions/mos-diner/hosting.mjs`.
- Keep gameplay local and deterministic. Do not introduce model calls or
  external network dependencies as part of ordinary play.
- Preserve explicit Start/Resume behavior, hidden-canvas pausing, and
  reduced-motion support when changing UI or timing.
- Preserve the license notices shipped with fonts and other third-party assets.

Frontend edits need a page refresh. Changes to extension modules or menu data
also require an extension reload; a page refresh alone will not reload host
modules.

## Checking your work

Run the suites relevant to your change. For menu changes:

```powershell
node --test .github\extensions\mos-diner\menu.test.mjs
```

For canvas hosting, persistence, or lifecycle changes:

```powershell
node --test .github\extensions\mos-diner\extension.test.mjs .github\extensions\mos-diner\hosting.test.mjs .github\extensions\mos-diner\lifecycle.test.mjs
```

For the isolated model boundary (no paid model calls):

```powershell
node --test .github\extensions\mos-diner\model.test.mjs
```

For gameplay, rendering, visibility, or interaction changes:

```powershell
node --test --test-timeout=240000 .github\extensions\mos-diner\browser.test.mjs
```

The browser suite uses a temporary headless Edge profile and removes it afterward.
It skips if Edge is unavailable; a skipped suite is not browser verification.
Keep the model and browser suites separate to avoid resource contention during
lease-sensitive tests.

Before submitting, run `git diff --check`. In your pull request, describe the
behavior change, commands run, and any unverified scenarios. Include screenshots
for visible UI changes when useful, without personal information or credentials.

## Reporting issues

Use the bug-report template and include the browser or Copilot host, standalone
or canvas mode, view/theme, reproduction steps, expected behavior, and actual
behavior. Copy relevant error messages, but remove credentials, capability
tokens, personal filesystem paths, and private order or session data.

For menu and gameplay ideas, use the feature-request template and describe the
player-facing outcome.
