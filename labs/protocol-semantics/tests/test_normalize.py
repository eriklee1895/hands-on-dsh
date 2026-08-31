import json
from pathlib import Path

PROJECT_ROOT = Path(__file__).parents[1]


def test_normalize_module_exists_before_transcript_behavior() -> None:
    assert (PROJECT_ROOT / "src" / "protocol_labs" / "normalize.py").is_file()


def test_normalize_committed_answer_matches_protocol_neutral_fixture() -> None:
    from protocol_labs.normalize import normalize_committed_transcript

    expected = [
        json.loads(line)
        for line in (PROJECT_ROOT / "fixtures" / "committed-answer.jsonl").read_text().splitlines()
    ]

    assert normalize_committed_transcript("fixture prompt", "fixture answer") == expected


def test_normalization_preserves_ordered_text_blocks() -> None:
    from protocol_labs.normalize import normalize_committed_transcript

    assert normalize_committed_transcript(
        [
            {"type": "text", "text": "first"},
            {"type": "text", "text": "second"},
        ],
        "answer",
    )[0]["content"] == [
        {"type": "text", "text": "first"},
        {"type": "text", "text": "second"},
    ]
