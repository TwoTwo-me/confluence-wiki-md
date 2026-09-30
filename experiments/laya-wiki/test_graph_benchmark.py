"""Graph policy regressions without model weights or network access."""
from pathlib import Path

import pytest
from pydantic import ValidationError
from typer.testing import CliRunner
import typer

from graph_benchmark import BenchmarkError, Case, Graph, Navigation, Observation, Prediction, Selection, main, pack
from test_benchmark import CharacterTokenizer


class First:
    def choose(self, observation: Observation) -> Selection:
        return Selection(index=0)


def graph() -> Graph:
    links = {"a": ["b", "c", "d", "e", "f", "g"], "b": ["a", "c"], "c": ["h"], "d": [], "e": [], "f": [], "g": [], "h": [], "secret": []}
    return Graph.model_validate({"schema": 1, "source_mode": "local", "summary": {}, "nodes": [{"id": key, "title": key, "text": key, "source_path": key + ".md", "source_url": "https://example.test/" + key, "private": False, "links": [{"target_id": target, "label": target, "source_url": "https://example.test/" + target} for target in targets]} for key, targets in links.items()]})


def case(**changes: str | list[str]) -> Case:
    return Case.model_validate({"id": "test", "kind": "question", "query": "g", "start_id": "a", "target_ids": ["h"], "split": "test"} | changes)


def test_frontier_when_cycle_and_duplicate_parent() -> None:
    # Given / When
    row = Navigation(graph(), First()).run(case(), "fifo")
    # Then: c retains a's first edge; reads are unique and every edge has a visited parent.
    assert row.success and row.shortest_path == 2 and row.read_count == 8
    assert row.visited_ids == ["a", "b", "c", "d", "e", "f", "g", "h"]
    assert row.trace[1]["source_id"] == "a"
    for offset, edge in enumerate(row.trace, start=1):
        assert edge["source_id"] in row.visited_ids[:offset]
        assert edge["target_id"] in [link.target_id for node in graph().nodes if node.id == edge["source_id"] for link in node.links]


@pytest.mark.parametrize("policy, expected", [("fifo", ["a", "b", "c"]), ("bm25", ["a", "b", "g"])])
def test_window_when_best_target_initially_sixth(policy: str, expected: list[str]) -> None:
    # Given / When
    row = Navigation(graph(), First(), max_reads=3).run(case(target_ids=["secret"]), policy)
    # Then: g cannot be read from the first five; BM25 sees it after the first read.
    assert row.visited_ids == expected and row.reason == "read_budget"
    assert row.model_calls == 0 and row.input_tokens == 0


@pytest.mark.parametrize("policy, success, reason", [("laya", True, "goal_reached"), ("strictLaya", False, "greedy_stalled")])
def test_recovery_when_greedy_reaches_dead_end(policy: str, success: bool, reason: str) -> None:
    # Given / When
    row = Navigation(graph(), First()).run(case(target_ids=["d"]), policy)
    # Then
    assert row.success is success and row.reason == reason


@pytest.mark.parametrize("kind, targets, reachable", [("unanswerable", [], False), ("unreachable", ["secret"], False), ("unreachable", ["a"], True)])
def test_controls_when_oracle_would_match(kind: str, targets: list[str], reachable: bool) -> None:
    # Given / When
    row = Navigation(graph(), First()).run(case(kind=kind, target_ids=targets), "fifo")
    # Then
    assert not row.success and row.reachable is reachable


def test_start_target_when_one_read_budget() -> None:
    # Given / When
    row = Navigation(graph(), First(), max_reads=1).run(case(target_ids=["a"]), "laya")
    # Then
    assert row.start_is_target and row.success and row.read_count == 1 and row.trace == []


@pytest.mark.parametrize("policy", ["laya", "strictLaya"])
def test_navigation_when_only_one_link_skips_model(policy: str) -> None:
    # Given: c has exactly one outgoing link, to h.
    class Counting:
        def choose(self, observation: Observation) -> Selection:
            return Selection(index=0, model_calls=1)
    # When
    row = Navigation(graph(), Counting()).run(case(start_id="c", target_ids=["h"]), policy)
    # Then: a real link is traversed without a model call.
    assert row.success and row.visited_ids == ["c", "h"] and row.model_calls == 0


@pytest.mark.parametrize("choice, probabilities", [("Z", {"A": 1.0}), ("A", {"A": float("nan")}), ("A", {"A": float("inf")}), ("A", {"A": 1.2}), ("A", {"B": 1.0})])
def test_dynamic_output_when_invalid(choice: str, probabilities: dict[str, float]) -> None:
    # Given
    raw = {"answers": {"next": {"choice": choice, "probabilities": probabilities}}, "usage": {"input_tokens": 20, "state_tokens": 10, "state_tokens_dropped": 0, "truncated": False, "truncated_questions": []}}
    # When / Then
    with pytest.raises((BenchmarkError, ValidationError)):
        Prediction.model_validate(raw).checked(["A"])


def test_model_state_when_evaluation_target_changes() -> None:
    # Given: capture real navigation observations; evaluation target is an isolated node.
    observations: list[Observation] = []
    class Capture:
        def choose(self, observation: Observation) -> Selection:
            observations.append(observation)
            return Selection(index=0)
    # When
    Navigation(graph(), Capture(), max_reads=2).run(case(target_ids=["secret"]), "laya")
    Navigation(graph(), Capture(), max_reads=2).run(case(target_ids=["h"]), "laya")
    state, criteria, dropped = pack(observations[0], CharacterTokenizer())
    # Then: machine input excludes the hidden evaluation ID/path and remains bounded.
    assert pack(observations[0], CharacterTokenizer()) == pack(observations[1], CharacterTokenizer())
    assert "secret" not in state + str(criteria)
    assert len(state) <= 700 and dropped >= 0 and len(criteria) == 5


def test_cli_when_invalid_inputs_before_model_load(tmp_path: Path) -> None:
    # Given
    source, cases = tmp_path / "graph.json", tmp_path / "cases.json"
    source.write_text(graph().model_dump_json(by_alias=True))
    cases.write_text("[]")
    app = typer.Typer()
    app.command()(main)
    # When
    result = CliRunner().invoke(app, ["--graph", str(source), "--cases", str(cases), "--output", str(tmp_path / "result.json")])
    # Then
    assert result.exit_code == 2 and "empty cases" in result.output
    assert not (tmp_path / "result.json").exists()


def test_exhaustion_when_start_has_no_links() -> None:
    # Given / When
    row = Navigation(graph(), First()).run(case(start_id="secret"), "fifo")
    # Then
    assert row.reason == "frontier_exhausted" and row.read_count == 1 and not row.success


def test_prediction_when_question_dropped() -> None:
    # Given
    raw = {"answers": {}, "usage": {"input_tokens": 0, "state_tokens": 0, "state_tokens_dropped": 0, "truncated": False, "truncated_questions": []}}
    # When / Then
    with pytest.raises(BenchmarkError):
        Prediction.model_validate(raw).checked(["A"])
