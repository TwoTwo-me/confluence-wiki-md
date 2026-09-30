#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.12"
# dependencies = ["laya==0.3.22", "pydantic==2.13.5", "typer==0.27.2"]
# ///
# How to run: artifacts/laya-wiki/venv/bin/python experiments/laya-wiki/destination_walk.py --help
# noqa: SIZE_OK -- Assignment confines the standalone protocol, adapter and CLI to this file.
"""Connected document walks. Labels are evaluated only after navigation terminates."""
from __future__ import annotations

import json
import os
import re
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Final, Literal, Protocol, assert_never

import typer
from pydantic import Field, TypeAdapter, ValidationError, model_validator

from graph_benchmark import Boundary, Link, MODEL, REVISION, Prediction, Selection
from models import BM25, BenchmarkError, Tokenizer, digest, normalize_text

Policy = Literal["fifo", "bm25", "laya", "laya-greedy"]
PACK: Final = "destination-v1-current-paragraphs-700-head255"


class Node(Boundary):
    id: str
    title: str
    display_name: str = ""
    text: str
    links: list[Link]

    @property
    def name(self) -> str:
        return self.display_name or self.title


class Graph(Boundary):
    nodes: list[Node] = Field(min_length=1)

    @model_validator(mode="after")
    def check(self) -> Graph:
        ids = {n.id for n in self.nodes}
        if len(ids) != len(self.nodes) or any(e.target_id not in ids for n in self.nodes for e in n.links):
            raise BenchmarkError("Duplicate node or unknown link target")
        return self


class Case(Boundary):
    id: str
    kind: Literal["named-goal", "question"]
    query: str = Field(min_length=1)
    start_id: str
    goal_name: str = ""


class Label(Boundary):
    target_ids: list[str] = []
    required_evidence: list[str] = []


class Limits(Boundary):
    reads: int = Field(default=12, ge=1, le=12)
    actions: int = Field(default=24, ge=1, le=24)
    options: int = Field(default=4, ge=1, le=4)


class Observation(Boundary):
    query: str
    current_title: str
    current_body: str
    visited_titles: list[str]
    options: dict[str, str]
    purpose: Literal["stop", "next"]


class Selector(Protocol):
    def choose(self, observation: Observation) -> Selection: ...


class First:
    def choose(self, observation: Observation) -> Selection:
        return Selection(index=list(observation.options).index("CONTINUE") if observation.purpose == "stop" else 0)


class Result(Boundary):
    reason: str
    stopped: bool
    final_id: str
    read_ids: list[str]
    trace: list[dict[str, str | int | list[str]]]
    decisions: list[Selection]


@dataclass(frozen=True, slots=True)
class Walker:
    graph: Graph
    selector: Selector
    limits: Limits = Limits()

    def run(self, case: Case, policy: Policy) -> Result:
        nodes = {n.id: n for n in self.graph.nodes}
        if case.start_id not in nodes:
            raise BenchmarkError("Unknown start node")
        if case.kind == "named-goal" and (not case.goal_name.strip() or sum(n.name == case.goal_name or n.title == case.goal_name for n in nodes.values()) > 1):
            raise BenchmarkError("Named goal must be nonblank and unambiguous; use a unique display_name")
        history, reads, trace, decisions = [case.start_id], [case.start_id], [], []
        remaining = {case.start_id: list(nodes[case.start_id].links)}
        reason, stopped = "exhausted", False
        while True:
            current = nodes[history[-1]]
            state = dict(query=case.goal_name if case.kind == "named-goal" else case.query, current_title=current.name, current_body=current.text, visited_titles=[nodes[i].name for i in reads])
            if case.kind == "named-goal" and case.goal_name in (current.name, current.title):
                reason, stopped = "visible_name_match", True
                break
            if case.kind == "question":
                observation = Observation(**state, purpose="stop", options={"ARRIVED": "Current document contains the information needed to answer the question", "CONTINUE": "Continue looking for the answer"})
                stop = self.selector.choose(observation)
                if stop.index not in (0, 1):
                    raise BenchmarkError("Invalid stop choice")
                decisions.append(stop)
                if stop.index == 0:
                    reason, stopped = "arrived_decision", True
                    break
            if len(trace) >= self.limits.actions:
                reason = "action_budget"
                break
            destinations: dict[str, Link] = {}
            for edge in remaining[current.id]:
                if edge.target_id not in reads:
                    destinations.setdefault(edge.target_id, edge)
            available = list(destinations.values())
            menu = available[:self.limits.options]
            if menu and len(reads) >= self.limits.reads:
                reason = "read_budget"
                break
            if not menu:
                if len(history) == 1 or policy == "laya-greedy":
                    reason = "exhausted" if len(history) == 1 else "greedy_dead_end"
                    break
                history.pop()
                trace.append({"action": "BACK", "source_id": current.id, "target_id": history[-1], "unique_reads": len(reads)})
                continue
            options = {chr(65+i): f"{e.label} | {nodes[e.target_id].name}" for i, e in enumerate(menu)}
            match policy:
                case "fifo":
                    choice = Selection(index=0)
                case "bm25":
                    choice = Selection(index=BM25(list(options.values())).rank(state["query"])[0])
                case "laya" | "laya-greedy":
                    choice = self.selector.choose(Observation(**state, purpose="next", options=options)) if len(menu) > 1 else Selection(index=0)
                case unknown:
                    assert_never(unknown)
            if not 0 <= choice.index < len(menu):
                raise BenchmarkError("Selected action outside offered links")
            edge = menu[choice.index]
            remaining[current.id].remove(edge)
            history.append(edge.target_id)
            reads.append(edge.target_id)
            remaining[edge.target_id] = list(nodes[edge.target_id].links)
            decisions.append(choice)
            trace.append({"action": "LINK", "source_id": current.id, "target_id": edge.target_id, "label": edge.label, "offered_labels": list(options.values()), "offered_target_ids": [e.target_id for e in menu], "remaining_local_links": len(available)-1, "unique_reads": len(reads)})
        return Result(reason=reason, stopped=stopped, final_id=history[-1], read_ids=reads, trace=trace, decisions=decisions)


def evaluate(result: Result, graph: Graph, label: Label) -> dict[str, bool]:  # noqa: DICT_OK -- JSON metric flags
    text = next(n.text for n in graph.nodes if n.id == result.final_id)
    evidence = bool(label.required_evidence) and all(s in text for s in label.required_evidence)
    known = result.final_id in label.target_ids
    return {"known_target_arrival": known, "required_evidence_present": evidence, "stopped_outside_known_with_evidence": result.stopped and not known and evidence, "stop_without_label_support": result.stopped and not known and not evidence}


def pack(observation: Observation, tok: Tokenizer) -> tuple[str, dict[str, str], int]:  # noqa: DICT_OK -- SDK criteria
    def clip(text: str, count: int) -> str:
        return tok.decode(tok.encode(text, add_special_tokens=False)[:count], skip_special_tokens=True)
    options = {key: clip(value, 36) for key, value in observation.options.items()}
    prefix = json.dumps({"query": observation.query, "current": observation.current_title, "visited": [clip(t, 16) for t in observation.visited_titles]}, ensure_ascii=False)
    paragraphs = [p for p in re.split(r"\n\s*\n", normalize_text(observation.current_body)) if p.strip()]
    excerpt = "\n".join(paragraphs[i] for i in BM25(paragraphs).rank(observation.query)[:3])
    room = 700-len(tok.encode(prefix, add_special_tokens=False))
    if room < 32:
        raise BenchmarkError("Visible goal/history exceeds state allowance")
    state = prefix + "\n" + clip(excerpt, min(room-1, 280))
    while len(tok.encode(state, add_special_tokens=False)) > 700:
        room -= 8
        state = prefix + "\n" + clip(excerpt, min(room-1, 280))
    return state, options, max(0, len(tok.encode(prefix+"\n"+excerpt, add_special_tokens=False))-len(tok.encode(state, add_special_tokens=False)))


class LayaSelector:
    """One resident model with an exact serialized-state cache."""
    def __init__(self, output: Path, device: str) -> None:
        os.environ["HF_HUB_OFFLINE"], os.environ["USE_TF"] = "1", "0"
        import laya
        import torch
        if laya.__version__ != "0.3.22":
            raise BenchmarkError("Laya SDK must be 0.3.22")
        torch.manual_seed(0)
        torch.set_num_threads(4)
        self.sdk = laya.__version__
        self.path = output.with_suffix(".cache.json")
        self.cache = TypeAdapter(dict[str, Prediction]).validate_json(self.path.read_bytes()) if self.path.exists() else {}
        self.agent = laya.load(MODEL, revision=REVISION, device=device)
        self.namespace = json.dumps([MODEL, REVISION, self.sdk, device, PACK, 1024, 255, 1])

    def choose(self, observation: Observation) -> Selection:
        from laya.common import build_sequence
        state, criteria, dropped = pack(observation, self.agent.tok)
        instruction = "Decide whether this current document answers the question." if observation.purpose == "stop" else "Select the current document link most likely to lead toward the destination or answer."
        question = {"type": "choice", "instructions": instruction, "criteria": criteria}
        internal = {"t": "choice", "ins": instruction, "crit": criteria}
        head, markers, stats = build_sequence(self.agent.tok, "", internal, max_len=1024, head_max_len=255, return_stats=True)
        if len(head) > 255 or len(markers) != len(criteria) or stats["options_distinct"] != len(criteria):
            raise BenchmarkError("Question head loses offered options")
        key = digest(self.namespace + state + json.dumps(question, ensure_ascii=False))
        hit, elapsed = key in self.cache, 0.0
        if not hit:
            started = time.perf_counter()
            raw = self.agent.predict_batch([state], {"next": question}, batch_size=1, max_len=1024, head_max_len=255)
            predictions = TypeAdapter(list[Prediction]).validate_python(raw)
            if len(predictions) != 1:
                raise BenchmarkError("SDK output count differs from one state")
            prediction = predictions[0].checked(list(criteria))
            if prediction.usage.truncated_questions or prediction.usage.state_tokens_dropped or prediction.usage.input_tokens > 1024:
                raise BenchmarkError("SDK truncated state/question or exceeded token limit")
            self.cache[key] = prediction
            elapsed = time.perf_counter()-started
            self.path.parent.mkdir(parents=True, exist_ok=True)
            temporary = self.path.with_suffix(".tmp")
            temporary.write_bytes(TypeAdapter(dict[str, Prediction]).dump_json(self.cache))
            temporary.replace(self.path)
        prediction = self.cache[key].checked(list(criteria))
        if prediction.usage.truncated_questions or prediction.usage.state_tokens_dropped or prediction.usage.input_tokens > 1024:
            raise BenchmarkError("Cached SDK response exceeds token contract")
        return Selection(index=list(criteria).index(prediction.answers["next"].choice), input_tokens=prediction.usage.input_tokens, model_calls=int(not hit), cache_hits=int(hit), state_tokens_dropped=prediction.usage.state_tokens_dropped, packed_tokens_dropped=dropped, head_tokens=len(head), inference_seconds=elapsed)


def main(graph: Path = typer.Option(...), cases: Path = typer.Option(...), labels: Path = typer.Option(...), output: Path = typer.Option(...), policies: str = "fifo,bm25,laya,laya-greedy", device: Literal["cpu", "mps"] = "cpu", fake_selector: Literal["first"] | None = None, max_reads: int = 12, max_actions: int = 24, max_options: int = 4) -> None:
    """Compare connected walkers; question stopping uses the same selector for every policy."""
    try:
        data = Graph.model_validate_json(graph.read_bytes())
        queries = TypeAdapter(list[Case]).validate_json(cases.read_bytes())
        gold = TypeAdapter(dict[str, Label]).validate_json(labels.read_bytes())
        selected = TypeAdapter(list[Policy]).validate_python(policies.split(","))
        limits = Limits(reads=max_reads, actions=max_actions, options=max_options)
        ids = {n.id for n in data.nodes}
        if not queries or len({q.id for q in queries}) != len(queries) or set(gold) != {q.id for q in queries} or any(set(g.target_ids)-ids for g in gold.values()):
            raise BenchmarkError("Invalid case/label identity")
        for case in queries:
            if case.start_id not in ids or (case.kind == "named-goal" and (not case.goal_name.strip() or sum(n.name == case.goal_name or n.title == case.goal_name for n in data.nodes) > 1)):
                raise BenchmarkError("Invalid start or ambiguous/blank visible goal")
    except (BenchmarkError, ValidationError, OSError) as error:
        raise typer.BadParameter(str(error)) from error
    selector = First() if fake_selector or (all(p in ("fifo", "bm25") for p in selected) and all(q.kind == "named-goal" for q in queries)) else LayaSelector(output, device)
    walker = Walker(data, selector, limits)
    rows = []
    for case in queries:
        for policy in selected:
            result = walker.run(case, policy)
            rows.append({"case_id": case.id, "policy": policy, **result.model_dump(), **evaluate(result, data, gold[case.id])})
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps({"schema": 1, "model": MODEL, "revision": REVISION, "device": device, "fake_selector": fake_selector, "pack": PACK, "limits": limits.model_dump(), "graph_sha256": digest(graph.read_text()), "cases_sha256": digest(cases.read_text()), "labels_sha256": digest(labels.read_text()), "window": "First four remaining unvisited outgoing links in recorded order; later local links retained until Back. No global index.", "read_semantics": "Logical unique body access in frozen graph; Back uses cached body. No HTTP reads.", "rows": rows}, ensure_ascii=False, indent=2, allow_nan=False)+"\n")
    typer.echo(json.dumps({"rows": len(rows), "output": str(output), "fake_selector": fake_selector}))


if __name__ == "__main__":
    typer.run(main)
