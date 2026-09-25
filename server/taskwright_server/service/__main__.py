"""启动任务服务。

用法：

    python -m taskwright_server.service --tasks <任务目录的上级目录> --runs <归档目录> --port <端口> [--profile dev]

服务绑 0.0.0.0；端口由命令行给。Langfuse 的密钥与插件位置照终端客户端的做法
经环境变量给（TASKWRIGHT_LANGFUSE_PLUGIN、TASKWRIGHT_LANGFUSE_ENV_FILE、LANGFUSE_TRACING_ENVIRONMENT）。
"""

from __future__ import annotations

import argparse
import signal
import sys
from pathlib import Path

from taskwright_server import launch
from taskwright_server.service.app import Service, serve

def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="任务服务：给前端的 HTTP 接口。")
    parser.add_argument("--tasks", required=True, help="放任务目录的上级目录；新建的任务目录建在这里")
    parser.add_argument("--runs", required=True, help="归档目录：pi 的会话文件与原始事件流按任务分开放在这里")
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--profile", default="dev")
    args = parser.parse_args(argv)
    service = Service(Path(args.tasks).expanduser(), Path(args.runs).expanduser(), launch.load_profile(args.profile), port=args.port)
    server = serve(service, args.host, args.port)
    print(f"任务服务在 http://{args.host}:{args.port}/api/v1/tasks ，任务目录 {args.tasks}，归档 {args.runs}", flush=True)
    def stop(*_):
        raise KeyboardInterrupt
    signal.signal(signal.SIGTERM, stop)     # 按进程号 kill 时也走下面的收尾：关 pi、打印事件分发统计
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        service.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
