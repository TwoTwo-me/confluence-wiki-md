#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.12"
# dependencies = ["pydantic==2.13.5", "typer==0.27.2"]
# ///
# How to run: artifacts/laya-wiki/venv/bin/python experiments/laya-wiki/multi_evidence_eval.py --help
"""Post-run exact-span metrics; lexical anchors are not a semantic correctness judge."""
from __future__ import annotations

import html
import json
import re
from pathlib import Path

import typer
from pydantic import Field, model_validator

from destination_walk import Boundary, Graph
from models import BenchmarkError


def normalized(text: str) -> str:
    text = html.unescape(text)
    pieces = re.split(r"(`+[^`]*`+)", text)
    for index in range(len(pieces)):
        if index % 2:
            pieces[index] = pieces[index].strip("`")
        else:
            pieces[index] = re.sub(r"\[([^\]]+)\]\([^)]*\)", r"\1", pieces[index])
            pieces[index] = re.sub(r"</?[A-Za-z][^>]*>", " ", pieces[index])
            pieces[index] = re.sub(r"(\*\*|__)(.*?)\1", r"\2", pieces[index])
            pieces[index] = re.sub(r"(?m)^\s{0,3}#{1,6}\s+", "", pieces[index])
    return " ".join("".join(pieces).split()).casefold()


def answer_anchor_present(anchor: str, answer: str) -> bool:
    needle = normalized(anchor)
    pattern = (r"(?<!\d)" if needle[0].isdigit() else "") + re.escape(needle) + (r"(?!\d)" if needle[-1].isdigit() else "")
    return re.search(pattern, normalized(answer)) is not None


class Fact(Boundary):
    id: str = Field(min_length=1)
    component: int = Field(ge=1)
    expected_answer_any: list[str] = Field(min_length=1)
    source_quotes: list[str] = Field(min_length=1)

    @model_validator(mode="after")
    def nonempty_spans(self) -> Fact:
        if any(not normalized(s) for s in self.expected_answer_any+self.source_quotes):
            raise BenchmarkError("Evidence and answer anchors must remain nonblank after normalization")
        return self


class Rubric(Boundary):
    case_id: str
    facts: list[Fact] = Field(min_length=1, max_length=20)

    @model_validator(mode="after")
    def unique_facts(self) -> Rubric:
        if len({f.id for f in self.facts}) != len(self.facts):
            raise BenchmarkError("Duplicate rubric fact ID")
        return self


class Citation(Boundary):
    document_id: str
    quote: str


class Component(Boundary):
    component: int = Field(ge=1)
    answer: str
    citations: list[Citation]


class Answer(Boundary):
    components: list[Component]
    synthesis: str
    complete: bool

    @model_validator(mode="after")
    def unique_components(self) -> Answer:
        if len({c.component for c in self.components}) != len(self.components):
            raise BenchmarkError("Duplicate answer component")
        return self


class Navigation(Boundary):
    read_ids: list[str]


class Cover(Boundary):
    size: int
    document_ids: list[str]


def minimum_cover(masks: dict[str, int], required: int) -> Cover | None:
    solutions: dict[int, list[str]] = {0: []}
    for doc_id, mask in masks.items():
        if not mask:
            continue
        for have, chosen in list(solutions.items()):
            combined = have | (mask & required)
            if combined not in solutions or len(chosen)+1 < len(solutions[combined]):
                solutions[combined] = chosen+[doc_id]
    chosen = solutions.get(required)
    return Cover(size=len(chosen), document_ids=chosen) if chosen is not None else None


class CitationCheck(Boundary):
    component: int
    document_id: str
    actually_read: bool
    quote_in_source: bool
    valid: bool
    supported_fact_ids: list[str]


class Evaluation(Boundary):
    case_id: str
    unique_reads: int
    duplicate_read_entries: int
    required_fact_count: int
    covered_fact_ids: list[str]
    retrieved_fact_coverage: float
    supporting_documents: dict[str, list[str]]
    useful_document_ids: list[str]
    irrelevant_document_ids: list[str]
    incremental_contribution_document_ids: list[str]
    redundant_support_document_ids: list[str]
    read_minimum_cover: Cover | None
    global_minimum_cover: Cover | None
    observed_union_minimum_cover: Cover | None
    earliest_complete_prefix: int | None
    fixed_prefix_covered_fact_counts: dict[str, int]
    citation_checks: list[CitationCheck]
    valid_citation_count: int
    cited_useful_document_ids: list[str]
    cited_minimum_cover: Cover | None
    answer_contributing_document_ids: list[str]
    answer_contributing_minimum_cover: Cover | None
    grounded_answer_fact_ids: list[str]
    grounded_answer_coverage: float
    unsupported_component_ids: list[int]
    unknown_component_ids: list[int]
    reported_complete: bool | None
    unsupported_complete_claim: bool
    semantic_judgment: str = "Exact normalized evidence spans and answer anchors only; additional claims and synthesis require manual semantic review."


def evaluate(graph: Graph, navigation: Navigation, rubric: Rubric, answer: Answer | None = None) -> Evaluation:
    nodes = {n.id: normalized(n.text) for n in graph.nodes}
    reads = list(dict.fromkeys(navigation.read_ids))
    if any(i not in nodes for i in reads):
        raise BenchmarkError("Navigation refers to unknown document")
    masks = {doc_id: sum(1 << index for index, fact in enumerate(rubric.facts) if any(normalized(quote) in text for quote in fact.source_quotes)) for doc_id, text in nodes.items()}
    required = (1 << len(rubric.facts))-1
    seen, earliest, incremental, redundant, prefixes = 0, None, [], [], []
    for count, doc_id in enumerate(reads, 1):
        support = masks[doc_id]
        if support & ~seen:
            incremental.append(doc_id)
        elif support:
            redundant.append(doc_id)
        seen |= support
        prefixes.append(seen.bit_count())
        if seen == required and earliest is None:
            earliest = count
    checks, grounded, cited_masks, unsupported, unknown = [], set(), {}, [], []
    for component in answer.components if answer else []:
        component_facts = [(i, f) for i, f in enumerate(rubric.facts) if f.component == component.component]
        if not component_facts:
            unknown.append(component.component)
        cited_facts = set()
        for citation in component.citations:
            quote = normalized(citation.quote)
            actual = citation.document_id in reads
            in_source = bool(quote) and citation.document_id in nodes and quote in nodes[citation.document_id]
            supported = [i for i, f in component_facts if actual and in_source and any(normalized(q) in quote for q in f.source_quotes)]
            checks.append(CitationCheck(component=component.component, document_id=citation.document_id, actually_read=actual, quote_in_source=in_source, valid=actual and in_source, supported_fact_ids=[rubric.facts[i].id for i in supported]))
            cited_facts.update(supported)
            if supported:
                cited_masks[citation.document_id] = cited_masks.get(citation.document_id, 0) | sum(1 << i for i in supported)
        valid_facts = {i for i, f in component_facts if i in cited_facts and any(answer_anchor_present(anchor, component.answer) for anchor in f.expected_answer_any)}
        grounded.update(valid_facts)
        if not component_facts or len(valid_facts) != len(component_facts):
            unsupported.append(component.component)
    useful = [i for i in reads if masks[i]]
    grounded_mask = sum(1 << i for i in grounded)
    answer_masks = {doc: mask & grounded_mask for doc, mask in cited_masks.items() if mask & grounded_mask}
    return Evaluation(case_id=rubric.case_id, unique_reads=len(reads), duplicate_read_entries=len(navigation.read_ids)-len(reads), required_fact_count=len(rubric.facts), covered_fact_ids=[f.id for i, f in enumerate(rubric.facts) if seen & (1 << i)], retrieved_fact_coverage=seen.bit_count()/len(rubric.facts), supporting_documents={f.id: [d for d, mask in masks.items() if mask & (1 << i)] for i, f in enumerate(rubric.facts)}, useful_document_ids=useful, irrelevant_document_ids=[i for i in reads if not masks[i]], incremental_contribution_document_ids=incremental, redundant_support_document_ids=redundant, read_minimum_cover=minimum_cover({i: masks[i] for i in reads}, required), global_minimum_cover=minimum_cover(masks, required), observed_union_minimum_cover=minimum_cover({i: masks[i] for i in reads}, seen), earliest_complete_prefix=earliest, fixed_prefix_covered_fact_counts={str(k): prefixes[min(k, len(prefixes))-1] if prefixes else 0 for k in (3, 6, 9, 12)}, citation_checks=checks, valid_citation_count=sum(c.valid for c in checks), cited_useful_document_ids=list(cited_masks), cited_minimum_cover=minimum_cover(cited_masks, required), answer_contributing_document_ids=list(answer_masks), answer_contributing_minimum_cover=minimum_cover(answer_masks, required), grounded_answer_fact_ids=[f.id for i, f in enumerate(rubric.facts) if i in grounded], grounded_answer_coverage=len(grounded)/len(rubric.facts), unsupported_component_ids=unsupported, unknown_component_ids=unknown, reported_complete=answer.complete if answer else None, unsupported_complete_claim=bool(answer and answer.complete and len(grounded) != len(rubric.facts)))


def main(graph: Path = typer.Option(...), navigation: Path = typer.Option(...), rubric: Path = typer.Option(...), output: Path = typer.Option(...), answer: Path | None = None) -> None:
    result = evaluate(Graph.model_validate_json(graph.read_bytes()), Navigation.model_validate_json(navigation.read_bytes()), Rubric.model_validate_json(rubric.read_bytes()), Answer.model_validate_json(answer.read_bytes()) if answer else None)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(result.model_dump_json(indent=2)+"\n")
    typer.echo(json.dumps({"unique_reads": result.unique_reads, "retrieved_fact_coverage": result.retrieved_fact_coverage, "grounded_answer_coverage": result.grounded_answer_coverage, "output": str(output)}))


if __name__ == "__main__":
    typer.run(main)
