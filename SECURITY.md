# Security policy

## Supported versions

Security fixes target the latest code on `main`. Older snapshots and modified
copies do not have a separate security maintenance commitment. Update to the
latest `main` before checking whether a problem still occurs.

## Reporting a vulnerability

Please do not disclose vulnerabilities, exploit details, or sensitive logs in
public issues or pull requests.

Use [GitHub private vulnerability reporting](https://github.com/crazy4pi314/mos-diner-game/security/advisories/new)
for this repository. You can also find it under **Security > Report a
vulnerability**. GitHub sign-in is required. If the reporting form is unavailable,
email [crazy4pi314@github.com](mailto:crazy4pi314@github.com) privately instead.

Include the affected revision, standalone or canvas mode, browser or host
version, reproduction steps, expected and actual behavior, and likely impact.
Use a minimal proof of concept without real credentials, capability tokens,
personal filesystem paths, or private session data.

Maintainers will review reports and coordinate fixes and disclosure with the
reporter. This project does not promise a response or fix deadline.
Please allow coordination before public disclosure.

## Security boundaries

Standalone gameplay uses local deterministic interpretation, not a model.
The canvas host serves allowlisted game assets on loopback and uses capability
tokens, origin checks, validated JSON, and exclusive state-controller leases.
These controls do not make a modified copy or an arbitrary static web host
trusted. Never expose the canvas host through a public tunnel.

For ordinary gameplay bugs or feature requests, use the public issue templates.
For community conduct concerns, see [Code of Conduct](CODE_OF_CONDUCT.md).
