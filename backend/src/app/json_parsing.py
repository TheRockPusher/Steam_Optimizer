from __future__ import annotations


class DuplicateJSONKeyError(ValueError):
    """Raised when a JSON object repeats a member name."""


def reject_duplicate_object_keys(
    pairs: list[tuple[str, object]],
) -> dict[str, object]:
    """Build one JSON object while rejecting ambiguous duplicate members."""

    result: dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            raise DuplicateJSONKeyError
        result[key] = value
    return result
