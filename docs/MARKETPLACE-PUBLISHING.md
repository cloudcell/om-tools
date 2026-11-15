# VS Code Marketplace publishing

The extension is published as `om-core.om-tools` from GitHub releases using **Visual Studio Marketplace Trusted Publishing (GitHub Actions OIDC)**. No Marketplace PAT or Azure account secret is required.

## One-time setup (repository owner)

1. Open [Marketplace publisher management](https://marketplace.visualstudio.com/manage/publishers/), sign in, and create or select the **`om-core`** publisher. This identifier must match `package.json`.
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

## Publishing a version

1. Merge reviewed changes into `main` and confirm the quality/security workflow passes.
2. Update both `package.json` and `package-lock.json` to the desired version; update `CHANGELOG.md`. All version changes must be merged into `main`.
3. Create the tag **on the matching main commit**, for example:

   ```bash
   git checkout main
   git pull --ff-only
   # package.json must now contain 0.1.0, for example
   git tag -a v0.1.0 -m "OM Tools 0.1.0"
   git push origin v0.1.0
   ```

4. On GitHub, open **Releases > Draft a new release**, select that tag, and publish a **normal** release (not draft/prerelease).
5. GitHub Actions runs [Publish VS Code Marketplace](../workflows/publish-vscode.yml). It checks tag/version equality, ensures the tagged commit is already reachable from `main`, installs locked dependencies, typechecks, builds, scans, packages, examines the VSIX, then publishes using `vsce publish --oidc`.
6. After a successful run, check the extension page: https://marketplace.visualstudio.com/items?itemName=om-core.om-tools

Only published **non-prerelease** GitHub releases trigger publication. Pushes to `main` or `dev` do **not** publish. If the release cannot obtain an OIDC credential, double-check the Marketplace policy owner, repository, filename, and blank environment field. If a version is already published, increment the package version, create a new tag, and publish a new GitHub release; do not reuse a published version.

## Security and operational notes

- The publishing job has minimal GitHub access (`contents: read`) plus `id-token: write` for the short-lived OIDC exchange.
- The release tag must be `vMAJOR.MINOR.PATCH` and point to a commit included in `main`.
- The pipeline runs `npm ci`, typechecking, security checks, and `npm audit --audit-level=high` before publishing. Existing repository quality gates should additionally be required for merging to `main`.
- Packaging uses the repository's `.vscodeignore`; the VSIX must contain the extension entry point, built webview, README, and license.
- Do not merge unreviewed changes to the release workflow or allow untrusted users to create releases: a trusted publishing policy grants that workflow publishing authority.
- Marketplace release is distinct from publishing to Open VSX (VSCodium). Open VSX requires its own publisher registration and workflow.
- The **first** successful publish cannot happen until the publisher account and Trusted Publishing policy have been created manually.

Reference: https://code.visualstudio.com/api/working-with-extensions/publishing-extension#publish-with-github-actions-and-trusted-publishing
