# OM Tools Security Policy

## Supported versions

OM Tools is early-stage software. Security fixes are currently made on a best-effort basis for the latest development version; older snapshots are not supported.

| Version | Security maintenance |
| --- | --- |
| Current development version | Best effort |
| Older snapshots | Not supported |

## Reporting vulnerabilities

**Do not publish unpatched security issues in a public GitHub issue.** Email `alex@cloudcell.nz` with subject `OM Tools Security Report`. <!-- check-sensitive: allow -->

Please include the affected version/commit, platform, VS Code or VSCodium version, Node.js version, relevant OM Core runtime version, reproduction steps, observed behavior, impact, and a safe proof of concept if available. Never send live credentials.

## Scope

Relevant problems include unsafe runtime launching or command execution, socket or TCP exposure, traversal and unsafe file access, webview script injection or message handling, bridge/WebSocket security, credential or environment leakage, and dependencies with practical security impact.

Reports generated only by scanners without an exploitable finding, pre-compromised host scenarios, and speculative hardening suggestions generally are not security vulnerabilities in scope.

## Response and disclosure

Maintainers aim to acknowledge, reproduce, assess, and fix verified reports as resources allow, then coordinate disclosure and credit with the reporter where appropriate. Response deadlines and long-term support are not guaranteed.

OM Tools is provided without warranty; see `LICENSE`.
