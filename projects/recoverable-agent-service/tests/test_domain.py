from __future__ import annotations

import importlib

import pytest


def load_domain():
    try:
        return importlib.import_module("recoverable_agent_service.domain")
    except ImportError as error:
        pytest.fail(f"Task 1A domain module is not implemented: {error}")


def test_named_domain_exceptions_are_distinct() -> None:
    domain = load_domain()

    assert issubclass(domain.NotFoundError, domain.StoreError)
    assert issubclass(domain.InvalidInputError, domain.StoreError)
    assert issubclass(domain.ConflictError, domain.StoreError)
    assert issubclass(domain.InvalidTransitionError, domain.StoreError)
    assert issubclass(domain.FutureSchemaVersionError, domain.StoreError)


@pytest.mark.parametrize("value", ["", "   ", "x" * 129, None])
def test_idempotency_key_rejects_values_outside_the_normalized_bound(value: object) -> None:
    domain = load_domain()

    with pytest.raises(domain.InvalidInputError):
        domain.normalize_idempotency_key(value)


def test_idempotency_key_is_trimmed_but_preserves_internal_whitespace() -> None:
    domain = load_domain()

    assert domain.normalize_idempotency_key("  client request 7  ") == "client request 7"


@pytest.mark.parametrize(
    "names",
    [
        ["same.txt", "same.txt"],
        ["."],
        [".."],
        ["nested/file.txt"],
        ["back\\slash.txt"],
        ["-leading.txt"],
        ["x" * 129],
    ],
)
def test_artifact_names_reject_duplicates_and_unsafe_paths(names: list[str]) -> None:
    domain = load_domain()

    with pytest.raises(domain.InvalidInputError):
        domain.normalize_artifact_names(names)


def test_artifact_names_and_request_fingerprint_remain_request_canonical() -> None:
    domain = load_domain()

    assert domain.normalize_artifact_names(["z.json", "a.txt"]) == ("a.txt", "z.json")
    assert domain.request_fingerprint("hello", ["z.json", "a.txt"]) == (
        "v1:183679a861ba0b116e52701d256d5ad1ad11ee7acf9a3405a45148a978f12033"
    )
    assert domain.request_fingerprint("hello", ["a.txt", "z.json"]) == (
        "v1:183679a861ba0b116e52701d256d5ad1ad11ee7acf9a3405a45148a978f12033"
    )


def test_runtime_input_uses_deterministic_exact_artifact_paths() -> None:
    domain = load_domain()

    assert domain.build_runtime_input("run-123", "hello", ["z.json", "a.txt"]) == (
        "Execute the exact user prompt delimited below.\n"
        "<<<USER_PROMPT_START:5>>>\n"
        "hello\n"
        "<<<USER_PROMPT_END>>>\n\n"
        "Service-owned artifact requirements:\n"
        "- You MUST write artifact `a.txt` to exactly `artifacts/run-123/a.txt`.\n"
        "- You MUST write artifact `z.json` to exactly `artifacts/run-123/z.json`.\n"
        "- Do not rename these artifacts or substitute alternate paths."
    )


def test_runtime_input_preserves_multiline_prompt_verbatim() -> None:
    domain = load_domain()

    assert domain.build_runtime_input("run-7", "  first\nsecond  ", []) == (
        "Execute the exact user prompt delimited below.\n"
        "<<<USER_PROMPT_START:16>>>\n"
        "  first\n"
        "second  \n"
        "<<<USER_PROMPT_END>>>\n\n"
        "Service-owned artifact requirements:\n"
        "- No service-owned artifacts were requested."
    )
