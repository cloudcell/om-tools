# OM Tools — integrated-engine distribution and licence review

## Current licences

- Original GUI/extension code remains **AGPL-3.0-or-later**, except separately licensed components. See `../LICENSE` and `../NOTICE`.
- The Zig engine's **original source** is proprietary in `cloudcell/om-engine-zig-dev`; official compiled distributions use `ENGINE-BINARY-LICENSE.md` only for rights Cloudcell Limited may grant.
- Embedded CORE-MATH remains MIT licensed; preserve `CORE-MATH-MIT.txt`.
- `engineWorker.cjs` and `tsEngineServer.cjs` originate from a separate TypeScript runtime. Its original source licence and corresponding source obligations must be documented.

## Critical combined-work issue (not yet authorised)

The AGPL licence of the OM Tools UI and a proprietary Zig engine may be incompatible if the combined system forms a single AGPL-covered work. Putting `.wasm` in another directory, repository, or licence file **does not by itself solve that**. Neither the separate binary licence nor this document grants an AGPL linking exception or a commercial relicence.

**Preferred commercial distribution path:** obtain copyright-holder grants for **all** relevant GUI contributions permitting an alternative, commercially licensed official combined distribution, while keeping the public GUI source available under AGPL. An explicit AGPL linking exception is an alternative, but similarly requires permission from relevant holders. Do not place either in effect without approval.

The repository's public contributor-signoff register is empty as of 2026-11-24. A private signed contributor agreement may exist; maintainers must verify it, including prior contributions, before approving relicensing. Credits in CONTRIBUTORS.md alone do not confer relicensing rights.

## Release gate — evidence to keep privately

- [ ] Cloudcell Limited owns or is authorised to license the Zig source and every included third-party component.
- [ ] All OM Tools contributor/employee rights needed for commercial combined distribution are documented (including historical contributions).
- [ ] Identify the actual copyright owner/licensor on the official binary licence; confirm any Cloudcell-to-new-company rights if ownership changes.
- [ ] Verify the compiled Zig source commit and SHA-256 in `engine/PROVENANCE.json` using a clean checkout and matching local WASM.
- [ ] Verify the TypeScript runtime source and licence, corresponding-source delivery, and all packaged dependencies.
- [ ] Verify the AGPL corresponding-source links for the precise GUI version distributed.
- [ ] Verify full engine and CORE-MATH licence notices are in the VSIX.
- [ ] Obtain legal review of the chosen combined-work structure and complete the approved commercial grant / exception before release.

For repeatable verification run `node tools/verify-engine-artifacts.mjs`. Marketplace CI intentionally refuses binaries whose Zig source provenance is unverified. This is a technical gate; the copyright approvals above still require human verification.
