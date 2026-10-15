## Create and update

Start new files with YAML `type` and `title`, followed by Markdown. Recommended
OKF fields are `description`, `resource`, `tags`, and `sources`. Preserve unknown
metadata. Do not invent `verified`, provenance, or trust status.

```sh
cfwiki validate wiki/guide.md
cfwiki upload wiki/guide.md --space DOCS --dry-run
cfwiki upload wiki/guide.md --space DOCS
```

Upload creates a page when no `confluence.id` exists. It writes the page identity
and version back into the local file. For updates, first download current content,
edit the body, and upload the same file. Keep `confluence.api_url`, `site_url`, `id`,
`version`, `storage_hash`, `base_body_hash`, and any remaining `preserved` entries. Never bump versions manually or
remove binding metadata to bypass a conflict. Download and merge when stale.
Front matter identifies the server; only the selected environment routes credentials.
Do not recompute the baseline while editing. Downloads set it from the returned
body; uploads refresh it only after successful synchronization. A dry run or
partial upload failure retains the previous baseline.

Normal Markdown links and images work. Fences tagged `mermaid`, `uml`, or `plantuml`
are validated locally and published as native Confluence macros by default. Run
`cfwiki validate FILE.md` for local syntax checks, or add `--server` to check the
Confluence preview too. Upload and push perform both checks before page writes.
The environment must map the installed app's actual macro name through
`CONFLUENCE_MERMAID_MACRO` / `CONFLUENCE_PLANTUML_MACRO`. Source-parameter apps also
need `CONFLUENCE_<ENGINE>_SOURCE_PARAMETER`. Never guess the installed app or silently
replace a failed diagram with an image. Use `--diagrams code` only when the user
intends to display literal source without diagram validation/rendering.

For Cloud Forge apps, copy the actual `extension-key` from a page made by the app
to `CONFLUENCE_<ENGINE>_FORGE_EXTENSION_KEY`. Use `ADAPTER=forge` for a string source
parameter, or `ADAPTER=mermaid-viewer` for Atlassian Labs Mermaid diagrams viewer.
Narva PlantUML uses `SOURCE_PARAMETER=diagram-code`. The viewer adapter keeps a
native code block beside the macro and binds its index automatically. Download
merges them into one Mermaid fence. Unknown Forge extensions retain a page URL
and their complete original XML. See README for full profiles and limitations.

Prefer native Confluence template IDs: `cfwiki templates list --space DOCS`
lists space templates; omitting space lists global templates; `--blueprints` lists
blueprints. `cfwiki templates read ID -o draft.md` creates an editable draft.
Set `CONFLUENCE_TEMPLATE=123456` or use `--template ID`; prefix non-numeric IDs
with `confluence:`. Native templates apply once when creating pages. A standalone
`{{cfwiki.body}}` paragraph receives the Markdown body; otherwise it is appended.
The returned MD includes the whole template and `confluence.template_id`, so later
updates do not duplicate it or reapply changes made to the remote template.
Native template lookup in local validate/convert requires `--server`; use
`--template none` for local-only checks. Unresolved variables and template
attachments fail before writing. Cloud template reads need `read:template:confluence`
and `read:content-details:confluence`; Data Center defaults to `/rest/experimental`
with `CONFLUENCE_TEMPLATE_API_URL` for explicit server/gateway overrides.

For local conversion settings, `CONFLUENCE_TEMPLATE` also selects `default` (one top TOC for H2-H3), `none`, or a YAML
template; `--template` overrides it for conversion, validation, upload and push.
Relative paths in the environment resolve beside the selected `.env`; CLI paths
resolve from the working directory. Missing files or invalid templates fail.
YAML uses `version: 1`, optional `toc: {enabled, position, parameters}` and
`diagrams: {mode, mermaid, plantuml}`. See `examples/wiki-template.yaml` in the
installed package. `none` disables template processing; `toc.enabled: false`
removes existing TOCs. Template TOCs replace existing ones instead of accumulating.
`--diagrams` overrides template mode, then `CONFLUENCE_DIAGRAM_MODE`, then `macro`.
Template app parameters override matching profile keys; credentials remain in
the environment. Read/download/export use template app mappings to decode diagrams
without inserting a TOC. Native TOCs download as compact `confluence-toc` YAML fences
in minimal/none mode and regenerate as real TOC macros, including their parameters.
Keep these fences to retain the TOC position and settings across edits.

Local validation needs Chrome and, for UML, PlantUML/Java. Renderer versions appear
in validation output. Confluence's app version can differ. A server preview may
contain a dynamic iframe; acceptance does not prove its final diagram rendered.
Confirm actual web output when testing a new app integration.

Common rich blocks are editable Markdown fences: `confluence-info`,
`confluence-note`, `confluence-tip`, `confluence-warning`, `confluence-panel`,
`confluence-expand`, and `confluence-quote`. The body is Markdown; an optional
opening `---` YAML mapping and closing `---` retain scalar native parameters
such as a title. Use a longer outer fence when nesting code fences. Example:

````markdown
```confluence-info
---
title: Deployment note
---
**Keep the backup.** [Runbook](./runbook.md)
```
````

Links, images and diagrams inside these blocks are resolved and validated like
ordinary Markdown. Customized structures the converter cannot reconstruct retain
original XML. Keep their fallback text and `preserved` entry unchanged unless
replacing that feature is intended.

Preservation defaults to `minimal`; `--preserve minimal|all|none` overrides
`CONFLUENCE_PRESERVE`. Minimal drops redundant XML for ordinary Markdown, configured
Mermaid/PlantUML diagrams, simple images and page links. An empty `preserved` field
is omitted. Unknown apps, merged/nested tables, mentions, custom code titles/options
and image sizes retain XML because Markdown alone cannot reconstruct them.
`all` keeps original fragments in the file; configured diagrams still regenerate
from validated sources on upload. `none` removes every preserved fragment and
reports elements whose native behavior may be lost. Do not claim all native
features survive none mode merely because their reference links remain.
Remaining preserved elements restore when their Markdown representation is unchanged;
editing a fallback replaces the element. Use ordinary MD plus `confluence-toc`
fences for cache-free authoring of supported content. Tables keep literal pipes and
line breaks; subscript/superscript use inline HTML. Markdown spelling and spacing
may normalize without changing content. Consult the original page for unknown apps.
Cloud uploads flatten nested quotes with visible `›` depth markers because native
nested quote HTML can render at zero width. Keep these markers when editing the
downloaded MD; they retain the readable quote depth without preserved XML.

