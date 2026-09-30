#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.12"
# dependencies = ["laya==0.3.22", "torch==2.14.0", "transformers==5.17.0", "pydantic==2.13.5", "typer==0.27.2"]
# ///
# How to run: artifacts/laya-wiki/venv/bin/python graph_benchmark.py --graph GRAPH --cases CASES --output OUTPUT
# noqa: SIZE_OK -- One standalone navigation experiment; assignment restricts implementation to this file.
"""Bounded navigation over frozen public links; source-ID stopping is an evaluation oracle."""
from __future__ import annotations

import json
import os
import resource
import sys
import time
from collections import deque
from dataclasses import dataclass
from pathlib import Path
from typing import Annotated, Final, Literal, NewType, Protocol, assert_never

import typer
from pydantic import BaseModel, ConfigDict, Field, JsonValue, TypeAdapter, ValidationError

from models import BM25, BenchmarkError, Tokenizer, digest, normalize_text

MODEL: Final = "convaiinnovations/laya-multilingual"
REVISION: Final = "e4e9ddf21a7b1903b7acffd8814ad4307bf63a67"
INSTRUCTION: Final = "Select the next linked document to read for the query."
POLICIES: Final = ("fifo", "bm25", "laya", "strictLaya")
Policy = Literal["fifo", "bm25", "laya", "strictLaya"]
NodeId = NewType("NodeId", str)
Probability = Annotated[float, Field(ge=0, le=1, allow_inf_nan=False)]


class Boundary(BaseModel):
    model_config = ConfigDict(frozen=True, strict=True, extra="ignore")


class Link(Boundary):
    target_id: NodeId
    label: str
    source_url: str


class Node(Boundary):
    id: NodeId
    title: str
    text: str
    source_path: str
    source_url: str
    private: Literal[False]
    links: list[Link]


class Graph(Boundary):
    schema_version: Literal[1] = Field(alias="schema")
    source_mode: Literal["local", "confluence-readback"]
    nodes: list[Node] = Field(min_length=1)
    summary: dict[str, JsonValue]


class Case(Boundary):
    id: str = Field(min_length=1)
    kind: Literal["named-goal", "question", "unanswerable", "unreachable"]
    query: str = Field(min_length=1)
    start_id: NodeId
    target_ids: list[NodeId]
    split: Literal["test", "calibration"]


def inputs(graph: Path, cases: Path) -> tuple[Graph, list[Case]]:
    data = Graph.model_validate_json(graph.read_bytes())
    queries = TypeAdapter(list[Case]).validate_json(cases.read_bytes())
    ids = {n.id for n in data.nodes}
    if len(ids) != len(data.nodes) or not queries or len({q.id for q in queries}) != len(queries):
        raise BenchmarkError("Duplicate nodes/cases or empty cases")
    if any(link.target_id not in ids for n in data.nodes for link in n.links):
        raise BenchmarkError("Unknown link target")
    for q in queries:
        if not q.query.strip() or q.start_id not in ids or set(q.target_ids) - ids:
            raise BenchmarkError(f"Invalid case: {q.id}")
        if q.kind == "unanswerable" and q.target_ids:
            raise BenchmarkError("Unanswerable controls must have no targets")
        if q.kind != "unanswerable" and not q.target_ids:
            raise BenchmarkError("Answerable/unreachable cases require targets")
    return data, queries


class Usage(Boundary):
    input_tokens: int = Field(ge=0)
    state_tokens: int = Field(ge=0)
    state_tokens_dropped: int = Field(ge=0)
    truncated: bool
    truncated_questions: list[str]


class Decision(Boundary):
    choice: str
    probabilities: dict[str, Probability]


class Prediction(Boundary):
    answers: dict[str, Decision]
    usage: Usage

    def checked(self, options: list[str]) -> Prediction:
        if set(self.answers) != {"next"}:
            raise BenchmarkError("SDK dropped or changed the next-document question")
        answer = self.answers["next"]
        if answer.choice not in options or set(answer.probabilities) != set(options):
            raise BenchmarkError("SDK choice/probabilities differ from offered menu")
        if self.usage.state_tokens_dropped > self.usage.state_tokens:
            raise BenchmarkError("Invalid SDK token accounting")
        return self


@dataclass(frozen=True, slots=True)
class Edge:
    parent: Node
    target: Node
    label: str


@dataclass(frozen=True, slots=True)
class Observation:
    query: str
    current: Node
    visited: list[Node]
    menu: list[Edge]


class Selection(Boundary):
    index: int
    input_tokens: int = 0
    model_calls: int = 0
    cache_hits: int = 0
    state_tokens_dropped: int = 0
    packed_tokens_dropped: int = 0
    head_tokens: int = 0
    inference_seconds: float = 0


class Selector(Protocol):
    def choose(self, observation: Observation) -> Selection: ...


class Row(Boundary):
    case_id: str
    kind: str
    split: str
    policy: Policy
    start_is_target: bool
    reachable: bool
    shortest_path: int | None
    success: bool
    reason: str
    visited_ids: list[NodeId]
    trace: list[dict[str, JsonValue]]
    decisions: list[Selection]
    read_count: int
    hops: int
    input_tokens: int
    model_calls: int
    cache_hits: int
    inference_seconds: float
    index_seconds: float


@dataclass(frozen=True, slots=True)
class Navigation:
    graph: Graph
    selector: Selector
    max_reads: int = 8
    max_options: int = 5

    def run(self, case: Case, policy: Policy) -> Row:
        nodes = {n.id: n for n in self.graph.nodes}
        distances, queue = {case.start_id: 0}, deque([case.start_id])
        while queue:
            parent = queue.popleft()
            for link in nodes[parent].links:
                if link.target_id not in distances:
                    distances[link.target_id] = distances[parent] + 1
                    queue.append(link.target_id)
        shortest = min((distances[i] for i in case.target_ids if i in distances), default=None)
        visited, pending, trace, decisions = [nodes[case.start_id]], [], [], []
        index_seconds = 0.0
        success, reason = False, "read_budget"
        while True:
            current = visited[-1]
            seen = {n.id for n in visited}
            if current.id in case.target_ids and case.kind not in ("unanswerable", "unreachable"):
                success, reason = True, "goal_reached"
                break
            if len(visited) >= self.max_reads:
                break
            pending = [] if policy == "strictLaya" else [e for e in pending if e.target.id not in seen]
            discovered = seen | {e.target.id for e in pending}
            for link in current.links:
                if link.target_id not in discovered:
                    pending.append(Edge(current, nodes[link.target_id], link.label))
                    discovered.add(link.target_id)
            menu = pending[:self.max_options]
            if not menu:
                reason = "greedy_stalled" if policy == "strictLaya" else "frontier_exhausted"
                break
            match policy:
                case "fifo":
                    selection = Selection(index=0)
                case "bm25":
                    started = time.perf_counter()
                    index = BM25([f"{e.target.source_path} {e.target.title} {e.label}" for e in menu])
                    selection = Selection(index=index.rank(case.query)[0])
                    index_seconds += time.perf_counter() - started
                case "laya" | "strictLaya":
                    selection = Selection(index=0) if len(menu) == 1 else self.selector.choose(Observation(case.query, current, visited, menu))
                case unknown:
                    assert_never(unknown)
            if not 0 <= selection.index < len(menu):
                raise BenchmarkError("Selected index outside offered menu")
            edge = menu[selection.index]
            pending.remove(edge)
            visited.append(edge.target)
            trace.append({"source_id": edge.parent.id, "target_id": edge.target.id, "source_path": edge.parent.source_path, "target_path": edge.target.source_path, "label": edge.label, "read_number": len(visited)})
            decisions.append(selection)
        return Row(case_id=case.id, kind=case.kind, split=case.split, policy=policy, start_is_target=case.start_id in case.target_ids, reachable=shortest is not None, shortest_path=shortest, success=success, reason=reason, visited_ids=[n.id for n in visited], trace=trace, decisions=decisions, read_count=len(visited), hops=len(trace), input_tokens=sum(d.input_tokens for d in decisions), model_calls=sum(d.model_calls for d in decisions), cache_hits=sum(d.cache_hits for d in decisions), inference_seconds=sum(d.inference_seconds for d in decisions), index_seconds=index_seconds)


def pack(observation: Observation, tok: Tokenizer) -> tuple[str, dict[str, str], int]:  # noqa: DICT_OK -- SDK criteria mapping
    def clip(text: str, limit: int) -> str:
        return tok.decode(tok.encode(text, add_special_tokens=False)[:limit], skip_special_tokens=True)
    criteria = {chr(65+i): clip(f"{e.target.source_path} | {e.label}", 36) for i, e in enumerate(observation.menu)}
    prefix = json.dumps({"query": observation.query, "current": observation.current.source_path, "visited": [clip(n.source_path, 18) for n in observation.visited], "parents": {chr(65+i): clip(e.parent.source_path, 18) for i, e in enumerate(observation.menu)}}, ensure_ascii=False)
    excerpt = "\nCurrent document excerpt:\n" + normalize_text(observation.current.text)
    available = 700 - len(tok.encode(prefix, add_special_tokens=False))
    if available < 32:
        raise BenchmarkError("Query/path state exceeds 700-token allowance")
    state = prefix + clip(excerpt, min(220, available))
    while len(tok.encode(state, add_special_tokens=False)) > 700:
        available -= 8
        state = prefix + clip(excerpt, min(220, available))
    return state, criteria, max(0, len(tok.encode(prefix + excerpt, add_special_tokens=False)) - len(tok.encode(state, add_special_tokens=False)))


class LayaSelector:
    """Own one loaded model and a mutable content-addressed decision cache."""
    def __init__(self, output: Path, device: str) -> None:
        os.environ["USE_TF"] = "0"
        import laya
        import torch
        torch.manual_seed(0)
        torch.set_num_threads(4)
        self.sdk, self.device = laya.__version__, device
        self.path = output.with_suffix(".cache.json")
        self.cache = TypeAdapter(dict[str, Prediction]).validate_json(self.path.read_bytes()) if self.path.exists() else {}
        self.agent = laya.load(MODEL, revision=REVISION, device=device)
        self.namespace = json.dumps([MODEL, REVISION, self.sdk, device, 1024, 255])

    def choose(self, observation: Observation) -> Selection:
        from laya.common import build_sequence
        state, criteria, dropped = pack(observation, self.agent.tok)
        question = {"type": "choice", "instructions": INSTRUCTION, "criteria": criteria}
        internal = {"t": "choice", "ins": INSTRUCTION, "crit": criteria}
        head, markers, stats = build_sequence(self.agent.tok, "", internal, max_len=1024, head_max_len=255, return_stats=True)
        if len(head) > 255 or len(markers) != len(criteria) or stats["options_distinct"] != len(criteria):
            raise BenchmarkError("SDK question head does not fit or loses options")
        key = digest(self.namespace + state + json.dumps(question, ensure_ascii=False))
        hit, elapsed = key in self.cache, 0.0
        if not hit:
            started = time.perf_counter()
            raw = self.agent.predict_batch([state], {"next": question}, batch_size=1, max_len=1024, head_max_len=255)
            predictions = TypeAdapter(list[Prediction]).validate_python(raw)
            if len(predictions) != 1:
                raise BenchmarkError("SDK output count differs from one state")
            self.cache[key] = predictions[0].checked(list(criteria))
            elapsed = time.perf_counter() - started
            self.path.parent.mkdir(parents=True, exist_ok=True)
            temporary = self.path.with_suffix(".tmp")
            temporary.write_bytes(TypeAdapter(dict[str, Prediction]).dump_json(self.cache))
            temporary.replace(self.path)
        prediction = self.cache[key].checked(list(criteria))
        return Selection(index=list(criteria).index(prediction.answers["next"].choice), input_tokens=prediction.usage.input_tokens, model_calls=int(not hit), cache_hits=int(hit), state_tokens_dropped=prediction.usage.state_tokens_dropped, packed_tokens_dropped=dropped, head_tokens=len(head), inference_seconds=elapsed)


def main(graph: Path = typer.Option(...), cases: Path = typer.Option(...), output: Path = typer.Option(...), device: Literal["cpu", "mps"] = "cpu", max_reads: int = 8, max_options: int = 5) -> None:
    """Compare FIFO, BM25, frontier Laya and strict greedy Laya using cached document reads."""
    started = time.perf_counter()
    try:
        data, queries = inputs(graph, cases)
        if not 1 <= max_reads <= 8 or not 1 <= max_options <= 5:
            raise BenchmarkError("Bounds must be 1..8 unique reads and 1..5 options")
    except (BenchmarkError, ValidationError, OSError) as error:
        raise typer.BadParameter(str(error)) from error
    setup = time.perf_counter()
    selector = LayaSelector(output, device)
    setup_seconds = time.perf_counter() - setup
    navigation = Navigation(data, selector, max_reads, max_options)
    rows = [navigation.run(q, policy) for q in queries for policy in POLICIES]
    repeat_started = time.perf_counter()
    repeated = [navigation.run(q, policy) for q in queries for policy in POLICIES]
    repeat_calls = sum(r.model_calls for r in repeated)
    same = all(a.visited_ids == b.visited_ids for a, b in zip(rows, repeated, strict=True))
    if not same or repeat_calls:
        raise BenchmarkError("Exact-repeat cache validation failed")
    cohorts = []
    for policy in POLICIES:
        for split in sorted({q.split for q in queries}):
            for cohort in ("all", "start_is_target", "nontrivial", "reachable_nontrivial", "unanswerable", "unreachable"):
                group = [r for r in rows if r.policy == policy and r.split == split and (cohort == "all" or cohort == "start_is_target" and r.start_is_target or cohort == "nontrivial" and not r.start_is_target or cohort == "reachable_nontrivial" and r.reachable and not r.start_is_target and r.kind not in ("unreachable", "unanswerable") or cohort == r.kind)]
                cohorts.append({"policy": policy, "split": split, "cohort": cohort, "successes": sum(r.success for r in group), "denominator": len(group), "reads": sum(r.read_count for r in group), "hops": sum(r.hops for r in group), "mean_reads": sum(r.read_count for r in group)/len(group) if group else None})
    result = {"graph": {"schema": data.schema_version, "source_mode": data.source_mode, "nodes": len(data.nodes), "edges": sum(len(n.links) for n in data.nodes), "sha256": digest(graph.read_text()), "cases_sha256": digest(cases.read_text())}, "model": MODEL, "revision": REVISION, "device": device, "sdk_version": selector.sdk, "max_len": 1024, "head_max_len": 255, "max_reads": max_reads, "max_options": max_options, "stopping": "Oracle source-ID stopping after a read; not autonomous answer sufficiency. Controls never succeed.", "read_semantics": "Logical document reads from frozen cached snapshots; zero HTTP reads inside harness.", "policies": "FIFO, BM25 and Laya preserve all unchosen frontier edges; strictLaya only sees current-node outgoing edges.", "rows": [r.model_dump() for r in rows], "cohorts": cohorts, "uncached_states": sum(r.model_calls for r in rows), "input_tokens": sum(r.input_tokens for r in rows), "uncached_input_tokens": sum(d.input_tokens for r in rows for d in r.decisions if d.model_calls), "cache_validation": {"same_paths": same, "new_inference": repeat_calls, "cases": len(queries), "seconds": time.perf_counter()-repeat_started, "meaning": "Exact-state warm lookup, not unseen-query latency"}, "latency_seconds": {"setup": setup_seconds, "index": sum(r.index_seconds for r in rows), "inference": sum(r.inference_seconds for r in rows), "total": time.perf_counter()-started}, "peak_rss_bytes": resource.getrusage(resource.RUSAGE_SELF).ru_maxrss*(1 if sys.platform == "darwin" else 1024), "paid_cloud_llm_api_calls": 0}
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(result, ensure_ascii=False, indent=2, allow_nan=False) + "\n")


if __name__ == "__main__":
    typer.run(main)
