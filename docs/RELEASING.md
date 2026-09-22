# Package releases

The package name is `@twotwo-me/confluence-wiki-md`; the installed command is
`cfwiki`. Node.js 24 or later is required. Versions 0.1.2 and later publish to the
GitHub Packages npm registry and GitHub Releases. npmjs.org is not a publication
target. The release archive is an alternative for users without a GitHub token.

## Workflows

| Workflow | Trigger | Result |
| --- | --- | --- |
| `ci.yml` | Main push, pull request, manual run | Tests and isolated package installation on Linux and macOS |
| `release.yml` | `vX.Y.Z` tag push, manual retry with an existing tag | GitHub Release, GitHub Packages publication, and installation from the registry |

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

## GitHub Packages setup

The package uses the lowercase owner scope `@twotwo-me`, a repository URL pointing
to `TwoTwo-me/confluence-wiki-md`, and `publishConfig.registry` set to
`https://npm.pkg.github.com/`. The tracked `.npmrc` contains only the scope mapping;
never add tokens to it.

The `github-packages` job has `packages: write` and publishes the verified archive
using its automatic `GITHUB_TOKEN`. No npm account, trusted publisher, repository
variable, or manually saved publish token is required. A separate
`registry-install` job has only `packages: read`, downloads and verifies the
published package, and installs it under an isolated prefix before running the CLI.
Package installation scripts are disabled during that authenticated check.

On the first publication, inspect the package's settings on GitHub and set its
visibility to **Public**. GitHub packages initially default to private even when
the linked repository is public. Access inheritance and package visibility are
separate settings. See [GitHub's package visibility documentation](https://docs.github.com/en/packages/learn-github-packages/configuring-a-packages-access-control-and-visibility).

Public npm packages on GitHub still require authentication to install. Users need
their own classic PAT with `read:packages`; the Confluence token is unrelated.

```sh
npm login --scope=@twotwo-me --auth-type=legacy --registry=https://npm.pkg.github.com
npm install --global @twotwo-me/confluence-wiki-md
```

See [GitHub's npm registry documentation](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-npm-registry).
Users upgrading from 0.1.1 or earlier must first uninstall the old unscoped package
with `npm uninstall --global confluence-wiki-md`, then reinstall and update any
agent skill symlink to the scoped package directory. The `cfwiki` command is unchanged.

## Publish a new version

Start from a clean, up-to-date `main` checkout after CI passes. Increment the
version without creating a Git tag automatically, review the manifest and lockfile
diff, then commit and tag the release:

```sh
npm version patch --no-git-tag-version
npm test
npm run test:package
git add package.json package-lock.json
git commit -m "Release 0.1.3"
git push origin main
git tag v0.1.3
git push origin v0.1.3
```

Replace `0.1.3` with the actual version. The release workflow repeats tests and
publishes the exact archive that passed installation verification. It also attaches
`SHA256SUMS`. Users can choose a stable version URL or the latest release:

```sh
npm install --global https://github.com/TwoTwo-me/confluence-wiki-md/releases/download/v0.1.2/confluence-wiki-md.tgz
npm install --global @twotwo-me/confluence-wiki-md@0.1.2
```

The second command requires a GitHub Packages login.

## Retry and diagnose

Use the Release workflow's manual run with the existing tag, or rerun the failed
job. The GitHub release job leaves an existing release untouched. A published
package version cannot be overwritten; rerun only failed jobs after another job
succeeded. In particular, retry a failed `registry-install` job without repeating
an already successful publication.

For authentication failures, check the lowercase scope, registry URL, workflow
package permissions, and the package's repository link or Actions access. User
installation tokens need `read:packages`. Do not change Confluence credentials to
troubleshoot package publishing or installation.

If an archive must change after publication, release a new version instead of
moving an existing tag or replacing an already published package.
