"""Protocol-neutral committed transcript primitives."""

from __future__ import annotations

from collections.abc import Sequence

TextBlock = dict[str, str]


def normalize_committed_transcript(
    prompt: str | Sequence[TextBlock], committed_answer: str
) -> list[dict[str, object]]:
    """Normalize one completed prompt and committed answer.

    Args:
        prompt: Prompt text or ordered text blocks.
        committed_answer: Final committed assistant text.

    Returns:
        Protocol-neutral user, assistant, and completed-turn records.
    """
    if isinstance(prompt, str):
        prompt_blocks = [{"type": "text", "text": prompt}]
    else:
        prompt_blocks = [dict(block) for block in prompt]
    return [
        {"kind": "user_message", "content": prompt_blocks},
        {
            "kind": "assistant_message",
            "content": [{"type": "text", "text": committed_answer}],
        },
        {"kind": "turn_end", "reason": {"kind": "completed"}},
    ]
