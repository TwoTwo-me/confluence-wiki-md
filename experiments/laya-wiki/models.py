"""Typed retrieval inputs and deterministic lexical passage selection."""
from __future__ import annotations

import hashlib
import json
import math
import re
from collections import Counter
from dataclasses import dataclass
from pathlib import Path
from typing import Literal, Protocol

from pydantic import BaseModel, ConfigDict, Field, TypeAdapter, field_validator


@dataclass(frozen=True, slots=True)
class BenchmarkError(Exception):
    reason: str

    def __str__(self) -> str:
        return self.reason


class Document(BaseModel):
    model_config = ConfigDict(frozen=True, extra="ignore", strict=True)
    id: str = Field(min_length=1)
    title: str = Field(min_length=1)
    text: str = Field(min_length=1)
    source_url: str
    source_type: str
    source_path: str
    private: bool
    sha256: str
    parent_id: str | None = None

    @field_validator("title", "text")
    @classmethod
    def nonblank(cls, value: str) -> str:
        if not value.strip():
            raise BenchmarkError("Blank document title/text")
        return value


class Case(BaseModel):
    model_config = ConfigDict(frozen=True, extra="ignore", strict=True)
    id: str = Field(min_length=1)
    query: str = Field(min_length=1)
    relevant_ids: list[str]
    split: Literal["calibration", "test"]
    kind: str
    candidate_ids: list[str] | None = None

    @field_validator("query")
    @classmethod
    def nonblank(cls, value: str) -> str:
        if not value.strip():
            raise BenchmarkError("Blank query")
        return value


def inputs(corpus: Path, cases: Path) -> tuple[list[Document], list[Case]]:
    docs = TypeAdapter(list[Document]).validate_json(corpus.read_bytes())
    queries = TypeAdapter(list[Case]).validate_json(cases.read_bytes())
    if not docs or not queries:
        raise BenchmarkError("Corpus and cases must be nonempty")
    ids = {d.id for d in docs}
    if len(ids) != len(docs) or len({q.id for q in queries}) != len(queries):
        raise BenchmarkError("Duplicate document or case IDs")
    for q in queries:
        if set(q.relevant_ids) - ids or set(q.candidate_ids or []) - ids:
            raise BenchmarkError(f"Unknown document ID in case {q.id}")
        if q.candidate_ids is not None and len(set(q.candidate_ids)) != len(q.candidate_ids):
            raise BenchmarkError(f"Duplicate candidates in case {q.id}")
    return docs, queries


def digest(text: str) -> str:
    return hashlib.sha256(text.encode()).hexdigest()


def terms(text: str) -> list[str]:
    result = re.findall(r"[a-z0-9_]+", text.lower())
    for word in re.findall(r"[가-힣]+", text):
        result.extend(word[i:i+n] for n in (2, 3) for i in range(len(word)-n+1))
    return result


class BM25:
    """Build postings once; each query visits only postings for its terms."""
    def __init__(self, documents: list[str]) -> None:
        self.lengths = [len(terms(d)) for d in documents]
        self.average = sum(self.lengths) / max(1, len(documents)) or 1
        self.postings: dict[str, list[tuple[int, int]]] = {}
        for i, doc in enumerate(documents):
            for term, count in Counter(terms(doc)).items():
                self.postings.setdefault(term, []).append((i, count))

    def scores(self, query: str) -> list[float]:
        scores = [0.0] * len(self.lengths)
        for term in set(terms(query)):
            posting = self.postings.get(term, [])
            idf = math.log(1 + (len(scores) - len(posting) + 0.5) / (len(posting) + 0.5))
            for i, tf in posting:
                scores[i] += idf * tf * 2.5 / (tf + 1.5 * (0.25 + 0.75*self.lengths[i]/self.average))
        return scores

    def rank(self, query: str) -> list[int]:
        scores = self.scores(query)
        return sorted(range(len(scores)), key=lambda i: (-scores[i], i))


class Tokenizer(Protocol):
    def encode(self, text: str, *, add_special_tokens: bool = False) -> list[int]: ...
    def decode(self, tokens: list[int], *, skip_special_tokens: bool = True) -> str: ...


@dataclass(frozen=True, slots=True)
class Passage:
    text: str
    index: int
    tokens: int


def passages(doc: Document, query: str, tok: Tokenizer) -> list[Passage]:
    """Overlapping windows retain title and preceding Markdown heading; reserve 256 head tokens."""
    query_cost = len(tok.encode(json.dumps({"query": query, "document": ""}, ensure_ascii=False)))
    if query_cost > 512:
        raise BenchmarkError("Query leaves insufficient document token budget")
    result: list[Passage] = []
    heading = doc.title
    for section in re.split(r"(?m)(?=^#{1,6} )", doc.text):
        if section.startswith("#"):
            heading = section.splitlines()[0]
        prefix = doc.title + "\n" + heading + "\n"
        budget = 1024 - 256 - query_cost - len(tok.encode(prefix))
        if budget < 32:
            raise BenchmarkError("Document title/heading exhausts token budget")
        ids = tok.encode(section)
        for start in range(0, max(1, len(ids)), max(1, budget - 64)):
            text = prefix + tok.decode(ids[start:start+budget])
            while len(tok.encode(json.dumps({"query": query, "document": text}, ensure_ascii=False))) > 768:
                ids_slice = tok.encode(text)
                text = tok.decode(ids_slice[:-8])
            result.append(Passage(text, len(result), len(tok.encode(text))))
    return result


class Metrics(BaseModel):
    recall3: float
    recall10: float
    hit3: float
    mrr: float
    candidate_coverage: float
    candidate_misses: list[str]
    reranker_losses: list[str]
    matched3: list[str]
    matched10: list[str]


def metrics(ranked: list[str], case: Case, candidates: list[str]) -> Metrics:
    relevant = set(case.relevant_ids)
    denominator = len(relevant) or 1
    matches = [i+1 for i, doc in enumerate(ranked) if doc in relevant]
    return Metrics(recall3=len(relevant & set(ranked[:3]))/denominator,
                   recall10=len(relevant & set(ranked[:10]))/denominator,
                   hit3=float(bool(relevant & set(ranked[:3]))), mrr=1/min(matches) if matches else 0,
                   candidate_coverage=len(relevant & set(candidates))/denominator,
                   candidate_misses=sorted(relevant-set(candidates)),
                   reranker_losses=sorted((relevant & set(candidates))-set(ranked[:3])),
                   matched3=sorted(relevant & set(ranked[:3])), matched10=sorted(relevant & set(ranked[:10])))


class Usage(BaseModel):
    input_tokens: int = Field(ge=0)
    state_tokens: int = Field(ge=0)
    state_tokens_dropped: int = Field(ge=0)
    truncated: bool


class Probabilities(BaseModel):
    A: float = Field(ge=0, le=1, allow_inf_nan=False)
    B: float = Field(ge=0, le=1, allow_inf_nan=False)


class Answer(BaseModel):
    probabilities: Probabilities


class Answers(BaseModel):
    relevance: Answer


class Prediction(BaseModel):
    answers: Answers
    usage: Usage


class Cache:
    """Mutable score store; content hashes are computed from actual text, never caller metadata."""
    def __init__(self, path: Path, namespace: str) -> None:
        self.path, self.namespace = path, namespace
        self.values = TypeAdapter(dict[str, Prediction]).validate_json(path.read_bytes()) if path.exists() else {}
        self.hits = 0
        self.misses = 0

    def key(self, doc: Document, state: str) -> str:
        return digest(self.namespace + digest(doc.title + doc.text) + state)

    def save(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        temporary = self.path.with_suffix(".tmp")
        temporary.write_bytes(TypeAdapter(dict[str, Prediction]).dump_json(self.values))
        temporary.replace(self.path)
