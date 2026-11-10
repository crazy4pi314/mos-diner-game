# Contributing to Mo's Diner

## Welcome to the kitchen

Bug reports, clearer docs, accessibility improvements, and breakfast ideas are
welcome. Please follow the [Code of Conduct](CODE_OF_CONDUCT.md). Report
vulnerabilities privately through [SECURITY.md](SECURITY.md), not a public issue.

For player setup, see [Installation](docs/INSTALL.md). For canvas internals and
the source map, see [the developer reference](docs/DEVELOPMENT.md). Coding
agents should also read [AGENTS.md](AGENTS.md).

## Local setup

Open this repository in the GitHub Copilot app and load the project canvas
extension at `.github/extensions/mos-diner/`. Follow the
[installation guide](docs/INSTALL.md) to open the game. Public player setup
should document only the Copilot app canvas, not browser or CLI alternatives.

Development scripts and tests use Node.js 22 or newer with built-in modules; no dependency
installation is required. The browser integration suite also needs Microsoft
Edge. If Edge is installed outside its usual location, set `DINER_EDGE` to its
executable path.

Run commands from the repository root. Fork and clone the repository, create a
branch for your change, and open a pull request against `main` when it is ready.
Use the PR template and explain the player-facing or maintainer-facing outcome.
Discuss substantial gameplay or architectural changes in an issue before
investing in a large implementation.

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

Documentation-only changes do not require gameplay tests. Check links and
verify that commands and behavior descriptions agree with the source instead.

## Reporting issues

Use the bug-report template and include the GitHub Copilot app version,
canvas size, reproduction steps, expected behavior, and actual
behavior. Copy relevant error messages, but remove credentials, capability
tokens, personal filesystem paths, and private order or session data.

For menu and gameplay ideas, use the feature-request template and describe the
player-facing outcome.

## License and credits

Contributions to project code are provided under the project's [MIT license](LICENSE).
Only contribute material you have the right to share, retain third-party
notices, and identify any new asset's source and license. See
[third-party notices](THIRD_PARTY_NOTICES.md) for font and branding distinctions.
