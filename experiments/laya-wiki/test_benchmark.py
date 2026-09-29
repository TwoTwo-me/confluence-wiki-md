"""Pure retrieval regressions, independent of downloaded model weights."""
from __future__ import annotations

import json
from pathlib import Path

import pytest
from pydantic import ValidationError

from benchmark import Mode, main
from models import BM25, BenchmarkError, Cache, Case, Document, Prediction, digest, inputs, metrics, passages


class CharacterTokenizer:
    def encode(self, text: str, *, add_special_tokens: bool = False) -> list[int]:
        return [ord(c) for c in text]

    def decode(self, tokens: list[int], *, skip_special_tokens: bool = True) -> str:
        return "".join(chr(i) for i in tokens)


def document(text: str = "비밀번호 재설정", identity: str = "password") -> Document:
    return Document(id=identity, title="계정 안내", text=text, source_url="", source_type="fixture", source_path="", private=False, sha256=digest(text))


def query() -> Case:
    return Case(id="q", query="비밀번호 재설정 링크", relevant_ids=["password"], split="test", kind="fixture")


def test_korean_retrieval_when_suffixes_differ() -> None:
    # Given: Korean inflection shares character grams; unrelated distractors do not.
    index = BM25(["서버 장애 대응", "비밀번호를 재설정하려면 계정 설정을 여세요", "점심 식단 안내"])
    # When
    ranked = index.rank("비밀번호 재설정 방법")
    # Then
    assert ranked[0] == 1


def test_idf_when_rare_term_distinguishes_document() -> None:
    # Given
    index = BM25(["common "*10, "common needle", "common other"])
    # When
    ranked = index.rank("common needle")
    # Then
    assert ranked[0] == 1


def test_tail_window_when_evidence_exceeds_prefix() -> None:
    # Given
    doc = document("# 배경\n" + "무관한 내용 "*500 + "\n# 비밀번호\n비밀번호 재설정 링크")
    tok = CharacterTokenizer()
    # When
    windows = passages(doc, query().query, tok)
    # Then
    best = BM25([p.text for p in windows]).rank(query().query)[0]
    assert "재설정 링크" in windows[best].text
    assert all(len(tok.encode(json.dumps({"query": query().query, "document": p.text}, ensure_ascii=False))) <= 768 for p in windows)
    assert all(p.text.startswith(doc.title) for p in windows)


def test_cache_key_changes_when_content_changes_with_stale_hash(tmp_path: Path) -> None:
    # Given: caller metadata deliberately stays stale.
    original = document()
    changed = original.model_copy(update={"text": "새 정보"})
    cache = Cache(tmp_path / "cache.json", "revision-1")
    # When
    changed_key = cache.key(changed, "same-query-chunk")
    # Then
    assert changed_key != cache.key(original, "same-query-chunk")


def test_cache_key_changes_when_revision_changes(tmp_path: Path) -> None:
    # Given
    old = Cache(tmp_path / "cache.json", "revision-1")
    new = Cache(tmp_path / "cache.json", "revision-2")
    # When
    key = new.key(document(), "query")
    # Then
    assert key != old.key(document(), "query")


def test_cache_roundtrip_when_prediction_saved(tmp_path: Path) -> None:
    # Given
    path = tmp_path / "cache.json"
    cache = Cache(path, "revision")
    cache.values["key"] = Prediction.model_validate({"answers": {"relevance": {"probabilities": {"A": 0.8, "B": 0.2}}}, "usage": {"input_tokens": 30, "state_tokens": 20, "state_tokens_dropped": 0, "truncated": False}})
    # When
    cache.save()
    # Then
    assert Cache(path, "revision").values["key"].answers.relevance.probabilities.A == 0.8


def test_prediction_rejects_nan_when_model_output_invalid() -> None:
    # Given
    raw = {"answers": {"relevance": {"probabilities": {"A": float("nan"), "B": 0.2}}}, "usage": {"input_tokens": 30, "state_tokens": 20, "state_tokens_dropped": 0, "truncated": False}}
    # When / Then
    with pytest.raises(ValidationError):
        Prediction.model_validate(raw)


def test_candidate_miss_when_relevant_document_excluded() -> None:
    # Given
    case = query()
    # When
    result = metrics(["other"], case, ["other"])
    # Then
    assert result.candidate_misses == ["password"]
    assert result.reranker_losses == []
    assert result.recall3 == 0


def test_reranker_loss_when_relevant_candidate_below_cutoff() -> None:
    # Given
    ranked = ["a", "b", "c", "password"]
    # When
    result = metrics(ranked, query(), ranked)
    # Then
    assert result.candidate_misses == []
    assert result.reranker_losses == ["password"]
    assert result.mrr == 0.25
    assert result.recall10 == 1


@pytest.mark.parametrize("text", ["", "   "])
def test_empty_query_when_parsing(text: str) -> None:
    # Given
    raw = query().model_dump() | {"query": text}
    # When / Then
    with pytest.raises((ValidationError, BenchmarkError)):
        Case.model_validate(raw)


def test_empty_corpus_when_loading(tmp_path: Path) -> None:
    # Given
    corpus, cases = tmp_path / "corpus.json", tmp_path / "cases.json"
    corpus.write_text("[]")
    cases.write_text(json.dumps([query().model_dump()]))
    # When / Then
    with pytest.raises(BenchmarkError):
        inputs(corpus, cases)


def test_unknown_candidate_when_loading(tmp_path: Path) -> None:
    # Given
    corpus, cases = tmp_path / "corpus.json", tmp_path / "cases.json"
    corpus.write_text(json.dumps([document().model_dump()]))
    cases.write_text(json.dumps([query().model_dump() | {"candidate_ids": ["missing"]}]))
    # When / Then
    with pytest.raises(BenchmarkError):
        inputs(corpus, cases)


def test_excessive_query_when_chunking() -> None:
    # Given
    long_query = "a" * 700
    # When / Then
    with pytest.raises(BenchmarkError):
        passages(document(), long_query, CharacterTokenizer())


def test_bad_revision_when_cli_invoked() -> None:
    # Given / When / Then: rejection must occur before loading a model.
    with pytest.raises(BenchmarkError):
        main(revision="main", mode=Mode.PREFIX)


def test_normalized_passages_when_signed_images_precede_late_fact() -> None:
    # Given: URL length overwhelms useful text in the original capture.
    from types import SimpleNamespace
    from benchmark import Runner
    signed = "https://bucket.example/image.png?X-Amz-Signature=" + "deadbeef"*400
    doc = document(f'<columns><column>![흐름도]({signed})<empty-block/></column></columns>\n# 비밀번호\n비밀번호 재설정 링크는 계정 설정에 있습니다.')
    original = doc.model_dump()
    runner = Runner.__new__(Runner)
    runner.agent = SimpleNamespace(tok=CharacterTokenizer())
    # When
    selected = runner.select(doc, query(), Mode.NORMALIZED)
    # Then
    assert any("재설정 링크는 계정 설정" in p.text for p in selected)
    assert all("X-Amz" not in p.text and "deadbeef" not in p.text for p in selected)
    assert all(p.policy == "notion-text-v1" for p in selected)
    assert doc.model_dump() == original
    assert doc.id == "password"


def test_normalization_when_code_and_database_labels_present() -> None:
    # Given
    from models import normalize_text
    code = '```python\nvalue = "<column>literal</column>"\nprint(value)\n```'
    text = '<database url="https://example.test/private">운영 규칙</database>\n' + code
    # When
    normalized = normalize_text(text)
    # Then
    assert code in normalized
    assert "운영 규칙" in normalized
    assert "example.test" not in normalized
    assert "<database" not in normalized


def test_normalization_when_images_links_and_bare_urls_present() -> None:
    # Given
    from models import normalize_text
    text = '<img src="https://aws.test/x?secret=abc" alt="구성도"> [관리 안내](https://wiki.test/x?secret=abc)\nhttps://aws.test/y?secret=abc\n```sh\ncurl https://aws.test/z?secret=abc\n```'
    # When
    normalized = normalize_text(text)
    # Then
    assert "구성도" in normalized and "관리 안내" in normalized
    assert "secret=abc" not in normalized and "https://" not in normalized
    assert "```sh\ncurl [URL omitted]\n```" in normalized
