"""Word 材料（.docx）的 Markdown 投影：上传 .docx 时在同一目录生成「文件名.docx.md」，文件里的图片抽到「文件名.docx.media/」。

执行者读投影，保存修订时逐字核对也对着它。投影怎样写只在 agent 的 `agent/src/lib/docx_markdown.ts` 里写一份，
这里起一个 Node 子进程运行它的命令行入口 `agent/src/cli/docx_projection.mts`（与建任务、算完成条件是同一种做法）。

写投影时入口接着写分段清单「文件名.docx.segments.json」，分段参数（启动配置「材料分段」一节，见 launch.segment_params）经
`--segments-json` 传过去，不给时入口用默认值。

0.2 的任务里是纯文本投影「文件名.docx.txt」，照旧可读：找投影时先找 .md，没有再找 .txt。
"""

from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
CLI = REPO_ROOT / "agent" / "src" / "cli" / "docx_projection.mts"
SUFFIX = ".md"
LEGACY_SUFFIX = ".txt"
MEDIA_SUFFIX = ".media"
SEGMENTS_SUFFIX = ".segments.json"


def _run(docx: Path, rel: str, *extra: str) -> dict:
    """运行命令行入口，返回它的结果；失败时抛 ValueError，消息是给人看的一句中文。"""
    node = shutil.which("node")
    if node is None:
        raise ValueError("在 PATH 里找不到 node，生成不了 Word 材料的投影")
    try:
        done = subprocess.run([node, str(CLI), "--docx", str(docx), "--rel", rel, *extra], capture_output=True, text=True, timeout=60)
    except (subprocess.SubprocessError, OSError) as e:
        raise ValueError(f"生成 Word 材料的投影失败：{e}") from e
    lines = [line for line in done.stdout.splitlines() if line.strip()]
    try:
        result = json.loads(lines[-1]) if lines else {}
    except json.JSONDecodeError:
        result = {}
    if done.returncode != 0 or not result.get("ok"):
        raise ValueError(result.get("error") or done.stderr.strip() or f"投影入口以退出码 {done.returncode} 结束")
    return result


def projection_path(docx: Path) -> Path:
    """这份 .docx 的投影：有 Markdown 投影用它，只有 0.2 的纯文本投影时用那个，都没有时是 Markdown 投影该在的位置。"""
    md = docx.with_name(docx.name + SUFFIX)
    legacy = docx.with_name(docx.name + LEGACY_SUFFIX)
    return legacy if not md.is_file() and legacy.is_file() else md


def write_projection(docx: Path, rel: str, segments: dict | None = None) -> Path:
    """在 .docx 旁边写投影（有图片时连同图片目录）与分段清单，返回投影的路径。不是合法的 .docx 时抛 ValueError。"""
    _run(docx, rel, *(["--segments-json", json.dumps(segments, separators=(",", ":"))] if segments else []))
    return docx.with_name(docx.name + SUFFIX)


def projection_text(docx: Path, rel: str) -> str:
    """不写文件，只算出投影全文（投影文件缺失时材料内容接口用）。"""
    return _run(docx, rel, "--print")["markdown"]


def remove_projection(docx: Path) -> None:
    """删掉这份 .docx 的 Markdown 投影、分段清单与图片目录（上传失败时清理）。"""
    docx.with_name(docx.name + SUFFIX).unlink(missing_ok=True)
    docx.with_name(docx.name + SEGMENTS_SUFFIX).unlink(missing_ok=True)
    shutil.rmtree(docx.with_name(docx.name + MEDIA_SUFFIX), ignore_errors=True)


def is_reserved(name: str) -> bool:
    """以 .docx.md、.docx.txt 结尾的文件名留给由 Word 材料生成的投影。"""
    lower = name.lower()
    return lower.endswith(".docx" + SUFFIX) or lower.endswith(".docx" + LEGACY_SUFFIX)
