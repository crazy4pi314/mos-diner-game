# Mo's Diner 🍳

A diner-themed game about prompting, reviewing plans, and shipping code with
GitHub Copilot. You work the counter at Mo's, and Copilot is your sous-chef.
Turn customer orders into prompts, review the cooking plan, and merge a stack
of pull requests to serve breakfast.

**The challenge:** fulfill three orders exactly as requested within 90 seconds.
Each cooking step is a PR, and kitchen mishaps become checks to diagnose and fix.

Mo's Diner runs as a standalone browser game or a Copilot canvas. Game files,
artwork, fonts, menu data, and the canvas host are self-contained in this
repository. Prompts are interpreted locally; gameplay does not call a model
or consume Copilot usage.

## Quick start

### Play in a browser

Clone or download [this repository](https://github.com/crazy4pi314/mos-diner-game)
and open `index.html` in Microsoft Edge or another modern browser. No package
installation, build, account, or server is required for standalone play.

The default view uses **Orders / Prep / Kitchen** navigation. For the classic
diner layout, add `?fun` to the URL; add `?skin=cozy` for the cozy theme, or
combine them as `?fun&skin=cozy`.

### Play in Copilot

Open this directory as a repository in a Copilot host that supports project
canvas extensions, load `.github/extensions/mos-diner/`, and ask Copilot to
open the **Mo's Diner** canvas. See [Copilot canvas](#copilot-canvas) for input
options and host details.

### Customize the menu

Edit `menu.json`, then regenerate the standalone fallback:

```powershell
node scripts\build-menu-file.mjs
```

The active menu is breakfast-only: **Stacked PR Pancakes**, **Eggs your way with
Copilot code review**, and **Bacon, eggs, and balanced code reviews**. Each dish
has three recipe options. Reload the page after editing; for canvas menu changes,
also reload the extension so server-side validation uses the updated menu.

## The diner

The screen has three columns:

- **Left: the line.** When the doors open, three customers walk in one after another and form a line, one for each breakfast dish. The person at the front says their order in a speech bubble. Everyone shuffles forward as you take orders. Customers you've served wait at **Pickup** at the bottom.
- **Center: Copilot.** The conversation for the selected order: what the customer said, your prompt, and Copilot's plan.
- **Right: the kitchen.** Every approved order cooks here as a PR stack, one PR at a time. When a stack is green, **Merge & serve** it.

On phones you see one column at a time, with an Orders / Prep / Kitchen tab bar at the bottom.

For development commands, change guidelines, and bug-report details, see
[Contributing](CONTRIBUTING.md).

## Copilot canvas

The project extension in `.github/extensions/mos-diner/` registers **mos-diner**.
The Copilot CLI resolves its SDK automatically; no install or build is needed.
The standalone site still opens directly from `index.html` or any static web host.

Menu dishes, customer order phrases, recipe steps, and options live in
`menu.json`. The active menu contains only three All Day Breakfast dishes:
Stacked PR Pancakes, Eggs your way with Copilot code review, and Bacon,
eggs, and balanced code reviews, with three recipe options per dish.
Appetizers, Mains, Soup, and Dessert remain in the data with `enabled: false` and are not offered
in dish selection, typed prompts, or new customer orders.
Secret Sauces are disabled in `menu.json`; they do not appear in the menu,
customer requests, prompt options, plan review, or cooking steps.
For Eggs your way, sunny-side approval changes the first egg and scramble
the diff changes the second, so both options can be ordered together.
Set a dish, recipe option, or shared sauce's `enabled` field to `false` to remove it
from new shifts. After editing the JSON, refresh the direct-file fallback and reload the extension
so the browser, server validator, and real-Copilot menu all use the same data:

```powershell
node scripts\build-menu-file.mjs
extensions_reload
```

After editing the extension, run `extensions_reload`, then
`extensions_manage` with `operation: "list"` and `operation: "inspect", name: "mos-diner"`.
Inspect includes the provider log path and log tail for startup errors.
Reload restarts all loaded extensions, not just this one.

Discover with `list_canvas_capabilities({ canvasId: "mos-diner" })`, then open:

```js
open_canvas({
  canvasId: "mos-diner",
  instanceId: "diner-game",
  input: { view: "hub", skin: "default", gameId: "booth", inputMode: "deterministic" }
})
```

Input is optional (or `null`). `view` accepts `hub` (default) or `classic`;
`skin` independently accepts `default` or `cozy`. `gameId` defaults to `default`;
use 1-64 lowercase ASCII letters, digits, hyphens or underscores. Unknown fields/values are rejected.
`inputMode` currently accepts only `deterministic`; canvas and standalone prompts
always use the local deterministic parser.
Classic maps to the existing `?fun` option and cozy to `?skin=cozy`.
Hub switches to tabs at 900px; classic keeps its 760px breakpoint.
CSS and game navigation use the same media query, including when the panel resizes.
Short panels scroll game content and dialog bodies; the certificate scrolls to its replay button.

Each panel uses an ephemeral-port HTTP server bound only to `127.0.0.1`.
Reopening an instance reuses its server; panel close and provider shutdown
release it. Finishing a chat turn does not shut down the canvas server.
To reopen a canvas instance, reuse its `gameId`; close its panel before choosing a different `gameId`.
The header and welcome dialog share the capitalized Mo's Diner wordmark in
self-hosted Mona Sans Medium (SIL Open Font License) and the updated GitHub
Invertocat mark; the font and its license are explicitly allowlisted.
Cozy typography uses self-hosted Fredoka (variable weights 400-700) and
DM Mono (weight 500), downloaded from Google Fonts' official distribution.
Their Latin/extended-Latin subsets and Fredoka Hebrew subset are in
`assets/fonts/`, with `Fredoka-OFL.txt` and `DM-Mono-OFL.txt` alongside them.
Both are licensed under the SIL Open Font License. Font faces use `swap` and
are requested only when used by cozy styling; default pages do not load them.
There are no external font stylesheets or font-service requests.
Only named root game files and named assets are served, with real-path
checks rejecting symlink redirects. Repository internals, other files under
`assets/`, and session artifacts are not served. Add new game assets explicitly
to `hosting.mjs`'s allowlist.
The iframe has no privileged host bridge or agent actions. Its state API uses
same-origin JSON requests with an unguessable per-server capability; foreign
origins, foreign fetch sites, non-JSON writes and oversized bodies are rejected.
Cross-origin iframe navigation still works.

### Startup and asset caching

The production extension imports only the extension registration SDK, not a model
client. Opening the game and loading its configuration do not search PATH,
probe another CLI executable, start model sessions, or require model sign-in.
After the menu loads, configuration and initial state requests each have a
five-second deadline. Start stays disabled until initialization succeeds.
A failed request or invalid response appears in the information dialog with
**Retry loading**. Retry repeats initialization without reloading the document
or starting a clock; repeated clicks share one attempt and document exit
invalidates late results. Corrupt state and disk errors remain visible, not
replaced with an empty checkpoint.

HTML, configuration, state, model responses and errors use `no-store`.
Allowlisted static assets use `private, no-cache` with content-derived ETags:
unchanged conditional GET/HEAD requests return a bodyless `304`, and edited
assets are revalidated on the next request. Path and file-identity checks still
run before a conditional response, so caching does not bypass the allowlist or
symlink protection. This reduces repeated transfer, not filesystem validation.

The existing session-owned canvas remains the supported launch path.
Some app builds expose standalone project-canvas opening under
**Customize > Canvas > Installed**; use it only if the installed app offers it.
It does not require rewriting this extension or adding a manifest merely to open
it independently. Availability is host-controlled, and has not been verified
in the installed build because native app inspection was blocked by the
automation safety policy. No experiments or app settings were changed.
Restoring an open panel after an app restart is separate from restoring game
progress: a new diner document still starts a fresh shift. Separate app/session
instances sharing a `gameId` still compete for the same exclusive controller.

### Pausing and resetting

Canvas shifts load **paused**. Only **Start shift / Resume shift** (or Enter in the
name field) acquires control and starts the clocks. Start remains disabled until initialization and canvas visibility are
ready. Visibility tracking observes the active welcome/results dialog or
certificate when present, rather than the page obscured by its modal backdrop.
Hiding the canvas still pauses it; showing it enables explicit resume without
starting the clock automatically.
Opening the info dialog pauses
the one-second shift clock, 450ms cooking/check clock, and deployment/eating/tip
delays. Closing that dialog resumes the same in-memory shift. Hidden pages and
hidden/clipped iframes remain paused until the player explicitly resumes them.
The top-right **Reset game** button clears the shift and returns to the welcome
screen.
During the final 15 seconds of a running shift, **Help, sous-chef!** subtly
twinkles. The effect stops when paused, when time is added above 15 seconds,
or when the shift ends, and is disabled for reduced-motion preferences.

Canvas loads always start a fresh shift; previous shift progress is not restored.
Version-1 JSON checkpoints still live in
`~/.copilot/mos-diner/mos-diner-game/<gameId>.json`, outside
the public asset tree, but they are used only to coordinate the active canvas
owner and validate real-Copilot requests during the current run.

Changes and clock advances are checkpointed, with a two-second heartbeat that
always refreshes the lease. Clicks and prompt edits debounce for 400ms. An
identical snapshot from those saves does not hit the state lock again while
more than three seconds remain on the control deadline; a lease refresh still
extends the on-disk lease without a new revision.
Only one controller may own a game ID, even across providers using the same
state directory. Atomic file replacement, a short exclusive writer lock,
revision checks and an eight-second lease prevent sibling writes and stale
controllers. The renderer stops editing and advancing before its lease can expire.
On Windows, checkpoint replacement retries `EPERM`, `EACCES`, and `EBUSY`
up to five times with exponential delays totaling 310ms. The writer lock stays
held and the existing checkpoint is never deleted; only a successful atomic
rename commits the new state. Persistent permission failures and other disk
errors still block play and are reported normally.
After an execution gap or suspended webview, expired control pauses the live
in-memory shift, cancels pending saves and clocks, and offers **Resume shift**.
Resume rereads the current revision and atomically reclaims control only if it
has not changed and another view does not own it. It never advances offline time
or automatically resumes. A changed revision or competing owner blocks play
with an explicit error; close and reopen to start a fresh shift.
Pause saves and releases valid control and stops the heartbeat; close/shutdown
releases ownership. If a
renderer dies without a close event, the lease expires without charging offline
time. Reopening starts over rather than restoring the checkpoint.

Load/save errors block play and appear inside the info dialog.
If a provider is killed *during a disk transaction*, its stale `<gameId>.lock`
is deliberately not removed automatically: after confirming its recorded PID
is no longer running, remove that specific lock and reload. This fails closed
rather than risking concurrent lock recovery. State remains in the JSON file.
An abrupt process/OS failure may lose a write that was not acknowledged.

### Prompt interpretation

Canvas and standalone prompts currently use only the deterministic local parser.
The canvas does not expose a prompt-mode selector and rejects `inputMode: "copilot"`.
The production host reports deterministic availability directly and rejects
interpretation requests to `/_diner/plan` with an explicit unavailable response.
The isolated model integration remains covered by unit tests for possible future
use, but is not wired into the production extension. Gameplay never starts a
model session or consumes Copilot usage.

In injected model tests only, the protected `/_diner/plan` endpoint checks the capability, origin, JSON/body
limits, current game controller lease and editable order. At most two requests
run per panel. A schema-constrained response is independently validated in both
Node and the renderer: known dish ID, unique options belonging to that dish, and
at most 300 characters of plain-text explanation. Duplicate/cross-dish options,
markup, missing fields and unknown fields are rejected, not coerced. Cooking
steps still come exclusively from the local menu; model prose is never HTML.
The provider schema uses the runtime-supported subset; stricter bounds and
uniqueness are enforced locally.

Plans retain the visible customer ask, **you asked / assumed** tags, editable
steps, and **Edit prompt** to change dishes. Model proposals never approve,
cook, merge or serve: review against the customer's request and explicitly
**Approve plan** to enter the unchanged cooking/check/serve pipeline.
Host-theme adaptation remains deferred.

Run focused checks (no dependencies required):

```powershell
node --test .github\extensions\mos-diner\extension.test.mjs .github\extensions\mos-diner\hosting.test.mjs .github\extensions\mos-diner\lifecycle.test.mjs .github\extensions\mos-diner\menu.test.mjs .github\extensions\mos-diner\model.test.mjs .github\extensions\mos-diner\browser.test.mjs
```

The browser test launches an isolated headless **Microsoft Edge** profile and
removes it afterward. It skips when Edge is not installed; set `DINER_EDGE` to
the executable path to enable it elsewhere.
Model tests use an injected SDK boundary/provider (no login or paid model calls).
Edge covers offline startup in all skin/view combinations, local fonts,
configuration timeouts and retry, malformed configuration/state, obsolete
initialization, simulated execution-gap recovery, deterministic prompting,
approval/edit/diff boundaries, fresh-document shifts, pausing, resetting, and
terminal result screens. Controller tests also cover competing ownership,
changed revisions, delayed acknowledgements, and queued stale saves.
Headless Edge does not prove native Windows webview suspension behavior; that
check remains unverified because native app inspection was blocked here.

Fulfill three orders exactly as requested within 90 seconds and you win a gift certificate to show the booth staff.

## How to play

1. **Take the order.** Read what the customer asks for. The details matter.
2. **Prompt Copilot.** Choose a breakfast dish, then tap detail chips, or type it (`@copilot one stacked pr pancakes, async syrup`).
3. **Review the plan.** Copilot lists one PR per step. Details from your prompt are tagged *you asked*; anything you left out is tagged *assumed* (the house default). Tap a step to change it, then **Approve plan**.
4. **Merge & serve.** Copilot cooks the stack in the kitchen while you take the next order. When it's green, merge it and hand it over.

If the order doesn't match what the customer said, they send it back and the wrong step is highlighted. Fix the plan and Copilot rebuilds only the PRs that changed, as fix-ups.

Tips are currently hidden behind the disabled `FEATURES.tips` flag in `game.js`.
If time runs out before you fulfill three orders, restart and try again with a new set of randomized orders.

## Files

- `index.html`: markup (two-pane shell, dialogs, certificate)
- `styles.css`: Copilot app styles plus game UI
- `menu.json`: categorized dishes, three recipe options per dish, shared sauces, customer phrases, and cooking/check data. `art: null` uses the dish emoji instead of unrelated artwork.
- `orders.js`: menu validation and compilation (`Menu.MENU`), including expansion of shared sauces into optional recipe steps.
- `copilot.js`: prompt parsing, review/cooking plan generation, and order checking (`Copilot.parse` / `plan` / `cookingPlan` / `diff`)
- `game.js`: shift timer, customers, patience, tips, rendering
- `lifecycle.js`: exclusive canvas controller, paused restoration and heartbeat
- `live-plan.js`: shared model-result schema and strict menu validation
- `.github/extensions/mos-diner/model.mjs`: isolated SDK interpreter and runtime discovery
- `snapshot.js`: shared versioned JSON validation
- `assets/copilot-chef.png`: Copilot mascot
- `assets/mos-mark.svg`: pink script mark. The title bar masks it white.
- `assets/mos-lockup.svg`: color Mo's Diner lockup for the welcome dialog.
- `assets/mos-badge.svg`: pink-background badge the gift certificate expands.
- `assets/mos-cert-logo.svg`: badge crop (script, outlined DINER, checker, SF*CA bubble) used on the certificate.
- `assets/invertocat-pink.svg`: current [official GitHub Invertocat](https://brand.github.com/foundations/logo) in dark pink (`#D5346B`), used as the page favicon. The Copilot canvas tab icon is app-owned and cannot be changed from this repo.
- `assets/checker-icon.svg`: dark and light pink checker pattern.
- `theme-cozy.css`: optional hand-drawn skin. Add `?skin=cozy` to the URL.
- `theme-hub.css`: the default "Hub" view with Orders / Prep / Kitchen navigation in the booth theme. Add `?fun` to the URL for the classic diner counter. The game logic is the same in both.
