"""Loopback-only Uvicorn entry point for local learning."""

from __future__ import annotations

import uvicorn


def main() -> None:
    """Serve the default application on loopback."""
    uvicorn.run(
        "recoverable_agent_service.app:app",
        host="127.0.0.1",
        port=8000,
    )


if __name__ == "__main__":
    main()
