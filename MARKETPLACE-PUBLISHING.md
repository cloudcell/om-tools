# VS Code Marketplace publishing

The extension is published as `cloudcell.om-tools` from GitHub releases using **Visual Studio Marketplace Trusted Publishing (GitHub Actions OIDC)**. No Marketplace PAT or Azure account secret is required.

## One-time setup (repository owner)

1. Open [Marketplace publisher management](https://marketplace.visualstudio.com/manage/publishers/), sign in, and create or select the **`cloudcell`** publisher. This identifier must match `package.json`.
2. In that publisher, open **Trusted Publishing** > **Create**.
3. Set the policy fields **exactly**:
   - Policy name: `OM Tools releases` (any descriptive name)
   - Repository owner: `cloudcell`
   - Repository: `om-tools`
   - Workflow: `publish-vscode.yml`
   - Environment: **leave blank** (this workflow does not use a GitHub environment)
4. Save the policy. Ensure the Microsoft account has authority to manage that publisher.
5. Merge the workflow into **main**, and verify the repository's GitHub Actions are enabled. Use branch protection/rulesets and required checks to protect main; restrict who can create GitHub releases and tags.

**Do not** put PATs in source, Actions secrets, or workflow inputs. The Marketplace's OIDC trust policy permits the named GitHub workflow to obtain an expiring, single-use publishing credential.

## First publication after correcting the publisher

The GitHub release `v0.1.0` was created while the extension manifest still contained publisher `om-core`, so its Marketplace publishing attempt failed with `The requested publisher doesn't exist`. Do not move or replace that historical tag. The corrected publisher identifier is `cloudcell` and the first Marketplace release should use `v0.1.2`.

Before publishing, confirm that the **cloudcell** Marketplace publisher has a Trusted Publishing policy matching GitHub repository `cloudcell/om-tools`, workflow `publish-vscode.yml`, and an empty environment field. The GitHub release's tag must match the version in both `package.json` and `package-lock.json`.

## Publishing a version

1. Merge reviewed changes into `main` and confirm the quality/security workflow passes.
2. Update both `package.json` and `package-lock.json` to the desired version; update `CHANGELOG.md`. All version changes must be merged into `main`.
3. Create the tag **on the matching main commit**, for example:

   ```bash
   git checkout main
   git pull --ff-only
   # package.json must now contain 0.1.0, for example
   git tag -a v0.1.2 -m "OM Tools 0.1.2"
   git push origin v0.1.2
   ```

4. On GitHub, open **Releases > Draft a new release**, select that tag, and publish a **normal** release (not draft/prerelease).
5. GitHub Actions runs [Publish VS Code Marketplace](.github/workflows/publish-vscode.yml). It checks tag/version equality, ensures the tagged commit is already reachable from `main`, installs locked dependencies, typechecks, builds, scans, packages, examines the VSIX, then publishes using `vsce publish --oidc`.
6. After a successful run, check the extension page: https://marketplace.visualstudio.com/items?itemName=cloudcell.om-tools

Only published **non-prerelease** GitHub releases trigger publication. Pushes to `main` or `dev` do **not** publish. If the release cannot obtain an OIDC credential, double-check the Marketplace policy owner, repository, filename, and blank environment field. If a version is already published, increment the package version, create a new tag, and publish a new GitHub release; do not reuse a published version.

## Security and operational notes

- The publishing job has minimal GitHub access (`contents: read`) plus `id-token: write` for the short-lived OIDC exchange.
- The release tag must be `vMAJOR.MINOR.PATCH` and point to a commit included in `main`.
- The pipeline runs `npm ci`, typechecking, security checks, and `npm audit --audit-level=high` before publishing. Existing repository quality gates should additionally be required for merging to `main`.
- Packaging uses the repository's `.vscodeignore`; the VSIX must contain the extension entry point, built webview, README, and license.
- Do not merge unreviewed changes to the release workflow or allow untrusted users to create releases: a trusted publishing policy grants that workflow publishing authority.
- The release also publishes to **Open VSX** (the gallery used by Windsurf,
  VSCodium, Devin, and other VS Code forks) in the same workflow. It needs the
  `OVSX_PAT` repository secret — an access token from open-vsx.org, which
  requires an Eclipse account and a signed Publisher Agreement. The `cloudcell`
  namespace is created automatically on first publish. The step is
  non-blocking: a failure does not fail the release (the VS Marketplace
  publish cannot be retried for the same version) — re-publish manually with
  `npx ovsx publish <vsix> --pat <token>` if it ever fails. Open VSX also
  supports **trusted publishing (OIDC)**: once the extension exists and a
  trusted publisher is registered for `cloudcell.om-tools` pointing at this
  repository and workflow (open-vsx.org extension settings), the step uses
  `--trusted-publishing` automatically whenever `OVSX_PAT` is unset — remove
  the secret after registration to switch to OIDC permanently.
- The **first** successful publish cannot happen until the publisher account and Trusted Publishing policy have been created manually.

Reference: https://code.visualstudio.com/api/working-with-extensions/publishing-extension
