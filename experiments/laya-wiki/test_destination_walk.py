from pathlib import Path
import json

import pytest
import typer
from typer.testing import CliRunner
from pydantic import ValidationError

from destination_walk import Case, First, Graph, Label, Limits, Observation, Selection, Walker, evaluate, main, pack
from graph_benchmark import BenchmarkError, Navigation
from test_graph_benchmark import First as BaselineFirst, graph as baseline_graph, case as baseline_case
from test_benchmark import CharacterTokenizer


def graph() -> Graph:
    return Graph.model_validate({"nodes": [{"id": key, "title": key.upper(), "text": "answer token" if key == "g" else key, "links": [{"target_id": target, "label": target.upper(), "source_url": "https://example.test/"+target} for target in targets]} for key, targets in {"a": ["b", "c", "d", "e", "f", "g"], "b": ["a"], "c": [], "d": [], "e": [], "f": [], "g": [], "isolated": []}.items()]})


def case() -> Case:
    return Case(id="evaluation-only", kind="named-goal", query="Find G", goal_name="G", start_id="a")


def test_baseline_when_old_frontier_teleports() -> None:
    row = Navigation(baseline_graph(), BaselineFirst()).run(baseline_case(), "fifo")
    assert row.visited_ids[1] == "b" and row.trace[1]["source_id"] == "a"


@pytest.mark.parametrize("policy", ["fifo", "bm25", "laya"])
def test_connected_when_dead_end_requires_back(policy) -> None:
    row = Walker(graph(), First()).run(case(), policy)
    current, history = "a", ["a"]
    for step in row.trace:
        assert step["source_id"] == current
        if step["action"] == "LINK":
            assert step["target_id"] in [e.target_id for n in graph().nodes if n.id == current for e in n.links]
            history.append(step["target_id"])
        else:
            history.pop()
            assert step["target_id"] == history[-1]
        current = step["target_id"]
    assert row.stopped and row.final_id == "g"
    assert any(step["action"] == "BACK" for step in row.trace)


def test_window_when_sixth_local_link_is_retained() -> None:
    row = Walker(graph(), First()).run(case(), "fifo")
    assert row.read_ids == ["a", "b", "c", "d", "e", "f", "g"]
    assert row.trace[0]["offered_target_ids"] == ["b", "c", "d", "e"]
    assert all(len(s["offered_target_ids"]) <= 4 for s in row.trace if s["action"] == "LINK")


@pytest.mark.parametrize("limits, reason, count", [(Limits(reads=2), "read_budget", 2), (Limits(actions=1), "action_budget", 2)])
def test_budget_when_boundary_reached(limits, reason, count) -> None:
    row = Walker(graph(), First(), limits).run(case(), "fifo")
    assert row.reason == reason and len(row.read_ids) == count and not row.stopped


def test_cycle_when_goal_absent() -> None:
    row = Walker(graph(), First()).run(case().model_copy(update={"goal_name": "ABSENT"}), "fifo")
    assert row.reason == "exhausted" and len(row.read_ids) == 7 and len(row.trace) == 12


def test_greedy_when_dead_end() -> None:
    row = Walker(graph(), First()).run(case(), "laya-greedy")
    assert row.reason == "greedy_dead_end" and row.read_ids == ["a", "b"]


def test_selector_when_invalid_action() -> None:
    class Invalid:
        def choose(self, observation):
            return Selection(index=20)
    with pytest.raises(BenchmarkError):
        Walker(graph(), Invalid()).run(case(), "laya")


def test_inputs_when_unknown_link() -> None:
    data = graph().model_dump()
    data["nodes"][0]["links"][0]["target_id"] = "missing"
    with pytest.raises(BenchmarkError):
        Graph.model_validate(data)


def test_named_when_collision_requires_display_path() -> None:
    data = graph().model_dump()
    data["nodes"][1]["title"] = "G"
    with pytest.raises(BenchmarkError):
        Walker(Graph.model_validate(data), First()).run(case(), "fifo")


def test_state_when_hidden_labels_and_unseen_body() -> None:
    observed = []
    class Capture:
        def choose(self, observation):
            observed.append(observation)
            return Selection(index=0)
    Walker(graph(), Capture(), Limits(reads=2)).run(case(), "laya")
    serialized = json.dumps([o.model_dump() for o in observed])
    assert "evaluation-only" not in serialized and "answer token" not in serialized and "isolated" not in serialized
    assert observed[0].current_body == "a"
    state, choices, _ = pack(observed[0], CharacterTokenizer())
    assert len(state) <= 700 and len(choices) == 4


def test_false_arrived_when_question_has_no_evidence() -> None:
    class Arrive:
        def choose(self, observation):
            return Selection(index=0)
    question = case().model_copy(update={"kind": "question", "goal_name": ""})
    row = Walker(graph(), Arrive()).run(question, "fifo")
    flags = evaluate(row, graph(), Label(target_ids=["g"], required_evidence=["answer token"]))
    assert row.final_id == "a" and row.stopped and flags["stop_without_label_support"]


def test_evidence_when_stop_outside_known_targets() -> None:
    row = Walker(graph(), First()).run(case(), "fifo")
    flags = evaluate(row, graph(), Label(target_ids=["isolated"], required_evidence=["answer token"]))
    assert flags["stopped_outside_known_with_evidence"] and not flags["known_target_arrival"]


def test_labels_when_changed_after_identical_walk() -> None:
    row = Walker(graph(), First()).run(case(), "laya")
    original = row.model_dump_json()
    assert evaluate(row, graph(), Label(target_ids=["g"]))["known_target_arrival"]
    assert not evaluate(row, graph(), Label(target_ids=["a"]))["known_target_arrival"]
    assert row.model_dump_json() == original


@pytest.mark.parametrize("choice, probabilities", [("Z", {"A": 1.0}), ("A", {"A": float("nan")}), ("A", {"A": float("inf")}), ("A", {"B": 1.0})])
def test_sdk_when_invalid_output(choice, probabilities) -> None:
    from destination_walk import Prediction
    raw = {"answers": {"next": {"choice": choice, "probabilities": probabilities}}, "usage": {"input_tokens": 20, "state_tokens": 10, "state_tokens_dropped": 0, "truncated": False, "truncated_questions": []}}
    with pytest.raises((BenchmarkError, ValidationError)):
        Prediction.model_validate(raw).checked(["A"])


def test_stop_when_invalid_action() -> None:
    class Invalid:
        def choose(self, observation):
            return Selection(index=-1)
    with pytest.raises(BenchmarkError):
        Walker(graph(), Invalid()).run(case().model_copy(update={"kind": "question"}), "fifo")


def test_bm25_when_only_current_link_metadata_indexed(monkeypatch) -> None:
    from models import BM25
    indexed = []
    class Inspect(BM25):
        def __init__(self, documents):
            indexed.append(documents)
            super().__init__(documents)
    monkeypatch.setattr("destination_walk.BM25", Inspect)
    Walker(graph(), First(), Limits(reads=2)).run(case(), "bm25")
    assert indexed == [["B | B", "C | C", "D | D", "E | E"]]


def test_cli_when_fake_selector_drives_real_surface(tmp_path: Path) -> None:
    paths = [tmp_path/name for name in ("graph.json", "cases.json", "labels.json", "output.json")]
    paths[0].write_text(graph().model_dump_json())
    paths[1].write_text(json.dumps([case().model_dump()]))
    paths[2].write_text(json.dumps({case().id: {"target_ids": ["g"], "required_evidence": []}}))
    app = typer.Typer()
    app.command()(main)
    run = CliRunner().invoke(app, ["--graph", str(paths[0]), "--cases", str(paths[1]), "--labels", str(paths[2]), "--output", str(paths[3]), "--fake-selector", "first"])
    assert run.exit_code == 0, run.output
    assert len(json.loads(paths[3].read_text())["rows"]) == 4


def test_cache_when_exact_state_repeats_without_model(monkeypatch, tmp_path: Path) -> None:
    import sys
    from types import ModuleType
    from destination_walk import LayaSelector
    calls = []
    class Agent:
        tok = CharacterTokenizer()
        def predict_batch(self, states, questions, **kwargs):
            calls.append(states)
            options = list(questions["next"]["criteria"])
            return [{"answers": {"next": {"choice": options[0], "probabilities": {key: 1/len(options) for key in options}}}, "usage": {"input_tokens": 30, "state_tokens": 20, "state_tokens_dropped": 0, "truncated": False, "truncated_questions": []}}]
    common = ModuleType("laya.common")
    common.build_sequence = lambda tok, state, question, **kwargs: ([1], list(question["crit"]), {"options_distinct": len(question["crit"])})
    monkeypatch.setitem(sys.modules, "laya.common", common)
    selector = LayaSelector.__new__(LayaSelector)
    selector.agent, selector.path, selector.cache, selector.namespace = Agent(), tmp_path/"cache.json", {}, "fixture"
    observation = Observation(query="destination", current_title="Start", current_body="body", visited_titles=["Start"], purpose="next", options={"A": "One", "B": "Two"})
    first, repeat = selector.choose(observation), selector.choose(observation)
    assert len(calls) == 1 and first.model_calls == 1 and repeat.cache_hits == 1
    assert selector.path.stat().st_size > 0
    selector.choose(observation.model_copy(update={"current_body": "different body"}))
    assert len(calls) == 2


def test_head_when_sdk_loses_options(monkeypatch, tmp_path: Path) -> None:
    import sys
    from types import ModuleType
    from destination_walk import LayaSelector
    class Agent:
        tok = CharacterTokenizer()
        def predict_batch(self, *args, **kwargs):
            pytest.fail("Inference must not run after invalid head")
    common = ModuleType("laya.common")
    common.build_sequence = lambda *args, **kwargs: ([1]*256, [], {"options_distinct": 0})
    monkeypatch.setitem(sys.modules, "laya.common", common)
    selector = LayaSelector.__new__(LayaSelector)
    selector.agent = Agent()
    observation = Observation(query="q", current_title="Start", current_body="body", visited_titles=[], purpose="next", options={"A": "One", "B": "Two"})
    with pytest.raises(BenchmarkError):
        selector.choose(observation)


def test_menu_when_provenance_duplicates_and_more_than_four_destinations() -> None:
    data = graph().model_dump()
    original = data["nodes"][0]["links"]
    data["nodes"][0]["links"] = [dict(link, provenance={"kind": kind}) for link in original for kind in ("containment", "collection-row")]
    source = Graph.model_validate(data)
    row = Walker(source, First()).run(case(), "laya")
    assert row.trace[0]["offered_target_ids"] == ["b", "c", "d", "e"]
    assert row.read_ids == ["a", "b", "c", "d", "e", "f", "g"]
    assert len(source.nodes[0].links) == 12
    assert all(len(step["offered_target_ids"]) == len(set(step["offered_target_ids"])) for step in row.trace if step["action"] == "LINK")


def test_named_when_unique_title_has_breadcrumb() -> None:
    data = graph().model_dump()
    data["nodes"][6]["display_name"] = "Ancestor / G"
    row = Walker(Graph.model_validate(data), First()).run(case(), "fifo")
    assert row.stopped and row.final_id == "g"


def test_named_when_duplicate_titles_need_qualified_name() -> None:
    data = graph().model_dump()
    data["nodes"][1].update(title="G", display_name="Other / G")
    data["nodes"][6]["display_name"] = "Ancestor / G"
    source = Graph.model_validate(data)
    with pytest.raises(BenchmarkError):
        Walker(source, First()).run(case(), "fifo")
    row = Walker(source, First()).run(case().model_copy(update={"goal_name": "Ancestor / G"}), "fifo")
    assert row.stopped and row.final_id == "g"


def test_named_when_title_and_display_name_collide() -> None:
    data = graph().model_dump()
    data["nodes"][1].update(title="Other", display_name="G")
    data["nodes"][6]["display_name"] = "Ancestor / G"
    with pytest.raises(BenchmarkError):
        Walker(Graph.model_validate(data), First()).run(case(), "fifo")
