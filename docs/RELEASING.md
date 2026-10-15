# Package releases

The package is `@twotwo-me/confluence-wiki-md`; its commands are `cfwiki` and
`cfwiki-skill`. Node.js 24 or later is required. New releases use public npm and
GitHub release archives. The archives remain available without an npm account or
GitHub token. Earlier releases used GitHub Packages; that registry required login
even for public packages. Never add credentials to the tracked `.npmrc`.

## Verification and GitHub release

CI tests Linux and macOS. A release tag must be a stable `vX.Y.Z` matching the
manifest and lockfile and must point to a commit reachable from `main`.

```sh
npm version minor --no-git-tag-version
npm test
npm run test:package -- artifacts/release
```

Review and commit the intended changes, push `main`, and push the matching version
tag. The tag workflow repeats the checks, installs the real packed artifact
outside the checkout, and publishes that exact tarball plus `SHA256SUMS` to a
GitHub Release. A separate job downloads the public URL without credentials and
checks its bytes against the verified archive, installs it, runs both CLI and
skill workflows, and checks one-shot execution.

The package allowlist excludes credentials, local profiles, page downloads, live
fixtures, and raw benchmark artifacts. It includes the CLI, installer, canonical
skill, examples, empty-token profile templates, installation guide, and token
benchmark report. The installation check verifies the packed file list and the
published skill bytes. `PUPPETEER_SKIP_DOWNLOAD=true` avoids browser downloads in
all distribution checks; rendering engines and live API checks remain separate.

## Public npm setup

The manifest publishes to `https://registry.npmjs.org/` with public access. The
account or organization must own the lowercase `@twotwo-me` scope. For the first
publication, authenticate as the maintainer and publish the already verified
archive with the account's required 2FA:

```sh
npm publish artifacts/release/confluence-wiki-md.tgz --access public --registry=https://registry.npmjs.org/
```

npm currently requires account 2FA or a suitable granular token for direct
publication. Account creation alone does not complete this requirement. See
[npm's scoped-public package guidance](https://docs.npmjs.com/creating-and-publishing-scoped-public-packages/).
Do not put login or OTP values in command arguments committed to the repository.

For later releases, configure a trusted publisher in the npm package settings:
GitHub owner **TwoTwo-me**, repository **confluence-wiki-md**, workflow
**release.yml**. Then set repository Actions variable `NPM_PUBLISH_ENABLED=true`.
The workflow's `npm-publish` job uses GitHub OIDC with `id-token: write`, Node 24,
and npm >=11.5.1. No long-lived npm token is stored in GitHub. Trusted publishing
also generates provenance automatically. The package-side publisher must be
configured before enabling the variable; merely adding workflow permissions is
insufficient. See [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/).

Until this setup is complete, leave the variable unset. The npm job is skipped;
GitHub Releases and their anonymous-install checks still run. This is an explicit
publication state, not proof that the version is available from npm.

After publication:

```sh
npm run test:registry -- artifacts/release/confluence-wiki-md.tgz
npm run test:release -- artifacts/release/confluence-wiki-md.tgz
```

The registry check strips auth token environment variables, uses empty isolated
user/global npm configuration and a separate cache, compares the published
SHA-512 integrity with the verified archive, and tests global install plus
`npm exec` and skill copies. The release-URL check likewise removes GitHub/npm
token variables. These checks do not use Confluence credentials.

## Retry and version policy

Use the release workflow's manual dispatch with an existing tag or rerun a failed
job. The GitHub release job leaves an existing release untouched. The npm job
skips an already published version only if its integrity matches the verified
archive; a mismatch fails. Never replace a published archive or move a release
tag to different content. Release a new version when code, documentation, or
bundled skills change.

Use a minor release for new command behavior and layout changes before 1.0, and a
patch for compatible fixes. Keep the manifest and root lockfile version in sync.
For users requiring reproducibility, document a pinned npm version or a
`releases/download/vX.Y.Z/confluence-wiki-md.tgz` URL rather than `latest`.

See [installation.md](installation.md) for anonymous installation and exact agent
skill paths.
