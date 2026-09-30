#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.12"
# dependencies = ["laya==0.3.22", "torch==2.14.0", "transformers==5.17.0", "pydantic==2.13.5", "typer==0.27.2"]
# ///
# How to run: use artifacts/laya-wiki/venv/bin/python route_benchmark.py --corpus CORPUS --cases CASES --output OUTPUT
"""Query-only collection routing with a manually curated four-domain pilot taxonomy."""
from __future__ import annotations

import json
import os
import resource
import sys
import time
from pathlib import Path
from typing import Final, Literal

import typer
from pydantic import BaseModel, Field, TypeAdapter

from models import BM25, BenchmarkError, Case, Document, Metrics, inputs, metrics

MODEL: Final = "convaiinnovations/laya-multilingual"
REVISION: Final = "e4e9ddf21a7b1903b7acffd8814ad4307bf63a67"
Bucket = Literal["A", "B", "C", "D", "E"]
CRITERIA: Final = {
    "A": "Markdown web editor local notes, keyboard commands, offline browser origin and split panes",
    "B": "Confluence Markdown wiki CLI, auth tokens, page publishing, templates, restrictions and release",
    "C": "Notion personal technical/project notes, coding practices, Docker and Notion network projects",
    "D": "Other GitHub application documents: application features, backend APIs, data schemas and deployment",
    "E": "No matching collection; question unrelated to these sources",
}


def bucket(doc: Document) -> Bucket:
    if doc.source_type == "notion":
        return "C"
    if doc.source_type != "github":
        raise BenchmarkError(f"Unsupported source type: {doc.source_type}")
    if doc.source_path.startswith("TwoTwo-me/md-web-editor/"):
        return "A"
    if doc.source_path.startswith("TwoTwo-me/confluence-wiki-md/"):
        return "B"
    return "D"


def expected_buckets(case: Case, docs: list[Document]) -> list[Bucket]:
    """Derive labels exclusively from preregistered IDs and explicit unanswerable cases."""
    expected = sorted({bucket(d) for d in docs if d.id in case.relevant_ids})
    return expected or (["E"] if case.kind == "unanswerable" else [])


class Probabilities(BaseModel):
    A: float = Field(ge=0, le=1, allow_inf_nan=False)
    B: float = Field(ge=0, le=1, allow_inf_nan=False)
    C: float = Field(ge=0, le=1, allow_inf_nan=False)
    D: float = Field(ge=0, le=1, allow_inf_nan=False)
    E: float = Field(ge=0, le=1, allow_inf_nan=False)


class Decision(BaseModel):
    choice: Bucket
    probabilities: Probabilities


class Answers(BaseModel):
    collection: Decision


class Usage(BaseModel):
    input_tokens: int = Field(ge=0)
    state_tokens_dropped: int = Field(ge=0)
    truncated_questions: list[str]


class Prediction(BaseModel):
    answers: Answers
    usage: Usage


class Row(BaseModel):
    case_id: str
    split: str
    expected_buckets: list[Bucket]
    predicted_bucket: Bucket
    route_correct: bool | None
    expected_ids_in_route: list[str]
    route_size: int
    probabilities: Probabilities
    routed: Metrics
    unrestricted: Metrics
    routed_ids: list[str]
    unrestricted_ids: list[str]
    usage: Usage


def main(corpus: Path = typer.Option(...), cases: Path = typer.Option(...), output: Path = typer.Option(...), device: Literal["cpu", "mps"] = "cpu") -> None:
    """Score queries once, then compare routed and unrestricted local BM25 retrieval."""
    started = time.perf_counter()
    docs, queries = inputs(corpus, cases)
    expected = [expected_buckets(q, docs) for q in queries]
    groups = {label: [d for d in docs if bucket(d) == label] for label in CRITERIA}
    index_started = time.perf_counter()
    indexes = {label: BM25([d.title + "\n" + d.text for d in group]) for label, group in groups.items()}
    unrestricted = BM25([d.title + "\n" + d.text for d in docs])
    index_seconds = time.perf_counter() - index_started
    os.environ["USE_TF"] = "0"
    import laya
    import torch
    torch.manual_seed(0)
    torch.set_num_threads(min(4, os.cpu_count() or 1))
    load_started = time.perf_counter()
    agent = laya.load(MODEL, revision=REVISION, device=device)
    load_seconds = time.perf_counter() - load_started
    instruction = "Which document collection should be searched first to answer this query?"
    head_tokens = sum(len(agent.tok.encode(text, add_special_tokens=False)) for text in [instruction, *CRITERIA.values()]) + 20
    if head_tokens >= 256:
        raise BenchmarkError("Curated taxonomy exceeds 255-token conservative head allowance")
    inference_started = time.perf_counter()
    raw = agent.predict_batch([{"query": q.query} for q in queries], {"collection": {"type": "choice", "instructions": instruction, "criteria": CRITERIA}}, batch_size=len(queries), max_len=1024, head_max_len=255)
    predictions = TypeAdapter(list[Prediction]).validate_python(raw)
    inference_seconds = time.perf_counter() - inference_started
    if len(predictions) != len(queries):
        raise BenchmarkError("Router output count differs from query count")
    rows = []
    for case, labels, prediction in zip(queries, expected, predictions, strict=True):
        choice = prediction.answers.collection.choice
        group = groups[choice]
        ranked = [group[i].id for i in indexes[choice].rank(case.query)]
        baseline = [docs[i].id for i in unrestricted.rank(case.query)]
        rows.append(Row(case_id=case.id, split=case.split, expected_buckets=labels, predicted_bucket=choice, route_correct=choice in labels if labels else None, expected_ids_in_route=sorted(set(case.relevant_ids) & {d.id for d in group}), route_size=len(group), probabilities=prediction.answers.collection.probabilities, routed=metrics(ranked, case, [d.id for d in group]), unrestricted=metrics(baseline, case, [d.id for d in docs]), routed_ids=ranked[:10], unrestricted_ids=baseline[:10], usage=prediction.usage))
    aggregates = []
    for split in sorted({r.split for r in rows}):
        cohort = [r for r in rows if r.split == split]
        labeled = [r for r in cohort if r.route_correct is not None]
        positive = [r for r in cohort if r.expected_buckets and r.expected_buckets != ["E"]]
        aggregates.append({"split": split, "queries": len(cohort), "labeled": len(labeled), "positive_queries": len(positive), "route_accuracy": sum(bool(r.route_correct) for r in labeled)/len(labeled) if labeled else None, **{policy: {key: sum(getattr(getattr(r, policy), key) for r in positive)/len(positive) if positive else None for key in ("recall3", "hit3", "mrr")} for policy in ("routed", "unrestricted")}})
    result = {"taxonomy": "Manually curated four-domain pilot; not learned or generic production routing", "criteria": CRITERIA, "model": MODEL, "revision": REVISION, "sdk_version": laya.__version__, "device": device, "rows": [r.model_dump() for r in rows], "aggregates": aggregates, "document_body_tokens_sent": 0, "external_paid_inference_calls": 0, "inference_states": len(queries), "input_tokens": sum(r.usage.input_tokens for r in rows), "truncated_questions": [r.case_id for r in rows if r.usage.truncated_questions], "head_tokens_conservative_estimate": head_tokens, "head_max_len": 255, "latency_seconds": {"index": index_seconds, "load": load_seconds, "routing": inference_seconds, "total": time.perf_counter()-started}, "peak_rss_bytes": resource.getrusage(resource.RUSAGE_SELF).ru_maxrss*(1 if sys.platform == "darwin" else 1024), "candidate_ids_policy": "Full corpus, identical query cohort for both methods; case candidate_ids unused"}
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(result, ensure_ascii=False, indent=2, allow_nan=False) + "\n")


if __name__ == "__main__":
    typer.run(main)
