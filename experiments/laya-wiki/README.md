# Laya wiki retrieval feasibility study

This is a bounded, local-first experiment. The findings and limits are in [report.ko.md](report.ko.md); the sanitized measurements and public-only cases are in [results/summary.json](results/summary.json) and [results/public-cases.json](results/public-cases.json).

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
