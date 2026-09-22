# Package releases

The package name is `confluence-wiki-md`; the installed command is `cfwiki`.
Node.js 24 or later is required. GitHub Releases work independently of npm account
setup, so users can install a release archive with npm before registry publishing
is enabled.

## Workflows

| Workflow | Trigger | Result |
| --- | --- | --- |
| `ci.yml` | Main push, pull request, manual run | Tests and isolated package installation on Linux and macOS |
| `release.yml` | `vX.Y.Z` tag push, manual retry with an existing tag | Verified archive and checksum on GitHub Releases; optional npm publish |

Actions use GitHub-hosted runners. No Confluence credentials are needed by these
workflows. Release tags must match `package.json` and point to a commit reachable
from `main`. Only stable three-part versions are accepted. Dependencies are
installed without browser downloads for CI; real diagram-engine and live API
checks remain separate commands.

The package manifest uses an explicit file allowlist. `npm run test:package`
inspects the actual archive, installs it globally under a temporary prefix, and
executes the installed command from outside the checkout. It also checks Markdown
conversion, empty-token profile templates, and the bundled agent skill. Local
profiles, wiki downloads, test artifacts, and CI configuration are excluded.

## First npm publication

1. Sign in with the npm account that will own `confluence-wiki-md`: `npm login`.
   Complete npm's email verification and two-factor authentication requirements.
2. Download the already verified GitHub release archive and `SHA256SUMS` into a
   clean directory. Verify the checksum before publishing.
3. Publish that archive interactively:

   ```sh
   npm publish ./confluence-wiki-md.tgz --access public
   ```

   This initial publication establishes package ownership. If the name has been
   claimed by someone else, select an owned scope and update the manifest,
   installation guide, package checks, and publisher settings together.
4. In the npm package settings, add a GitHub Actions Trusted Publisher:

   | Field | Value |
   | --- | --- |
   | Organization or user | `TwoTwo-me` |
   | Repository | `confluence-wiki-md` |
   | Workflow filename | `release.yml` |
   | Environment name | `npm` |
   | Allowed actions | Enable direct `npm publish` |

   New configurations may default to staged publication only; this workflow uses
   direct publication. See [npm's trusted publishing documentation](https://docs.npmjs.com/trusted-publishers/).
5. Create the GitHub repository environment named `npm`. Set the repository
   Actions variable `NPM_PUBLISH_ENABLED` to `true` after the publisher is ready.
   Do not add a long-lived npm token. The publish job requests a short-lived OIDC
   credential and npm generates provenance for public GitHub builds.
6. Publish the next version through its tag to verify OIDC end to end. The first
   version is already in npm, so republishing that same version will fail.

The workflow uses Node 24's current bundled npm. Trusted publishing requires npm
11.5.1 or later. For local publishing, `npm whoami` checks the interactive login;
it does not validate an Actions OIDC identity.

## Publish a new version

Start from a clean, up-to-date `main` checkout after CI passes. Increment the
version without creating a Git tag automatically, review the manifest and lockfile
diff, then commit and tag the release:

```sh
npm version patch --no-git-tag-version
npm test
npm run test:package
git add package.json package-lock.json
git commit -m "Release 0.1.1"
git push origin main
git tag v0.1.1
git push origin v0.1.1
```

Replace `0.1.1` with the actual version. The release workflow repeats tests and
publishes the exact archive that passed installation verification. It also attaches
`SHA256SUMS`. Users can choose a stable version URL or the latest release:

```sh
npm install --global https://github.com/TwoTwo-me/confluence-wiki-md/releases/download/v0.1.1/confluence-wiki-md.tgz
npm install --global confluence-wiki-md@0.1.1
```

The second command works only after that version is published to the npm registry.

## Retry and diagnose

Use the Release workflow's manual run with the existing tag, or rerun the failed
job. The GitHub release job leaves an existing release untouched. A published npm
version cannot be overwritten; rerun only failed jobs after another job succeeded.
An intentionally disabled npm job appears as skipped until
`NPM_PUBLISH_ENABLED=true` is configured.

For npm authentication failures, verify the publisher's owner, repository,
workflow filename, environment, and permission to publish directly. All must
match the job. Do not change Confluence credentials to troubleshoot npm publishing.

If an archive must change after publication, release a new version instead of
moving an existing tag or replacing an already published package.
