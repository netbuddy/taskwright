"""创建一个任务：建任务目录、放起始文件、经与工具相同的核心函数写任务记录。

2026-09-21 起一库一任务，任务由用户在界面上创建（选任务类型、起名、上传材料），执行者没有「创建任务」
工具。后端不写库：写任务记录这一步起一个 Node 子进程，运行 agent 里不经 pi 的命令行入口
`agent/src/cli/create_task.mts`，由它调用 `createTask` 核心函数，发起方记「用户」，编号是这里生成的操作
编号（`ui-op-` 开头）。这与观测台起 Node 子进程算完成条件是同一种做法。

用法：

    python -m taskwright_server.create_task <任务目录> [--type srs-authoring] [--name 任务名] [--tag 领域标签]
                                      [--material 材料文件 ...]

任务目录必须不存在或者是空的。三步——放起始文件、放材料、写任务记录——任何一步失败，整个创建失败，
这次建出来的东西全部清掉，任务目录回到调用之前的样子。任务类型就是代码仓 `task-types/` 下的目录名，
任务定义固定在模板里的 `docs/task-definitions/<任务类型>.json`。
"""

from __future__ import annotations

import argparse
import contextlib
import io
import json
import shutil
import subprocess
import sys
import uuid
from pathlib import Path

from taskwright_server import new_workspace

REPO_ROOT = Path(__file__).resolve().parents[2]
CLI = REPO_ROOT / "agent" / "src" / "cli" / "create_task.mts"
DEFAULT_TYPE = "srs-authoring"
#: 后端给用户操作生成的编号的前缀，与 agent 与不变式核对里的约定一致。
OPERATION_PREFIX = "ui-op-"


class CreateTaskError(Exception):
    """创建任务失败。消息是给人看的一句中文。"""


def new_operation_id() -> str:
    return f"{OPERATION_PREFIX}{uuid.uuid4().hex[:12]}"


def definition_path_of(task_type: str) -> str:
    return f"docs/task-definitions/{task_type}.json"


def create_task(target: Path, task_type: str = DEFAULT_TYPE, name: str | None = None, tag: str | None = None,
                materials: list[Path] | None = None, op_id: str | None = None, task_id: str | None = None) -> dict:
    """创建任务，返回命令行入口给出的结果（任务编号、任务名、任务类型、领域标签、事件序号），另加任务目录与操作编号。"""
    target = Path(target).expanduser().resolve()
    template = new_workspace.FIXTURE_DIR / task_type
    if not template.is_dir():
        raise CreateTaskError(f"没有「{task_type}」这种任务类型。可用的有：{'、'.join(new_workspace.available_templates())}。")
    if target.exists() and any(target.iterdir()):
        raise CreateTaskError(f"{target} 已经存在而且不是空的。一个目录只放一个任务，请换一个目录。")
    existed = target.exists()
    node = shutil.which("node")
    if node is None:
        raise CreateTaskError("在 PATH 里找不到 node，写不了任务记录。")
    op_id = op_id or new_operation_id()
    try:
        new_workspace.create(target, template)
        for material in materials or []:
            material = Path(material).expanduser()
            if not material.is_file():
                raise CreateTaskError(f"材料文件 {material} 不存在。")
            shutil.copy2(material, target / "inputs" / material.name)
        argv = [node, str(CLI), "--dir", str(target), "--definition", definition_path_of(task_type), "--op-id", op_id]
        if name:
            argv += ["--name", name]
        if tag:
            argv += ["--tag", tag]
        if task_id:
            argv += ["--task-id", task_id]
        done = subprocess.run(argv, capture_output=True, text=True, timeout=60)
        lines = [line for line in done.stdout.splitlines() if line.strip()]
        try:
            result = json.loads(lines[-1]) if lines else {}
        except json.JSONDecodeError:
            result = {}
        if done.returncode != 0 or not result.get("ok"):
            reason = result.get("error") or (done.stderr.strip() or f"命令行入口以退出码 {done.returncode} 结束")
            raise CreateTaskError(f"任务记录没有写成：{reason}")
    except BaseException:
        _clean(target, existed)
        raise
    return {**result, "任务目录": str(target), "操作编号": op_id}


def _clean(target: Path, existed: bool) -> None:
    """把这次建出来的东西清掉：目录是这次建的就整个删掉；原来就有的空目录，只清空里面。"""
    if not target.exists():
        return
    if not existed:
        shutil.rmtree(target)
        return
    for entry in target.iterdir():
        if entry.is_dir() and not entry.is_symlink():
            shutil.rmtree(entry)
        else:
            entry.unlink()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="创建一个任务：建任务目录、放起始文件、写任务记录。")
    parser.add_argument("target", help="任务目录，必须不存在或者是空的")
    parser.add_argument("--type", default=DEFAULT_TYPE, help=f"任务类型，即 task-types/ 下的目录名，默认 {DEFAULT_TYPE}")
    parser.add_argument("--name", help="任务名，可以不给")
    parser.add_argument("--tag", help="领域标签，可以不给")
    parser.add_argument("--material", action="append", default=[], help="材料文件，放进任务目录的 inputs/，可以给多个")
    args = parser.parse_args(argv)
    try:
        with contextlib.redirect_stdout(io.StringIO()):
            result = create_task(Path(args.target), args.type, args.name, args.tag, [Path(m) for m in args.material])
    except CreateTaskError as error:
        print(f"没有创建任务：{error}")
        return 1
    print(f"任务建好了：任务编号 {result['task_id']}，任务名「{result['task_name']}」，类型「{result['task_type']}」，"
          f"领域标签 {result['domain_tag'] or '（没有）'}。")
    print(f"任务目录：{result['任务目录']}；操作编号：{result['操作编号']}；事件序号：{result['event_seq']}。")
    print("接下来可以运行：python -m taskwright_server.chat " + result["任务目录"])
    return 0


if __name__ == "__main__":
    sys.exit(main())
