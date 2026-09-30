import json
import sys
from pathlib import Path
from types import ModuleType

import pytest
from pydantic import ValidationError
from typer.testing import CliRunner

from destination_walk import Case as LegacyCase, First as LegacyFirst, Graph, Limits, Selection, Walker
from models import BenchmarkError
from multi_evidence_eval import Answer, Navigation, Rubric, evaluate
from multi_evidence_model import First, LayaSelector, Observation, PACK, ReadDocument, pack
from multi_evidence_walk import Case, Session, app, gather, initialize, load_session, reader_act, reader_state
from test_benchmark import CharacterTokenizer


def graph() -> Graph:
    texts = {"a": "Alpha limit is 10.\n\nUnrelated detail.", "b": "Beta delay is 20.", "c": "Gamma count is 30.", "d": "Alpha limit is 10.", "e": "Nothing useful.", "z": "Alpha limit is 10.\n\nBeta delay is 20."}
    return Graph.model_validate({"nodes": [{"id": key, "title": key.upper(), "text": text, "links": [{"target_id": target, "label": target, "source_url": "https://example.test/"+target} for target in ({"a": ["b", "d", "e", "c"], "b": ["a"]}.get(key, []))]} for key, text in texts.items()]})


def rubric() -> Rubric:
    return Rubric.model_validate({"case_id": "test", "facts": [{"id": key, "component": i, "expected_answer_any": [str(i*10)], "source_quotes": [quote]} for i, (key, quote) in enumerate([("alpha", "Alpha limit is 10."), ("beta", "Beta delay is 20."), ("gamma", "Gamma count is 30.")], 1)]})


def session() -> Session:
    return Session(graph_path="unused", graph_sha256="fixture", case=Case(id="test", query="Combine alpha, beta, gamma", start_id="a"), history=["a"], read_ids=["a"])


def answer() -> Answer:
    return Answer.model_validate({"components": [{"component": i, "answer": str(i*10), "citations": [{"document_id": doc, "quote": fact.source_quotes[0]}]} for i, (doc, fact) in enumerate(zip(["a", "b", "c"], rubric().facts, strict=True), 1)], "synthesis": "Three limits.", "complete": True})


def test_legacy_arrival_when_only_one_of_three_facts_read() -> None:
    disjoint = graph().model_copy(update={"nodes": [n for n in graph().nodes if n.id != "z"]})
    row = Walker(disjoint, LegacyFirst()).run(LegacyCase(id="test", query="A", goal_name="A", kind="named-goal", start_id="a"), "fifo")
    metrics = evaluate(disjoint, Navigation(read_ids=row.read_ids), rubric())
    assert row.stopped and row.read_ids == ["a"]
    assert metrics.retrieved_fact_coverage == 1/3
    assert metrics.global_minimum_cover.size == 3


def test_gather_when_cross_document_union_needed() -> None:
    row = gather(session(), graph(), First(), "laya")
    metrics = evaluate(graph(), Navigation(read_ids=row.read_ids), rubric())
    assert row.read_ids == ["a", "b", "d", "e", "c"] and row.reason == "exhausted"
    assert metrics.covered_fact_ids == ["alpha", "beta", "gamma"]
    assert metrics.earliest_complete_prefix == 5
    assert metrics.incremental_contribution_document_ids == ["a", "b", "c"]
    assert metrics.redundant_support_document_ids == ["d"] and metrics.irrelevant_document_ids == ["e"]
    assert metrics.read_minimum_cover.size == 3 and metrics.global_minimum_cover.size == 2
    assert metrics.fixed_prefix_covered_fact_counts == {"3": 2, "6": 3, "9": 3, "12": 3}


def test_reader_when_every_transition_must_be_current() -> None:
    row = gather(session(), graph(), First(), "laya")
    current, history = "a", ["a"]
    for step in row.trace:
        assert step.source_id == current
        if step.action == "LINK":
            assert step.target_id in [e.target_id for n in graph().nodes if n.id == current for e in n.links]
            history.append(step.target_id)
        else:
            history.pop()
            assert step.target_id == history[-1]
        current = step.target_id


@pytest.mark.parametrize("limits,expected", [(Limits(reads=2), "read_budget"), (Limits(actions=1), "action_budget")])
def test_gather_when_budget_exhausted(limits, expected) -> None:
    row = gather(session().model_copy(update={"limits": limits}), graph(), First(), "laya")
    assert row.reason == expected and row.read_ids == ["a", "b"]
    with pytest.raises(BenchmarkError):
        reader_act(row, graph(), "A")


@pytest.mark.parametrize("choice", ["BACK", "Z", "z", "ARRIVED"])
def test_reader_when_action_not_offered(choice) -> None:
    with pytest.raises(BenchmarkError):
        reader_act(session(), graph(), choice)


def test_selector_when_bad_index() -> None:
    class Invalid:
        def choose(self, observation):
            return Selection(index=99)
    with pytest.raises(BenchmarkError):
        gather(session(), graph(), Invalid(), "laya")


def test_observations_when_labels_change_and_bodies_unseen() -> None:
    observed = []
    class Capture:
        def choose(self, observation):
            observed.append(observation.model_dump())
            return Selection(index=0)
    row = gather(session(), graph(), Capture(), "laya")
    before = json.dumps(observed)
    alternative = rubric().model_copy(update={"facts": [rubric().facts[2]]})
    evaluate(graph(), Navigation(read_ids=row.read_ids), alternative)
    assert before == json.dumps(observed)
    assert [d["body"] for d in observed[0]["documents"]] == [graph().nodes[0].text]
    assert len(observed[1]["documents"]) == 2
    assert "id" not in observed[0] and "source_quotes" not in before
    with pytest.raises(ValidationError):
        Case.model_validate({**session().case.model_dump(), "target_ids": ["z"]})


def test_pack_when_twelve_documents_need_balanced_snippets() -> None:
    observation = Observation(query="limits", current_title="Last", documents=[ReadDocument(title=f"Page{i}", body=f"Evidence{i} "+"long "*200) for i in range(12)], options={"A": "option "*100})
    state, choices, dropped = pack(observation, CharacterTokenizer())
    evidence = json.loads(state)["evidence"]
    assert len(state) <= 700 and len(choices["A"]) <= 36 and dropped > 0
    assert len(evidence) == 12 and all(d["snippet"] for d in evidence)
    assert all(d["snippet"].startswith(f"Evidence{i}") for i, d in enumerate(evidence))


def test_pack_when_query_exhausts_budget() -> None:
    observation = Observation(query="x"*1000, current_title="A", documents=[ReadDocument(title="A", body="Evidence")], options={"A": "B"})
    with pytest.raises(BenchmarkError):
        pack(observation, CharacterTokenizer())


def test_answer_when_valid_grounded_citations() -> None:
    result = evaluate(graph(), Navigation(read_ids=["a", "b", "c"]), rubric(), answer())
    assert result.grounded_answer_coverage == 1 and result.valid_citation_count == 3
    assert result.cited_minimum_cover.size == 3 and not result.unsupported_complete_claim


@pytest.mark.parametrize("document,quote", [("z", "Alpha limit is 10."), ("a", "Fabricated quote."), ("a", "Unrelated detail.")])
def test_answer_when_unread_fabricated_or_irrelevant_citation(document, quote) -> None:
    raw = answer().model_dump()
    raw["components"][0]["citations"] = [{"document_id": document, "quote": quote}]
    result = evaluate(graph(), Navigation(read_ids=["a", "b", "c"]), rubric(), Answer.model_validate(raw))
    assert result.grounded_answer_fact_ids == ["beta", "gamma"] and result.unsupported_complete_claim
    assert result.citation_checks[0].supported_fact_ids == []


def test_answer_when_correct_source_but_wrong_numeric_value() -> None:
    raw = answer().model_dump()
    raw["components"][0]["answer"] = "110"
    result = evaluate(graph(), Navigation(read_ids=["a", "b", "c"]), rubric(), Answer.model_validate(raw))
    assert result.retrieved_fact_coverage == 1 and result.valid_citation_count == 3
    assert result.grounded_answer_coverage == 2/3 and result.unsupported_component_ids == [1]


def test_citation_when_markup_and_whitespace_differ() -> None:
    raw = answer().model_dump()
    raw["components"][0]["citations"][0]["quote"] = "Alpha **limit** is\n10."
    assert evaluate(graph(), Navigation(read_ids=["a", "b", "c"]), rubric(), Answer.model_validate(raw)).grounded_answer_coverage == 1


def test_broker_cli_when_link_back_finish_and_illegal_progress(tmp_path: Path) -> None:
    source, case_file, state = [tmp_path/name for name in ("graph.json", "case.json", "session.json")]
    source.write_text(graph().model_dump_json())
    case_file.write_text(session().case.model_dump_json())
    runner = CliRunner()
    started = runner.invoke(app, ["init-reader", "--graph", str(source), "--case-file", str(case_file), "--session", str(state)])
    assert started.exit_code == 0, started.output
    linked = runner.invoke(app, ["reader-act", "--session", str(state), "--choice", "A"])
    assert json.loads(linked.output)["current_body"] == "Beta delay is 20."
    backed = runner.invoke(app, ["reader-act", "--session", str(state), "--choice", "BACK"])
    assert json.loads(backed.output)["read_count"] == 2
    before = load_session(state)[0]
    assert runner.invoke(app, ["reader-finish", "--session", str(state)]).exit_code == 0
    finished = load_session(state)[0]
    assert finished.trace == before.trace and finished.read_ids == before.read_ids
    assert runner.invoke(app, ["reader-act", "--session", str(state), "--choice", "A"]).exit_code != 0


def test_session_when_graph_or_history_tampered(tmp_path: Path) -> None:
    source = tmp_path/"graph.json"
    source.write_text(graph().model_dump_json())
    state = initialize(source, session().case)
    target = tmp_path/"session.json"
    target.write_text(state.model_copy(update={"read_ids": ["a", "z"]}).model_dump_json())
    with pytest.raises(BenchmarkError):
        load_session(target)


def test_evaluation_when_only_english_capitalization_differs() -> None:
    facts = rubric().model_dump()
    facts["facts"][0].update(expected_answer_any=["alpha"], source_quotes=["ALPHA LIMIT IS 10."])
    raw = answer().model_dump()
    raw["components"][0]["answer"] = "ALPHA"
    result = evaluate(graph(), Navigation(read_ids=["a", "b", "c"]), Rubric.model_validate(facts), Answer.model_validate(raw))
    assert result.retrieved_fact_coverage == 1 and result.grounded_answer_coverage == 1


def test_answer_contribution_when_valid_quote_but_wrong_value() -> None:
    raw = answer().model_dump()
    raw["components"][0]["answer"] = "110"
    result = evaluate(graph(), Navigation(read_ids=["a", "b", "c"]), rubric(), Answer.model_validate(raw))
    metrics = result.model_dump()
    assert metrics.get("answer_contributing_document_ids", result.cited_useful_document_ids) == ["b", "c"]
    assert metrics.get("answer_contributing_minimum_cover", result.cited_minimum_cover) is None


@pytest.mark.parametrize("truncated", [False, True])
def test_cache_when_prior_evidence_changes_and_version_is_separate(monkeypatch, tmp_path: Path, truncated) -> None:
    calls = []
    class Agent:
        tok = CharacterTokenizer()
        def predict_batch(self, states, questions, **kwargs):
            calls.append(states[0])
            keys = list(questions["next"]["criteria"])
            return [{"answers": {"next": {"choice": keys[0], "probabilities": {k: 1/len(keys) for k in keys}}}, "usage": {"input_tokens": 50, "state_tokens": 40, "state_tokens_dropped": int(truncated), "truncated": truncated, "truncated_questions": []}}]
    def resident(self, output, device):
        self.agent, self.path, self.cache, self.namespace = Agent(), output, {}, "legacy-fixture"
    common = ModuleType("laya.common")
    common.build_sequence = lambda tok, state, question, **kwargs: ([1], list(question["crit"]), {"options_distinct": len(question["crit"])})
    monkeypatch.setitem(sys.modules, "laya.common", common)
    monkeypatch.setattr("multi_evidence_model.ResidentLaya.__init__", resident)
    selector = LayaSelector(tmp_path/"cache.json", "mps")
    observation = Observation(query="limits", current_title="B", documents=[ReadDocument(title="A", body="Prior evidence"), ReadDocument(title="B", body="Current evidence")], options={"A": "One", "B": "Two"})
    if truncated:
        with pytest.raises(BenchmarkError):
            selector.choose(observation)
        assert not selector.path.exists()
        return
    first, repeat = selector.choose(observation), selector.choose(observation)
    assert first.model_calls == 1 and repeat.cache_hits == 1 and len(calls) == 1
    assert PACK in selector.namespace and selector.namespace != "legacy-fixture"
    assert len(json.loads(calls[0])["evidence"]) == 2
    selector.choose(observation.model_copy(update={"documents": [ReadDocument(title="A", body="Changed prior evidence"), observation.documents[1]]}))
    assert len(calls) == 2 and selector.path.stat().st_size > 0


def test_pack_when_code_identifiers_and_numeric_values_remain_distinct() -> None:
    from multi_evidence_eval import normalized
    assert normalized("`MAX_COUNT` = 10") == "max_count = 10"
    assert normalized("`Thing<T>` = 10") == "thing<t> = 10"
    assert normalized("`MAXCOUNT` = 110") != normalized("`MAX_COUNT` = 10")


def test_gather_when_duplicate_edges_precede_fifth_destination() -> None:
    data = graph().model_dump()
    edges = data["nodes"][0]["links"]
    data["nodes"][0]["links"] = [edges[0], *edges, {"target_id": "z", "label": "Z", "source_url": "https://example.test/z"}]
    row = gather(session(), Graph.model_validate(data), First(), "laya")
    assert row.trace[0].offered_target_ids == ["b", "d", "e", "c"]
    assert row.read_ids == ["a", "b", "d", "e", "c", "z"]
