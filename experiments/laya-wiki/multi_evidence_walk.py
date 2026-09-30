#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.12"
# dependencies = ["pydantic==2.13.5", "typer==0.27.2", "laya==0.3.22"]
# ///
# How to run: artifacts/laya-wiki/venv/bin/python experiments/laya-wiki/multi_evidence_walk.py --help
"""Bounded evidence gathering and persistent document-reader commands; no rubric inputs."""
from __future__ import annotations

import json
from pathlib import Path
from typing import Literal, assert_never

import typer
from pydantic import ConfigDict, Field

from destination_walk import Boundary, Graph, Limits, Selection
from models import BM25, BenchmarkError, digest
from multi_evidence_model import First, LayaSelector, Observation, PACK, ReadDocument, Selector

app = typer.Typer()


class Case(Boundary):
    model_config = ConfigDict(frozen=True, strict=True, extra="forbid")
    id: str = Field(min_length=1)
    query: str = Field(min_length=1)
    start_id: str


class Step(Boundary):
    action: Literal["LINK", "BACK"]
    source_id: str
    target_id: str
    choice: str
    offered_target_ids: list[str]
    offered_labels: list[str]
    unique_reads: int


class Session(Boundary):
    schema_version: Literal[1] = 1
    graph_path: str
    graph_sha256: str
    case: Case
    limits: Limits = Limits()
    history: list[str]
    read_ids: list[str]
    trace: list[Step] = []
    decisions: list[Selection] = []
    finished: bool = False
    reason: str = "running"
    policy: Literal["reader", "laya", "bm25"] = "reader"
    pack_version: str = PACK


class Choice(Boundary):
    target_id: str
    label: str


class View(Boundary):
    query: str
    current_id: str
    current_title: str
    current_body: str
    choices: dict[str, Choice]
    read_count: int
    action_count: int
    limits: Limits
    reason: Literal["running", "finished", "read_budget", "action_budget", "exhausted"]


def initialize(graph_path: Path, case: Case) -> Session:
    raw = graph_path.read_text()
    graph = Graph.model_validate_json(raw)
    if case.start_id not in {n.id for n in graph.nodes}:
        raise BenchmarkError("Unknown start document")
    value = Session(graph_path=str(graph_path.resolve()), graph_sha256=digest(raw), case=case, history=[case.start_id], read_ids=[case.start_id])
    return value.model_copy(update={"reason": reader_state(value, graph).reason})


def reader_state(session: Session, graph: Graph) -> View:
    nodes = {n.id: n for n in graph.nodes}
    if not session.history or not session.read_ids or any(i not in nodes for i in session.history+session.read_ids):
        raise BenchmarkError("Invalid reader history or document ID")
    if len(set(session.read_ids)) != len(session.read_ids) or set(session.history)-set(session.read_ids):
        raise BenchmarkError("Reader history must refer to uniquely read documents")
    current = nodes[session.history[-1]]
    destinations = {}
    for edge in current.links:
        if edge.target_id not in session.read_ids:
            destinations.setdefault(edge.target_id, Choice(target_id=edge.target_id, label=f"{edge.label} | {nodes[edge.target_id].name}"))
    choices = {chr(65+i): option for i, option in enumerate(list(destinations.values())[:session.limits.options])}
    reason = "running"
    if session.finished:
        reason = "finished"
    elif len(session.trace) >= session.limits.actions:
        reason = "action_budget"
    elif choices and len(session.read_ids) >= session.limits.reads:
        reason = "read_budget"
    elif not choices:
        if len(session.history) > 1:
            choices = {"BACK": Choice(target_id=session.history[-2], label=nodes[session.history[-2]].name)}
        else:
            reason = "exhausted"
    return View(query=session.case.query, current_id=current.id, current_title=current.name, current_body=current.text, choices=choices if reason == "running" else {}, read_count=len(session.read_ids), action_count=len(session.trace), limits=session.limits, reason=reason)


def reader_act(session: Session, graph: Graph, choice: str) -> Session:
    view = reader_state(session, graph)
    if choice not in view.choices:
        raise BenchmarkError(f"Choice is not currently offered: {choice}; reader status: {view.reason}")
    option = view.choices[choice]
    history = session.history[:-1] if choice == "BACK" else session.history+[option.target_id]
    reads = session.read_ids if choice == "BACK" else session.read_ids+[option.target_id]
    step = Step(action="BACK" if choice == "BACK" else "LINK", source_id=view.current_id, target_id=option.target_id, choice=choice, offered_target_ids=[v.target_id for v in view.choices.values()], offered_labels=[v.label for v in view.choices.values()], unique_reads=len(reads))
    advanced = session.model_copy(update={"history": history, "read_ids": reads, "trace": session.trace+[step]})
    return advanced.model_copy(update={"reason": reader_state(advanced, graph).reason})


def gather(session: Session, graph: Graph, selector: Selector, policy: Literal["laya", "bm25"]) -> Session:
    active = session
    nodes = {n.id: n for n in graph.nodes}
    while (view := reader_state(active, graph)).reason == "running":
        if "BACK" in view.choices:
            active = reader_act(active, graph, "BACK")
            continue
        options = {key: choice.label for key, choice in view.choices.items()}
        match policy:
            case "bm25":
                selection = Selection(index=BM25(list(options.values())).rank(active.case.query)[0])
            case "laya":
                observation = Observation(query=active.case.query, current_title=view.current_title, documents=[ReadDocument(title=nodes[i].name, body=nodes[i].text) for i in active.read_ids], options=options)
                selection = selector.choose(observation) if len(options) > 1 else Selection(index=0)
            case unknown:
                assert_never(unknown)
        if not 0 <= selection.index < len(options):
            raise BenchmarkError("Selected index is outside current outgoing menu")
        advanced = reader_act(active, graph, list(options)[selection.index])
        active = advanced.model_copy(update={"decisions": active.decisions+[selection]})
    return active.model_copy(update={"reason": reader_state(active, graph).reason, "policy": policy})


def load_session(path: Path) -> tuple[Session, Graph]:
    session = Session.model_validate_json(path.read_bytes())
    raw = Path(session.graph_path).read_text()
    if digest(raw) != session.graph_sha256:
        raise BenchmarkError("Reader graph changed since initialization")
    graph = Graph.model_validate_json(raw)
    replay = session.model_copy(update={"history": [session.case.start_id], "read_ids": [session.case.start_id], "trace": [], "finished": False})
    for step in session.trace:
        replay = reader_act(replay, graph, step.choice)
        if replay.trace[-1] != step:
            raise BenchmarkError("Reader trace does not match actual offered actions")
    if replay.read_ids != session.read_ids or replay.history != session.history:
        raise BenchmarkError("Reader history does not match action trace")
    return session, graph


def save_session(path: Path, session: Session) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(".tmp")
    temporary.write_text(session.model_dump_json(indent=2)+"\n")
    temporary.replace(path)


@app.command("init-reader")
def init_reader(graph: Path = typer.Option(...), case_file: Path = typer.Option(...), session: Path = typer.Option(...)) -> None:
    if session.exists():
        raise BenchmarkError("Reader session already exists")
    value = initialize(graph, Case.model_validate_json(case_file.read_bytes()))
    save_session(session, value)
    typer.echo(reader_state(value, Graph.model_validate_json(graph.read_bytes())).model_dump_json())


@app.command("reader-state")
def show_reader(session: Path = typer.Option(...)) -> None:
    value, graph = load_session(session)
    typer.echo(reader_state(value, graph).model_dump_json())


@app.command("reader-act")
def act_reader(session: Path = typer.Option(...), choice: str = typer.Option(...)) -> None:
    value, graph = load_session(session)
    advanced = reader_act(value, graph, choice)
    save_session(session, advanced)
    typer.echo(reader_state(advanced, graph).model_dump_json())


@app.command("reader-finish")
def finish_reader(session: Path = typer.Option(...)) -> None:
    value, graph = load_session(session)
    finished = value.model_copy(update={"finished": True, "reason": "finished"})
    save_session(session, finished)
    typer.echo(reader_state(finished, graph).model_dump_json())


@app.command("gather")
def gather_command(graph: Path = typer.Option(...), case_file: Path = typer.Option(...), output: Path = typer.Option(...), policy: Literal["laya", "bm25"] = "laya", device: Literal["mps", "cpu"] = "mps", fake_selector: bool = False) -> None:
    value = initialize(graph, Case.model_validate_json(case_file.read_bytes()))
    data = Graph.model_validate_json(graph.read_bytes())
    selector = First() if fake_selector or policy == "bm25" else LayaSelector(output, device)
    result = gather(value, data, selector, policy)
    save_session(output, result)
    typer.echo(json.dumps({"reason": reader_state(result, data).reason, "read_count": len(result.read_ids), "actions": len(result.trace), "pack": PACK, "policy": policy, "output": str(output)}))


if __name__ == "__main__":
    app()
