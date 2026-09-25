"""任务占用标记：一个后端服务一个任务时，在任务目录里写一份 service.lock，免得两个后端同时服务同一份任务数据。

service.lock 是一个 JSON 对象：端口（port）、进程号（pid）、启动时刻（started_at）、主机名（host）。
- 后端第一次接手一个任务（扫描任务目录时）写它，退出时删掉自己写的那些。
- 接手前发现已经有 lock：同一台主机上、进程号还活着、不是本进程，就是别的服务在用，拒绝接手（claim 返回那份 lock）；
  另一台主机写的 lock 判断不了死活，同样当作占用；进程号已经不在了的，是遗留的旧 lock，覆盖并在日志里写明。
观测台只读任务库，不看也不写这份标记。
"""

from __future__ import annotations

import json
import os
import socket
import time
from pathlib import Path

LOCK_NAME = "service.lock"


def lock_path(task_dir: Path) -> Path:
    return Path(task_dir) / LOCK_NAME


def read_lock(task_dir: Path) -> dict | None:
    """读任务目录里的占用标记；没有或读不出时为 None。"""
    try:
        value = json.loads(lock_path(task_dir).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    return value if isinstance(value, dict) else None


def pid_alive(pid: object) -> bool:
    """同一台主机上这个进程号还在不在。"""
    if not isinstance(pid, int) or pid <= 0:
        return False
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def is_ours(lock: dict | None) -> bool:
    return bool(lock) and lock.get("pid") == os.getpid() and lock.get("host") == socket.gethostname()


def occupied_by_other(lock: dict | None) -> bool:
    """这份标记说明任务正被别的服务占用：别的主机写的，或者同一台主机上别的、还活着的进程写的。"""
    if not lock or is_ours(lock):
        return False
    if lock.get("host") != socket.gethostname():
        return True
    return pid_alive(lock.get("pid"))


def claim(task_dir: Path, port: int | None) -> dict | None:
    """接手一个任务：写上本服务的占用标记。任务正被别的服务占用时不写，返回那份标记；接手成功返回 None。"""
    existing = read_lock(task_dir)
    if occupied_by_other(existing):
        return existing
    if existing and not is_ours(existing):
        print(f"任务目录 {Path(task_dir).name} 里有一份遗留的占用标记（端口 {existing.get('port')}，进程 {existing.get('pid')} 已经不在了），"
              "本服务覆盖它。", flush=True)
    mine = {"port": port, "pid": os.getpid(), "started_at": time.strftime("%Y-%m-%dT%H:%M:%S"), "host": socket.gethostname()}
    temp = lock_path(task_dir).with_name(LOCK_NAME + f".{os.getpid()}.tmp")
    temp.write_text(json.dumps(mine, ensure_ascii=False) + "\n", encoding="utf-8")
    temp.replace(lock_path(task_dir))
    return None


def release(task_dir: Path) -> None:
    """退出时删掉本服务写的占用标记；别人的不动。"""
    if is_ours(read_lock(task_dir)):
        try:
            lock_path(task_dir).unlink()
        except OSError:
            pass


def occupied_text(lock: dict) -> str:
    """给人看的一句：这个任务正被哪个服务占用。"""
    where = f"端口 {lock.get('port')} 的服务" if lock.get("port") else "另一个服务"
    host = "" if lock.get("host") == socket.gethostname() else f"（主机 {lock.get('host')}）"
    return f"这个任务正被{where}{host}占用，这里不能打开。"
