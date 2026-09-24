"""观测台的启动入口。

    python3 -m taskwright_observatory --runs <归档目录> --workspaces <任务目录所在目录> --port 8770

Langfuse 的服务地址与项目标识经命令行参数或环境变量给，不写在代码与配置文件里。
不给也能用，只是界面上不显示到 Langfuse 的链接。观测台不持有 Langfuse 的密钥，也不调它的接口。
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

from taskwright_observatory.server import serve

#: 环境变量名。与后端别处用的是同一批名字。
ENV_RUNS_DIR = "TASKWRIGHT_RUNS_DIR"   # 归档目录。
ENV_LANGFUSE_BASE = "LANGFUSE_BASE_URL"
ENV_LANGFUSE_PROJECT = "TASKWRIGHT_LANGFUSE_PROJECT_ID"

#: 默认端口。
DEFAULT_PORT = 8770


def parse_args(argv=None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        prog="python3 -m taskwright_observatory",
        description="只读的本地观测台：看一次会话里执行者做了什么，以及交付物怎么一步步改成现在这样。")
    parser.add_argument("--runs", action="append", default=[],
                        help=f"归档目录，下面有 pi-events 与 pi-sessions 两个子目录；可以写好几次，一起看好几个归档目录。"
                             f"不给就取环境变量 {ENV_RUNS_DIR}。"
                                                          f"界面与文档里一律叫它「归档目录」。")
    parser.add_argument("--workspaces", default="",
                        help="任务目录所在目录。它下面每个含有 task.sqlite 的子目录算一个任务目录；"
                             "直接指向一个任务目录也行。不给就取归档目录的上一级。")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT,
                        help=f"监听端口，默认 {DEFAULT_PORT}。")
    parser.add_argument("--host", default="0.0.0.0",
                        help="监听地址，默认 0.0.0.0，也就是本机的每一张网卡都能连上。")
    parser.add_argument("--langfuse-base", default=os.environ.get(ENV_LANGFUSE_BASE, ""),
                        help=f"Langfuse 的服务地址，用来拼会话页链接。不给就取环境变量 {ENV_LANGFUSE_BASE}。")
    parser.add_argument("--langfuse-project", default=os.environ.get(ENV_LANGFUSE_PROJECT, ""),
                        help=f"Langfuse 里那个项目的标识。不给就取环境变量 {ENV_LANGFUSE_PROJECT}。")
    return parser.parse_args(argv)


def main(argv=None) -> int:
    args = parse_args(argv)
    given = args.runs or ([os.environ[ENV_RUNS_DIR]] if os.environ.get(ENV_RUNS_DIR) else [])
    if not given:
        print(f"没有告诉观测台归档目录在哪。用 --runs 给一个，或者设好环境变量 {ENV_RUNS_DIR}。",
              file=sys.stderr)
        return 2
    archive_dirs = [Path(one).expanduser().resolve() for one in given]
    for archive_dir in archive_dirs:
        if not archive_dir.is_dir():
            print(f"归档目录不存在：{archive_dir}", file=sys.stderr)
            return 2
    workspaces_dir = (Path(args.workspaces).expanduser().resolve() if args.workspaces
                      else archive_dirs[0].parent)
    if not workspaces_dir.is_dir():
        print(f"任务目录所在目录不存在：{workspaces_dir}", file=sys.stderr)
        return 2
    serve(archive_dirs, workspaces_dir, args.port, args.host,
          args.langfuse_base, args.langfuse_project)
    return 0


if __name__ == "__main__":
    sys.exit(main())
