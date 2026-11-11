# Contributing to OM Tools

Thank you for contributing to OM Tools, the VS Code/VSCodium interface and tooling project for the OM Core modeling engine.

## Project status and scope

OM Tools is an early-stage project. Its extension APIs, runtime integration, transport, UI, and packaging may change before a stable release. The runtime itself is developed in the separate [OM Core repository](https://github.com/cloudcell/om-core).

## Before submitting a pull request

1. Search existing issues and pull requests, and discuss major changes before implementing them.
2. Keep each change focused. Do not combine unrelated refactoring, features, and formatting changes.
3. Add or update tests when changing behavior and document user-facing changes.
4. Preserve compatibility with the documented OM Core command/query protocol or explain the required runtime changes.
5. Do not commit secrets, credentials, private model data, or materials without appropriate rights.

## Development and checks

```bash
git clone https://github.com/cloudcell/om-tools.git
cd om-tools
npm install
npm run build
npm run compile
npm test
npm run check:sensitive
```

For runtime setup and architecture, see `AGENTS.md`. Prefer deterministic, testable changes and clear commit messages.

## Contributor sign-off and CLA

OM Tools follows the contribution-licensing framework used in OM Core, but **agreement to contribute to one repository is not automatically an agreement for the other**.

- For small individual contributions, follow [`legal/CONTRIBUTOR-SIGNOFFS.md`](legal/CONTRIBUTOR-SIGNOFFS.md). Add your own complete row and provide the express agreement text in your PR. Include a `Signed-off-by:` trailer in each commit.
- For substantial, strategic, employer-owned, or corporate contributions, Cloudcell Limited may require a separately signed [`legal/CONTRIBUTOR-CLA.md`](legal/CONTRIBUTOR-CLA.md).
- If work was performed for an employer or client, ensure you can authorize the submission and obtain the appropriate permission.
- If you previously contributed before these policies were published, discuss the scope of any retrospective licensing with the maintainer; retrospective rights should be confirmed by an affirmative agreement, not inferred from publication of this policy.

Example commit trailer:

```text
Signed-off-by: Your Name <you@example.com>
```

A commit trailer by itself does not replace the explicit contributor grant or a requested signed CLA.

The project is distributed under `AGPL-3.0-or-later`, except for separately licensed materials. Contributing does not transfer copyright ownership; the contributor grant provides Cloudcell Limited with additional licensing rights described in the applicable agreement.

## Conduct, security, and branding

Please follow the [code of conduct](legal/CODE_OF_CONDUCT.md). Report vulnerabilities privately under [SECURITY.md](SECURITY.md), not as public issues. The software license does not confer trademark rights; see [brand guidance](legal/TRADEMARKS.md).

## Maintainer discretion

Maintainers may decline changes that are too broad to review, not adequately tested, out of scope, incompatible with project architecture, or otherwise impractical to maintain.
