The npm package is now `@twotwo-me/confluence-wiki-md` on GitHub Packages. If you
installed version 0.1.1 or earlier, first run `npm uninstall --global confluence-wiki-md`
and update your agent skill symlink after installing the new package.

Authenticate with your GitHub username and a classic PAT with `read:packages`:

```sh
npm login --scope=@twotwo-me --auth-type=legacy --registry=https://npm.pkg.github.com
npm install --global @twotwo-me/confluence-wiki-md
cfwiki --help
```

To install the same package without GitHub Packages authentication:

```sh
npm install --global https://github.com/TwoTwo-me/confluence-wiki-md/releases/latest/download/confluence-wiki-md.tgz
cfwiki --help
```

Node.js 24 or later is required. The package includes Cloud and corporate PAT
configuration templates, Markdown examples, and the `confluence-wiki` agent skill.
Each user supplies their own Confluence credentials.

See the [installation and authentication guide](https://github.com/TwoTwo-me/confluence-wiki-md#readme).
`SHA256SUMS` contains the SHA-256 checksum of the package archive.
