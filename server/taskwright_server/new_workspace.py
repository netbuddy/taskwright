"""建一个全新的任务目录：只把起始文件复制过去，不建库，也不建任务。

任务数据库 task.sqlite 由 pi 进程里的写入工具在第一次写入时建（「创建任务」工具），后端不建库，
所以新任务目录里没有库文件是正常的样子，读取一侧会显示「这个任务目录还没有创建任务」。

起始文件从哪里来，有两种给法：

    python -m taskwright_server.new_workspace <新任务目录> --from <起始文件目录>
    python -m taskwright_server.new_workspace <新任务目录> --template <代码仓 task-types/ 下的目录名>

起始文件目录里的相对路径就是这些文件在任务目录里的相对路径。目录顶层的 README.md 是写给人看的
目录说明，不复制进任务目录。

任务目录里一定要有 pi 的项目设置 `.pi/settings.json`，内容至少是 `{"followUpMode": "all"}`：执行者正在
工作时排队的几句话一起交给它，而不是一次一句（卡片点击的标注与那句话因此能紧挨着进会话）。起始文件
目录里带了就照它复制；没带就由本脚本写一份。不能改用 RPC 的 set_follow_up_mode，那条命令会把设置写进
pi 的全局设置文件（2026-09-21 实测）。pi 只在项目被信任时读项目设置，后端的启动配置带 --approve。

拿一个已经有库的任务目录当起始文件目录时要注意：库是 WAL 模式（write-ahead logging，改动先写进旁边的
日志文件再合并回库文件），一个库是 task.sqlite、task.sqlite-wal、task.sqlite-shm 三个文件，最新的改动
可能只在 -wal 文件里。本脚本把三个文件一起复制；但复制时如果还有 pi 进程在写这个库，复制出来的可能是
写到一半的样子，所以先停掉用这个任务目录的 pi 再复制。实测只复制 task.sqlite 会丢掉还在 -wal 里的改动。
"""

from __future__ import annotations

import argparse
import json
import shutil
import sys
from pathlib import Path

FIXTURE_DIR = Path(__file__).resolve().parents[2] / "task-types"

#: 起始文件目录顶层这几个文件是给人看的说明，不复制进任务目录。
SKIPPED_TOP_LEVEL = {"README.md"}

#: pi 的项目设置文件在任务目录里的位置，与起始文件目录没带它时写进去的内容。
PI_SETTINGS = Path(".pi") / "settings.json"
DEFAULT_PI_SETTINGS = {"followUpMode": "all"}


def available_templates() -> list[str]:
    return sorted(p.name for p in FIXTURE_DIR.iterdir() if p.is_dir())


def create(target: Path, source: Path) -> Path:
    """把起始文件目录复制成一个新任务目录。返回任务目录路径。"""
    source = Path(source).expanduser().resolve()
    if not source.is_dir():
        raise SystemExit(f"起始文件目录 {source} 不存在，或者不是一个目录。")
    target = Path(target).expanduser().resolve()
    if target.exists() and any(target.iterdir()):
        raise SystemExit(f"{target} 已经存在而且不是空的。换一个目录，或者先把它挪走。")
    target.mkdir(parents=True, exist_ok=True)
    for entry in sorted(source.iterdir()):
        if entry.name in SKIPPED_TOP_LEVEL and entry.is_file():
            continue
        if entry.is_dir():
            shutil.copytree(entry, target / entry.name)
        else:
            shutil.copy2(entry, target / entry.name)
    (target / "inputs").mkdir(exist_ok=True)
    settings = target / PI_SETTINGS
    if not settings.exists():
        settings.parent.mkdir(parents=True, exist_ok=True)
        settings.write_text(json.dumps(DEFAULT_PI_SETTINGS, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(f"起始文件目录里没有 {PI_SETTINGS}，已写一份：{json.dumps(DEFAULT_PI_SETTINGS)}。")
    if (source / "task.sqlite").exists():
        print("提醒：起始文件目录里有任务数据库，已把 task.sqlite 与它的 -wal、-shm 附属文件一起复制。"
              "复制时如果还有 pi 进程在写那个库，副本可能是写到一半的样子。")
    return target


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="建一个全新的任务目录：只复制起始文件，不建库。")
    parser.add_argument("workspace", help="新任务目录的目录，必须不存在或者是空的")
    parser.add_argument("--from", dest="source", help="起始文件目录，里面的相对路径就是任务目录里的相对路径")
    parser.add_argument("--template",
                        help=f"改用代码仓 task-types/ 下的一个任务类型。可用的有：{'、'.join(available_templates())}")
    args = parser.parse_args(argv)
    if bool(args.source) == bool(args.template):
        parser.error("--from 与 --template 要给一个，而且只给一个。")
    source = Path(args.source) if args.source else FIXTURE_DIR / args.template
    if args.template and not source.is_dir():
        parser.error(f"没有名叫「{args.template}」的模板。可用的模板有：{'、'.join(available_templates())}。")
    path = create(Path(args.workspace), source)
    print(f"任务目录建好了：{path}")
    print("里面还没有任务数据库；执行者调用「创建任务」工具时才会建库。")
    print("接下来可以运行：python -m taskwright_server.chat " + str(path))
    return 0


if __name__ == "__main__":
    sys.exit(main())
