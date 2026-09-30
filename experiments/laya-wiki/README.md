# Laya wiki retrieval feasibility study

This is a bounded, local-first experiment. The findings and limits are in [report.ko.md](report.ko.md); the sanitized measurements and public-only cases are in [results/summary.json](results/summary.json) and [results/public-cases.json](results/public-cases.json).

## Connected destination walks

The latest experiment follows only the current document's outgoing links, or explicit history `BACK` after that document's unvisited links are exhausted. It retains later local links, deduplicates destinations across provenance records, and charges Back as a navigation action. See [frozen public cases and labels](results/destination-cases.public.json) and [measurements with public traces](results/destination-walk-summary.json). Private Native names, IDs, URLs and routes remain in ignored local artifacts.

The ten frozen cases comprise three public named goals, two public questions, disconnected/absent controls, and three Native Notion named goals. Limits are twelve unique body reads, twenty-four actions and four current outgoing choices. Named arrival matches an unambiguous visible title or breadcrumb; question arrival uses the same Laya stop selector for every traversal policy. Gold IDs and evidence strings are evaluated after walking. Unlike the earlier frontier experiment below, each link step starts at the current node and stopping uses visible information. Current-body BM25 picks up to three paragraphs, clips their excerpt to 280 tokens, and packs a state of at most 700 tokens and options of at most 36 tokens under the pinned 1,024-token SDK budget. It never reads unchosen candidate bodies for selection.

The public graph contains 27 nodes and 41 body links. Native capture contributes 4,415 Markdown nodes with 13,178 provenance records and 8,800 distinct outgoing destinations from containment, breadcrumbs, collection rows/templates and body links. CSV is excluded as a page node. Native data was not uploaded to Confluence. A fresh GET replay verified seven pages on a successful public Laya route; model inference used verified snapshots. The source alias mapping does not rewrite original hrefs to internal Confluence links.

For the measured snapshot on this Mac, use the already frozen local artifacts:

```sh
HF_HUB_OFFLINE=1 USE_TF=0 sandbox-exec -p '(version 1) (allow default) (deny network*)' \
  artifacts/laya-wiki/venv/bin/python experiments/laya-wiki/destination_walk.py \
  --graph artifacts/laya-wiki/destination-walk/public-local-graph.json \
  --cases artifacts/laya-wiki/destination-walk/public-cases.json \
  --labels artifacts/laya-wiki/destination-walk/public-labels.json \
  --output artifacts/laya-wiki/destination-walk/reproduced-public.json \
  --device mps --max-reads 12 --max-actions 24 --max-options 4
```

The CLI writes full local traces and an exact serialized-state cache at the output's `.cache.json` sibling. A second run against that same cache should infer zero new states; preserve the first measurements before overwriting output. The executed paired Confluence run copied the exact public-local cache first, so its costs are incremental. Logical unique body reads come from loaded snapshots; they are not HTTP calls or total disk bytes. Cached CLI runs still load the model. `--fake-selector first` is a fixture mode and is never a real-model measurement. `--policies fifo,bm25` skips the model only when every case is a named goal.

To rebuild the Native graph from this Mac's captured source:

```sh
node experiments/laya-wiki/destination_graph.mjs \
  --corpus artifacts/laya-wiki/text-expansion/notion-live-corpus/corpus.json \
  --state artifacts/laya-wiki/text-expansion/notion-live/capture/state.json \
  --output artifacts/laya-wiki/destination-walk/rebuilt-notion-graph.json
```

Use `notion-graph.json`, `native-cases.json` and `native-labels.json` for the measured Native walk, or `public-confluence-graph.json` with the public cases/labels for the verified-copy walk. An independently collected corpus is a new dataset: do not call it the frozen snapshot or tune on the recorded cases. The tracked public bundle has separate `cases` and `labels` fields; extract those to individual JSON files for the CLI. Existing `graph_export.mjs` converts a public corpus to a graph and checks registered source aliases.

Relevant regression checks:

```sh
node --test experiments/laya-wiki/*.test.mjs
artifacts/laya-wiki/venv/bin/python -m pytest -q \
  experiments/laya-wiki/test_destination_walk.py \
  experiments/laya-wiki/test_graph_benchmark.py \
  experiments/laya-wiki/test_benchmark.py
```

Both local Laya and current-link BM25 reached 3/3 public named goals and 1/3 Native named goals. Laya read 23 versus 21 public bodies and 31 versus 28 Native bodies. The shared question stop selector halted without the required evidence on both questions and falsely arrived on the absent control. These observations do not establish cost savings or reliable autonomous answer sufficiency.

## Expanded text study

The October 1 update collected 9,434 owned GitHub document files and 4,568 Notion text documents, and verified publication/readback of all 2,238 public GitHub sources. See [expanded measurements](results/text-expansion-summary.json), [public questions](results/text-expansion-cases.public.json), and [fresh metadata-menu questions](results/metadata-cases.json). The expanded benchmark found no ranking or reading benefit over BM25, including a frozen four-question Notion probe on 14,002 combined local documents. The older 27-document and link experiments below remain separate campaigns.

The resumable collector fetches only eligible Git blobs, verifies Git object hashes and UTF-8, retains oversized text, and accounts for empty/binary/secret-looking/unavailable sources. It collects public and private sources; keep its output ignored:

```sh
node experiments/laya-wiki/text_corpus.mjs --owner TwoTwo-me \
  --output artifacts/laya-wiki/text-expansion/github
node experiments/laya-wiki/notion_text_export.mjs \
  --input "$NOTION_TEXT_EXPORT" --output artifacts/laya-wiki/text-expansion/notion
```

The Notion command reads an extracted Markdown/CSV directory without network access or media reads. Native UUID filenames retain page/database identity. Export-file accounting and unresolved references are explicit; this does not establish workspace or block completeness. In the executed update, the native workspace download did not arrive, so a private, logged-in Aside reader traversed native records, collection rows and templates. The observed queue is exhausted: 85,541 captured records, 4,415 page/view Markdown documents and 153 database CSV documents. Foreign/unknown/unavailable/deleted records and unsupported block properties are accounted for locally. The capped search inventory cannot prove that orphan pages outside observed roots were found.

The Notion probe compares original native-property text with a retrieval-only representation that removes native page-property JSON and its repeated appendix when body text remains. Property-only pages retain their original text; raw source capture is untouched. Questions about omitted property fields are outside this small probe. Both representations use their own global BM25 candidates with budgets 10 and 20. Clean-run scores reuse only exact matching raw-run cache keys, so its inference cost is incremental rather than a cold-run comparison. Private cases and grounding excerpts remain ignored; sanitized totals are included in the expanded measurements. Reproduce only with the frozen local artifacts:

```sh
HF_HUB_OFFLINE=1 USE_TF=0 sandbox-exec -p '(version 1) (allow default) (deny network*)' \
  artifacts/laya-wiki/venv/bin/python experiments/laya-wiki/benchmark.py \
  --corpus artifacts/laya-wiki/text-expansion/evaluation/notion-probe/raw-corpus.json \
  --cases artifacts/laya-wiki/text-expansion/evaluation/notion-probe/cases.json \
  --output artifacts/laya-wiki/text-expansion/evaluation/notion-probe/raw-benchmark.json \
  --device mps --mode normalized --limit-candidates 20 --batch-size 4
```

For the other representation use `clean-corpus.json` and `clean-benchmark.json`. An exact rerun uses the already populated corresponding cache; do not overwrite frozen cases or compare that cached runtime with a cold inference measurement. The remaining private-only offline publication plan accounts for 11,764 sources, including one explicit converter failure, without uploading private text or duplicating the already published public sources.

For an offline publication plan, provide a destination binding JSON with `tenant`, `apiUrl`, `v1Url`, `spaceId`, `spaceKey`, `rootId`, and `actorId`:

```sh
node experiments/laya-wiki/text_publish.mjs \
  --corpus "$PUBLIC_TEXT_CORPUS" --binding "$WIKI_STUDY_BINDING" \
  --output artifacts/laya-wiki/text-expansion/public-full
```

Add `--publish --env "$WIKI_STUDY_PROFILE"` only for an authorized live write. Private source text requires `--approval FILE` bound to this site/root/actor and explicit space-visibility consent; `--help` prints its schema. Current actor, destination and anonymous/unlicensed permissions are checked before writes. The human roster requires a fresh manual check. Missing consent and mismatched bindings refuse publication. Journals preserve accepted IDs, ambiguous mutations require reconciliation, and changed source/plan/bindings cannot silently resume. No automatic POST retry occurs. All body text is read back before a source is called verified.

The publisher chunks and deduplicates content, redacts signed/userinfo URLs, and creates repository catalogs with original source links. Notion parent IDs are retained in metadata; the catalogs do not reproduce native Notion hierarchy. The actual Free site rejects protected creation, so private publication remains pending approval of space permissions. Public publication is independently complete.

Use local frozen cases for the 9,434-document replay: the tracked public question file omits private identical-content alias IDs. Original corpus/cases SHA values and UTC freeze times are in the measurements. Do not replace the source snapshot or tune on these cases while comparing policies:

```sh
HF_HUB_OFFLINE=1 USE_TF=0 sandbox-exec -p '(version 1) (allow default) (deny network*)' \
  artifacts/laya-wiki/venv/bin/python experiments/laya-wiki/benchmark.py \
  --corpus artifacts/laya-wiki/text-expansion/github/corpus.json \
  --cases artifacts/laya-wiki/text-expansion/evaluation/github-cases.json \
  --output artifacts/laya-wiki/text-expansion/evaluation/github-benchmark.json \
  --device mps --mode normalized --limit-candidates 40
```

The smaller diagnostic uses genuinely public sources, metadata+text BM25 top-40 menus, four options, and at most eight logical reads including the start. These are virtual search menus, rather than native wiki links. The builder checks exact source quotes and freezes cases before inference:

```sh
node experiments/laya-wiki/metadata_probe.mjs \
  --output artifacts/laya-wiki/text-expansion/evaluation/metadata
HF_HUB_OFFLINE=1 USE_TF=0 sandbox-exec -p '(version 1) (allow default) (deny network*)' \
  artifacts/laya-wiki/venv/bin/python experiments/laya-wiki/graph_benchmark.py \
  --graph artifacts/laya-wiki/text-expansion/evaluation/metadata/graph.json \
  --cases artifacts/laya-wiki/text-expansion/evaluation/metadata/cases.json \
  --output artifacts/laya-wiki/text-expansion/evaluation/metadata/navigation.json \
  --device mps --max-reads 8 --max-options 4
node experiments/laya-wiki/metadata_probe.mjs \
  --output artifacts/laya-wiki/text-expansion/evaluation/metadata-paired \
  --frozen artifacts/laya-wiki/text-expansion/evaluation/metadata \
  --paired-corpus artifacts/laya-wiki/text-expansion/public-full/matched-corpus.json
```

Run the same navigation command against the paired graph/cases for comparison. The executed paired run copied the local exact-state cache, so its newly inferred state count is incremental. Both runs use oracle source-ID stopping and cached document reads; they do not prove autonomous answer sufficiency or live HTTP latency. The builder refuses an existing output directory, preserving the frozen snapshot.

Relevant checks:

```sh
node --test experiments/laya-wiki/text_corpus.test.mjs \
  experiments/laya-wiki/notion_text_export.test.mjs \
  experiments/laya-wiki/text_publish.test.mjs \
  experiments/laya-wiki/metadata_probe.test.mjs \
  experiments/laya-wiki/collector.test.mjs
```

## Requirements and setup

Use Node.js 24+, Python 3.12, `uv`, and (for GitHub collection) an authenticated `gh` CLI. The first model run downloads the pinned model revision; later offline runs need that revision cached.

```sh
npm ci
mkdir -p artifacts/laya-wiki
uv venv --python 3.12 artifacts/laya-wiki/venv
uv pip install --python artifacts/laya-wiki/venv/bin/python -r experiments/laya-wiki/pyproject.toml
uv pip install --python artifacts/laya-wiki/venv/bin/python pytest
```

The experiments write corpora, captures, HTTP receipts, and caches below `artifacts/laya-wiki/`. Keep that directory local and ignored. It may contain private Notion material and source metadata.

## Collect only the selected public GitHub Markdown

This is the reproducible public subset used for the paired corpus. Collection needs GitHub/network access and records a local manifest with exclusions and gaps.

```sh
node experiments/laya-wiki/collect.mjs \
  --owner TwoTwo-me \
  --only-repo TwoTwo-me/confluence-wiki-md \
  --only-repo TwoTwo-me/md-web-editor \
  --output artifacts/laya-wiki/public-scope
```

The collector caps each source file at 512 KiB and selected Markdown only. Linked assets remain links; it does not download or OCR them. It does not audit inherited Confluence access.

## Run local retrieval

The tracked cases reference only preregistered public sources. `compare` evaluates prefix, chunked, and normalized passages over the first 10 and all available candidates (the two selected repositories yielded 27 documents in this study).

```sh
artifacts/laya-wiki/venv/bin/python experiments/laya-wiki/benchmark.py \
  --corpus artifacts/laya-wiki/public-scope/corpus.json \
  --cases experiments/laya-wiki/results/public-cases.json \
  --output artifacts/laya-wiki/public-mps.json \
  --device mps --mode compare --limit-candidates 50
```

Use `--device cpu` where MPS is unavailable. For a previously cached model, an offline run can be constrained on macOS:

```sh
HF_HUB_OFFLINE=1 sandbox-exec -p '(version 1) (allow default) (deny network*)' \
  artifacts/laya-wiki/venv/bin/python experiments/laya-wiki/benchmark.py \
  --corpus artifacts/laya-wiki/public-scope/corpus.json \
  --cases experiments/laya-wiki/results/public-cases.json \
  --output artifacts/laya-wiki/public-offline.json \
  --device mps --mode normalized --limit-candidates 50
```

For a separate private, local-only evaluation, point `--corpus` and `--cases` at files you are authorized to use under `artifacts/laya-wiki/`; never commit those files. `--mode` accepts `prefix`, `chunks`, `normalized`, or `compare`. `--limit-candidates` accepts 10–50. The fixed `--threshold` default of 0.7 is exploratory and not calibrated.

## Try locally captured Notion data

The collector accepts manually captured JSON and `.json.capture` files containing the native `<content>` body. It records truncation, unknown blocks, missing children, and malformed captures as gaps; it does not complete an account export. Keep `$NOTION_CAPTURE_DIR` outside tracked files:

```sh
node experiments/laya-wiki/collect.mjs \
  --owner TwoTwo-me \
  --only-repo TwoTwo-me/confluence-wiki-md \
  --only-repo TwoTwo-me/md-web-editor \
  --notion-dir "$NOTION_CAPTURE_DIR" \
  --output artifacts/laya-wiki/local-only
```

The Laya benchmark reads the resulting local corpus and makes no paid model API calls. Keep private captures local unless the destination’s effective restrictions are confirmed; publishing material where others can read it requires separate authorization.

## Confluence test with public-source material

These commands require a configured local profile for the isolated `AGENTTEST` space. `import` writes pages; `reconcile` checks known IDs read-only; `readback` verifies fetched content; `query` is scoped to the experiment root. Use a public-only corpus and keep receipts local. The query limit is 20; a result count equal to the limit may be truncated, and one live query is not a latency benchmark.

```sh
node experiments/laya-wiki/confluence.mjs import \
  --corpus artifacts/laya-wiki/public-scope/corpus.json \
  --output artifacts/laya-wiki/confluence-public
node experiments/laya-wiki/confluence.mjs reconcile \
  --corpus artifacts/laya-wiki/public-scope/corpus.json \
  --output artifacts/laya-wiki/confluence-public
node experiments/laya-wiki/confluence.mjs readback \
  --corpus artifacts/laya-wiki/public-scope/corpus.json \
  --output artifacts/laya-wiki/confluence-public
node experiments/laya-wiki/confluence.mjs query "Markdown" --limit 20 --output artifacts/laya-wiki/confluence-public
```

## Follow real document links

The graph experiment freezes hyperlinks between public documents already collected. It compares FIFO, metadata BM25, Laya over all pending links discovered in visited pages, and strict Laya over only the current page's links. Each case permits 8 unique reads including the start and a 5-option menu. Single-option steps bypass inference. There is no global search or live HTTP inside navigation. Known target IDs stop evaluation; the model does not decide answer sufficiency.

The executed 24 public cases and paired measurements are in [graph-cases.json](results/graph-cases.json) and [graph-summary.json](results/graph-summary.json). Six named cases are the first sorted natural 2–3-hop pairs; question cases use both fixed repository roots. Recollection from a newer repository revision can change IDs/links; retain the captured corpus when replaying these cases.

```sh
node experiments/laya-wiki/graph_export.mjs \
  --corpus artifacts/laya-wiki/public-scope/corpus.json \
  --output artifacts/laya-wiki/graph/local-graph.json \
  --cases-output artifacts/laya-wiki/graph/cases.json
node experiments/laya-wiki/graph_export.mjs \
  --corpus artifacts/laya-wiki/confluence-public/confluence-corpus.json \
  --mode confluence-readback --output artifacts/laya-wiki/graph/confluence-graph.json
HF_HUB_OFFLINE=1 USE_TF=0 sandbox-exec -p '(version 1) (allow default) (deny network*)' \
  artifacts/laya-wiki/venv/bin/python experiments/laya-wiki/graph_benchmark.py \
  --graph artifacts/laya-wiki/graph/local-graph.json \
  --cases artifacts/laya-wiki/graph/cases.json \
  --output artifacts/laya-wiki/graph/local.json --device mps
HF_HUB_OFFLINE=1 USE_TF=0 sandbox-exec -p '(version 1) (allow default) (deny network*)' \
  artifacts/laya-wiki/venv/bin/python experiments/laya-wiki/graph_benchmark.py \
  --graph artifacts/laya-wiki/graph/confluence-graph.json \
  --cases artifacts/laya-wiki/graph/cases.json \
  --output artifacts/laya-wiki/graph/confluence.json --device mps
node --test experiments/laya-wiki/graph_export.test.mjs
```

Each output gets a content-addressed sibling `.cache.json`; use a fresh output path for cold-state measurements. Both policies share that process cache, and the built-in repeat verifies identical paths with no new inference. Keep raw graphs, traces, documents and decision caches ignored. The executed study reused `pilot/shared-local-corpus.json` and a fresh `pilot/confluence-corpus.json`, with no new collection or publication.

## Route and unit checks

The routing script compares a manually curated collection taxonomy with unrestricted BM25. It accepts `--device cpu|mps` and needs a corpus/cases path. The study command was run against local-only pilot artifacts; those private files are deliberately not included here.

```sh
artifacts/laya-wiki/venv/bin/python experiments/laya-wiki/route_benchmark.py --corpus artifacts/laya-wiki/available-corpus.json \
  --cases artifacts/laya-wiki/pilot/cases.json --output artifacts/laya-wiki/route.json --device mps
artifacts/laya-wiki/venv/bin/python -m pytest experiments/laya-wiki -q
npm test
node --test experiments/laya-wiki/collector.test.mjs
```
