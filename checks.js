// Hub view only: the checks every PR stack runs before it can merge (GitHub Actions + GHAS),
// and the failures a stack can hit. Each failure has a log to read and one right fix.
window.Checks = (() => {
  const RUNS = [
    { id: "build", app: "Actions", name: "CI / build", diner: "Prep the line" },
    { id: "test", app: "Actions", name: "CI / test", diner: "Taste test" },
    { id: "codeql", app: "CodeQL", name: "Code scanning", diner: "Health inspection" },
    { id: "deps", app: "Dependabot", name: "Dependency review", diner: "Fresh ingredients" },
    { id: "secrets", app: "Secret scanning", name: "Secret scanning", diner: "No secrets in the sauce" },
  ];
  const RERUN = { id: "rerun", text: "Re-run failed jobs" };

  // Each failure: which check fails, a log, and the fixes on offer. Only one is right.
  const FAILS = {
    flaky: d => ({
      check: "build", title: "CI / build failed: the runner timed out",
      log: ["$ " + d.checks.prep[0], d.checks.prep[1], "##[error] The runner received a shutdown signal (timeout after 30s)", "History: this job passed on the last 12 runs"],
      fixes: [
        { ...RERUN, ok: true, why: "Flaky runner, not your code. The re-run went green." },
        { id: "rewrite", text: "Ask Copilot to rewrite the recipe", why: "Nothing's wrong with the recipe. The runner timed out, and the job passed 12 runs in a row: that's a flake." },
        { id: "disable", text: "Delete the build job from the workflow", why: "Turning off CI just hides problems. It was a one-off timeout." },
      ],
    }),
    test: d => {
      const t = d.checks.test;
      return {
        check: "test", title: "CI / test failed: 1 failing, 23 passing",
        log: [`✓ plates the ${d.name.toLowerCase()}`, "✓ matches the order ticket", `✗ ${t.t}`, `    ${t.exp}`, `    at ${t.at}`],
        fixes: [
          { id: "fixcode", text: `Ask Copilot to fix the ${t.what} in ${t.file}`, ok: true, pr: `Fix ${t.what} in ${t.file}`, why: "Copilot pushed a fix PR. The test passes." },
          { ...RERUN, why: "It fails the same way every time. That's a real bug, not a flake." },
          { id: "skip", text: "Skip the failing test", why: `Skipping it ships ${t.bad}. Fix the code instead.` },
        ],
      };
    },
    codeql: d => ({
      check: "codeql", title: "Code scanning: 1 new high-severity alert",
      log: ["js/unwashed-input: unsanitized customer input reaches the plate", "Source: order.toppings (customer input)", "Sink: plate.serve() at kitchen/plate.js:18", "Severity: High · Copilot Autofix available"],
      fixes: [
        { id: "autofix", text: "Apply Copilot Autofix", ok: true, pr: "Autofix: wash() input before serving", why: "Autofix routed the input through wash() before serving. Alert closed." },
        { id: "dismiss", text: "Dismiss the alert as \"won't fix\"", why: "Dismissing a high-severity alert ships the vulnerability." },
        { ...RERUN, why: "CodeQL will find the same alert again. The code has to change." },
      ],
    }),
    deps: d => {
      const pkg = d.checks.ingredient;
      return {
        check: "deps", title: `Dependabot: critical vulnerability in ${pkg}`,
        log: [`Package: ${pkg}`, "Installed: 1.2.0 · Patched: 1.2.4", `GHSA-m0s-d1ne: ${pkg} 1.2.0 is past its expiration date (critical)`, `Dependabot opened a PR to bump ${pkg} to 1.2.4`],
        fixes: [
          { id: "bump", text: "Merge Dependabot's PR to bump the version", ok: true, pr: `Bump ${pkg} from 1.2.0 to 1.2.4`, why: `Bumped to ${pkg} 1.2.4. Fresh ingredients only.` },
          { id: "pin", text: "Pin to 1.2.0 so nothing changes", why: "Pinning locks in the vulnerable version." },
          { id: "rewrite", text: "Ask Copilot to rewrite the recipe", why: "The recipe is fine; the ingredient is out of date. Update the dependency." },
        ],
      };
    },
    secrets: d => ({
      check: "secrets", title: "Secret scanning: push protection blocked a secret",
      log: ["Found: walk-in freezer code (MO_FREEZER_CODE)", "File: kitchen/recipe.md, line 12", "    freezer_code = \"8675309\"", "Push blocked by push protection"],
      fixes: [
        { id: "rotate", text: "Rotate the code and move it to an Actions secret", ok: true, pr: "Move freezer code to an Actions secret", why: "New code, stored as a secret. Nothing sensitive in the repo." },
        { id: "delete", text: "Delete the line and push again", why: "It's still in the git history. Rotate the code and use a secret store." },
        { id: "bypass", text: "Bypass push protection", why: "Bypassing publishes the code to everyone with repo access." },
      ],
    }),
  };
  return { RUNS, FAILS, KINDS: Object.keys(FAILS) };
})();
