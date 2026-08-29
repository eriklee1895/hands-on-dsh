from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TUTORIALS = {
    "01-blocking-api.md": "第一章",
    "02-sse-stream.md": "第二章",
    "03-multi-turn-session.md": "第三章",
    "04-tool-trajectory.md": "第四章",
    "05-runtime-lifecycle.md": "第五章",
}


def test_project_declares_ruff_quality_checks() -> None:
    config = (ROOT / "pyproject.toml").read_text(encoding="utf-8")

    assert '"ruff>=' in config
    assert "[tool.ruff]" in config
    assert 'target-version = "py310"' in config
    assert "[tool.ruff.lint]" in config


def test_every_case_has_a_complete_chinese_tutorial() -> None:
    required = ["## 学习目标", "## 运行", "## 源码分析", "## 验证", "## 限制"]
    for filename, title in TUTORIALS.items():
        path = ROOT / "src/dsh_fastapi_101/static/tutorials" / filename
        content = path.read_text(encoding="utf-8")
        assert title in content
        assert all(heading in content for heading in required)
        assert "```mermaid" in content
        assert "../" not in content
