"""TUI 验证程序：用 pi 自带的终端界面（TUI，交互模式）跟执行者对话，给人亲手验证各增量用。

它不是另一个对话程序。它只做三件事：检查任务目录已经由 create_task 建好；用与 RPC 模式同一份启动配置
（扩展、工具白名单、系统提示、skill、模型与思考档位、Langfuse 插件都相同，只是不写 --mode rpc）组好 pi 的
命令行；然后把终端整个交给 pi，pi 退出后打印这次会话在哪里、Langfuse 里怎样找到它。

日常开发仍以 RPC 方式操作 pi（正本第 5A 节），本程序只供人亲手验证。执行流程（读了哪个文件、调了哪个工具、
模型在想什么）由 pi 的终端界面自己画；「回复」与「保存修订」两个工具块、扩展命令 /tw-board 的看板，
由 agent 的扩展画。

用法：

    python3 -m taskwright_server.tui <任务目录> --label 名字
    python3 -m taskwright_server.tui <任务目录> --label 名字 --continue          # 续接这个名字下最近的一条会话
    python3 -m taskwright_server.tui <任务目录> --label 名字 --session <会话文件>  # 续接指定的会话文件
    python3 -m taskwright_server.tui <任务目录> --label 名字 --env-tag tui-check  # 另给 Langfuse 的环境标签

会话文件放在 $TASKWRIGHT_RUNS_DIR/pi-sessions/<名字>/，与 RPC 模式的约定相同；每次启动另在 $TASKWRIGHT_RUNS_DIR/pi-tui/
下记一份启动记录（命令行、扩展解析结果、知识仓库摘要、退出码、这次用到的会话文件）。交互模式没有 RPC 的
事件流，所以没有原始事件流归档；要看模型收发的原文，到 Langfuse 里找这条会话。
"""

from __future__ import annotations

import argparse
import json
import signal
import sqlite3
import subprocess
import sys
import time
from pathlib import Path

from taskwright_server import launch
from taskwright_observatory import taskdb


def task_row(workspace: Path) -> dict | None:
    """任务目录里那个任务的编号、名字与状态。库不在或没有任务时返回 None。"""
    path = workspace / taskdb.DB_NAME
    if not path.is_file() or path.stat().st_size == 0:
        return None
    try:
        conn = taskdb.open_readonly(path)
    except sqlite3.Error:
        return None
    try:
        row = conn.execute("SELECT task_id, task_name, status FROM task ORDER BY started_at LIMIT 1").fetchone()
    except sqlite3.Error:
        return None
    finally:
        conn.close()
    return {"task_id": row[0], "task_name": row[1], "status": row[2]} if row else None


def newest_session(session_dir: Path) -> Path | None:
    files = sorted(session_dir.glob("*.jsonl"), key=lambda p: p.stat().st_mtime)
    return files[-1] if files else None


def session_id_of(path: Path) -> str:
    """会话文件第一行是会话头，里面有会话编号。"""
    try:
        with path.open(encoding="utf-8") as handle:
            return json.loads(handle.readline()).get("id", "")
    except (OSError, json.JSONDecodeError):
        return ""


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="用 pi 的终端界面跟执行者对话，给人亲手验证用。")
    parser.add_argument("workspace", help="任务目录，必须已经由 python3 -m taskwright_server.create_task 建好")
    parser.add_argument("--label", default="tui", help="这次验证的名字，会话文件放在以它命名的目录下，默认 tui")
    parser.add_argument("--profile", default="dev", help="用哪份启动配置，默认 dev（与 RPC 模式同一份）")
    parser.add_argument("--env-tag", default="", help="Langfuse 的环境标签，不给就用启动配置里写的")
    group = parser.add_mutually_exclusive_group()
    group.add_argument("--continue", dest="resume", action="store_true", help="续接这个名字下最近的一条会话")
    group.add_argument("--session", default="", help="续接指定的会话文件")
    args = parser.parse_args(argv)

    workspace = Path(args.workspace).expanduser().resolve()
    if not workspace.is_dir():
        print(f"启动不了：任务目录 {workspace} 不存在。先用 python3 -m taskwright_server.create_task {workspace} --name 任务名 建任务。")
        return 2
    task = task_row(workspace)
    if task is None:
        print(f"启动不了：{workspace} 里还没有任务记录（没有 {taskdb.DB_NAME} 或库里没有任务）。"
              f"任务由界面创建，这里用 python3 -m taskwright_server.create_task 代替界面建任务，再启动本程序。")
        return 2

    try:
        profile = launch.load_profile(args.profile)
        runs = launch.runs_dir()
        session_dir = runs / "pi-sessions" / args.label
        session_dir.mkdir(parents=True, exist_ok=True)
        session_file: Path | None = None
        if args.session:
            session_file = Path(args.session).expanduser().resolve()
            if not session_file.is_file():
                print(f"启动不了：会话文件 {session_file} 不存在。")
                return 2
        elif args.resume:
            session_file = newest_session(session_dir)
            if session_file is None:
                print(f"启动不了：{session_dir} 里还没有会话文件可以续接，去掉 --continue 开一条新会话。")
                return 2
        command, env = launch.build_command(profile, workspace, session_dir, session_file, interactive=True)
    except launch.LaunchError as error:
        print(f"启动不了：{error}")
        return 2
    if args.env_tag:
        env[launch.ENV_TRACING_ENVIRONMENT] = args.env_tag
    environment_tag = env.get(launch.ENV_TRACING_ENVIRONMENT, "")

    record_dir = runs / "pi-tui"
    record_dir.mkdir(parents=True, exist_ok=True)
    record_path = record_dir / f"{args.label}-{time.strftime('%Y%m%d-%H%M%S')}.json"
    started = time.time()
    record = {
        "模式": "交互模式（pi 自带的终端界面）",
        **launch.startup_record(profile, command),
        "这次实际用的环境标签": environment_tag,
        "任务目录": str(workspace),
        "任务": task,
        "会话目录": str(session_dir),
        "续接的会话文件": str(session_file) if session_file else "",
        "知识仓库摘要": launch.knowledge_snapshot(workspace),
        "开始时刻": time.strftime("%Y-%m-%dT%H:%M:%S"),
    }
    # 命令行里的系统提示全文太长，启动记录里只留它来自哪个文件。
    shown = list(record["命令行"])
    if "--system-prompt" in shown:
        at = shown.index("--system-prompt") + 1
        shown[at] = f"（系统提示全文，取自 {profile.get('system_prompt_file')}）"
    record["命令行"] = shown
    record_path.write_text(json.dumps(record, ensure_ascii=False, indent=2), encoding="utf-8")

    print(f"任务 {task['task_id']}「{task['task_name'] or ''}」，状态是{task['status']}；任务目录 {workspace}")
    print(f"会话文件放在 {session_dir}" + (f"，续接 {session_file.name}" if session_file else "，这次开一条新会话"))
    print(f"Langfuse 的环境标签：{environment_tag or '（没有设）'}；启动记录写在 {record_path}")
    print("下面把终端交给 pi。在 pi 里打 /tw-board 看交付物看板，Ctrl+O 展开或折叠工具块，Ctrl+T 展开或折叠思考，"
          "Ctrl+D（输入框为空时）退出。")
    sys.stdout.flush()

    # 终端交给 pi 期间，Ctrl+C 由 pi 自己处理，本进程不因它退出。
    previous = signal.signal(signal.SIGINT, signal.SIG_IGN)
    try:
        code = subprocess.call(command, cwd=str(workspace), env=env)
    finally:
        signal.signal(signal.SIGINT, previous)

    # 这次写过的会话文件：修改时刻在启动之后的那几个（新开的、续接的、在 pi 里 /new 另起的都算）。
    used = sorted(p.name for p in session_dir.glob("*.jsonl") if p.stat().st_mtime >= started)
    settings = launch.observability_settings(profile)
    sessions = []
    for name in used:
        session_id = session_id_of(session_dir / name)
        link = (f"{settings['base_url']}/project/{settings['project_id']}/sessions/{session_id}"
                if settings["base_url"] and settings["project_id"] and session_id else "")
        sessions.append({"会话文件": str(session_dir / name), "会话编号": session_id, "Langfuse": link})
    record.update({"退出码": code, "结束时刻": time.strftime("%Y-%m-%dT%H:%M:%S"), "这次写过的会话文件": sessions})
    record_path.write_text(json.dumps(record, ensure_ascii=False, indent=2), encoding="utf-8")

    print(f"pi 已退出，退出码 {code}。" + ("" if code == 0 else "退出码不是 0，多半是扩展加载失败，看上面 pi 打的错误。"))
    for one in sessions:
        print(f"  会话文件 {one['会话文件']}")
        print(f"  会话编号 {one['会话编号']}" + (f"，Langfuse 里这条会话：{one['Langfuse']}" if one["Langfuse"] else ""))
    if not sessions:
        print("  这次没有写出会话文件（pi 在第一条助手消息之前不写会话文件）。")
    return code


if __name__ == "__main__":
    sys.exit(main())
