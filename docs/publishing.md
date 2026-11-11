# Publishing countinghouse to npm

Releases are published by `.github/workflows/publish.yml` under npm
**trusted publishing**: the workflow proves its identity to npm with a
short-lived GitHub OIDC token. No npm token exists in the repository or in
GitHub secrets, no 2FA code is typed for a release, and npm attaches
provenance to each version published this way.

## Once, by the maintainer

The package `countinghouse` already exists on npm (maintainer `out4b`), so
no manual first publish is needed. On npmjs.com: **countinghouse → Settings
→ Trusted publishing → GitHub Actions**, with

| Field | Value |
|---|---|
| Organization or user | `mchen6` |
| Repository | `countinghouse` |
| Workflow filename | `publish.yml` |
| Environment name | leave empty |
| Allowed actions | `npm stage publish` **and** `npm publish` |

Allowing `npm publish` is what makes a release automatic; configurations
created after September 2026 default to staged publishing, which asks the
maintainer to approve each release with 2FA. Then **Settings → Publishing
access → "Require two-factor authentication and disallow tokens"**, which
blocks token publishes and does not affect trusted publishing.

A new trusted publisher configuration expires unless its first successful
publish happens within two days, so configure it when the next release is
ready to tag. If it expires, delete it and create it again.

## Every release

1. Bump `version` in package.json and write the CHANGELOG entry; merge to
   `master`; wait for CI.
2. Tag that commit `v<version>` (the workflow refuses a tag that does not
   match package.json, or a commit not on master) and push the tag:

```
git tag v7.2.0 <sha>
git push origin v7.2.0
```

The workflow checks the npm version (11.5.1 or later is required), prints
the tarball contents, and publishes. It does not repeat the test suite: the
tag is cut from a master commit CI has already run on.

## Requirements

npm 11.5.1 or later and Node 22.14 or later on the runner (the workflow
uses Node 24). GitHub-hosted runners only. `repository.url` in package.json
must name this repository exactly, as it does.
