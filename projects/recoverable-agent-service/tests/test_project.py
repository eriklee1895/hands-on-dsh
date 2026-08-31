from __future__ import annotations

import sys
from pathlib import Path

if sys.version_info >= (3, 11):
    import tomllib
else:  # pragma: no cover - exercised by the Python 3.10 verification run
    import tomli as tomllib


PROJECT_ROOT = Path(__file__).parents[1]


def test_project_declares_the_approved_python_toolchain() -> None:
    pyproject_path = PROJECT_ROOT / "pyproject.toml"
    assert pyproject_path.is_file(), "Task 1A must create a standalone uv project"

    with pyproject_path.open("rb") as file:
        config = tomllib.load(file)

    project = config["project"]
    assert project["requires-python"] == ">=3.10"
    assert "deepseek-harness-sdk==0.1.1rc1" in project["dependencies"]
    assert any(dependency.startswith("fastapi") for dependency in project["dependencies"])
    assert any(dependency.startswith("uvicorn[standard]") for dependency in project["dependencies"])
    assert config["build-system"]["build-backend"] == "hatchling.build"

    dev_dependencies = config["dependency-groups"]["dev"]
    assert any(dependency.startswith("pytest") for dependency in dev_dependencies)
    assert any(dependency.startswith("httpx2") for dependency in dev_dependencies)
    assert any(dependency.startswith("ruff") for dependency in dev_dependencies)
    tomli_dependency = next(
        dependency for dependency in dev_dependencies if dependency.startswith("tomli>=2,<3")
    )
    assert "< '3.11'" in tomli_dependency
    assert config["tool"]["ruff"]["target-version"] == "py310"
    assert config["tool"]["pytest"]["ini_options"]["testpaths"] == ["tests"]
    assert config["tool"]["pytest"]["ini_options"]["addopts"] == [
        "-q",
        "-m",
        "not e2e",
    ]
    assert any(
        marker.startswith("e2e:") for marker in config["tool"]["pytest"]["ini_options"]["markers"]
    )
