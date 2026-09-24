"""手工起一个假端点：

    python -m taskwright_server.fake_model --script 脚本.json --log 请求记录.jsonl [--port 0] [--agent-dir 目录]

--port 不写或写 0 时由操作系统挑空闲端口，启动后把端口打印出来。给了 --agent-dir 就顺手在那里写好
只认这个假端点的 pi 配置目录，之后用 PI_CODING_AGENT_DIR=<那个目录> 启动 pi 即可。按 Ctrl+C 停。
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

from taskwright_server.fake_model import FakeModel, MODEL_ARG, write_agent_dir


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="起一个按脚本回话的假模型端点。")
    parser.add_argument("--script", help="脚本文件（JSON）。不给就一律回「好的。」")
    parser.add_argument("--log", required=True, help="请求记录写到哪个 jsonl 文件")
    parser.add_argument("--port", type=int, default=0, help="端口，0 表示随机挑一个空闲端口")
    parser.add_argument("--agent-dir", help="给了就在这个目录写好只认假端点的 pi 配置")
    args = parser.parse_args(argv)
    script = json.loads(Path(args.script).read_text(encoding="utf-8")) if args.script else []
    fake = FakeModel(script, args.log).start(args.port)
    print(f"假端点已启动：{fake.base_url}（只监听本机回环地址）", flush=True)
    if args.agent_dir:
        write_agent_dir(Path(args.agent_dir), fake.base_url)
        print(f"pi 配置目录已写好：{args.agent_dir}；启动 pi 时设 PI_CODING_AGENT_DIR 为它，--model 写 {MODEL_ARG}", flush=True)
    try:
        while True:
            time.sleep(3600)
    except KeyboardInterrupt:
        fake.stop()
    return 0


if __name__ == "__main__":
    sys.exit(main())
