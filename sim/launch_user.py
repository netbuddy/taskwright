"""起用户 agent 的 pi：经 Node 驱动程序 sim/user_agent_driver.mts，用后端的会话类（backend/src/pi_session.ts 的 PiSession）
启动与驱动，拼命令行（backend/src/launch.ts）、写归档都走后端那一份；这里只把系统提示按用户画像拼好。

UserAgentProcess 把驱动程序作为子进程启动，经它的标准输入与标准输出按行交换 JSON（消息的种类见驱动程序的文件头），
对驾驭程序给出与会话类相同的四个方法：start()、get_state()、send()（逐条交出这一轮的 pi 事件）、close()。
驱动程序退出、报错，或者启动超时，都抛 UserAgentError，原因写成给人看的一句话，附上驱动程序标准错误的最后几行。

用户画像里只有自然语言部分交给扮演者：人设、目标、材料说明、隐藏事实的「事实」、接受底线的「说法」；
隐藏事实的关键词与接受底线的判据是给判定程序用的，不给扮演者看。

画像的「熟悉的材料」列出扮演者自己整理过的材料文件：启动时从材料目录读出全文，
放进系统提示，扮演者就知道材料里写了什么。材料原文只在运行时读入，写进演练目录下的系统提示副本，
不写进画像文件，也不进代码仓。「看界面」照旧不返回材料。
"""

from __future__ import annotations

import copy
import json
import os
import queue
import shutil
import subprocess
import threading
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO_ROOT = HERE.parent
DRIVER = HERE / "user_agent_driver.mts"
PROFILE = HERE / "profiles" / "user_agent.json"
PROMPT = HERE / "prompts" / "user_agent_system_prompt.md"
LABEL = "user-agent"


def load_persona(path: Path) -> dict:
    return json.loads(Path(path).read_text(encoding="utf-8"))


def familiar_materials(persona: dict, materials_dir: Path | None) -> dict[str, str]:
    """画像「熟悉的材料」里每个文件的全文，按画像里的先后。列了文件却没给材料目录、或者文件不在，直接报错。"""
    names = persona.get("熟悉的材料") or []
    if names and materials_dir is None:
        raise ValueError("用户画像列了「熟悉的材料」，要给材料目录才能把全文放进系统提示。")
    texts = {}
    for name in names:
        path = Path(materials_dir) / name
        if not path.is_file():
            raise FileNotFoundError(f"用户画像「熟悉的材料」里的 {name} 在材料目录 {materials_dir} 里找不到。")
        texts[name] = path.read_text(encoding="utf-8")
    return texts


def persona_text(persona: dict, material_texts: dict[str, str] | None = None) -> str:
    """用户画像里给扮演者读的部分，写成几段话；给了材料全文就附在「你手上的材料」下面。"""
    lines = [f"### 身份与性格\n\n{persona['人设']}", f"### 你想要什么\n\n{persona['目标']}"]
    materials = "、".join(f"《{m}》" for m in persona.get("材料") or [])
    part = f"### 你手上的材料\n\n{persona.get('材料说明', '')}材料文件：{materials}。"
    if material_texts:
        part += "\n\n下面是你熟悉的材料全文。这份材料是你自己整理的，里面写了什么你清楚。"
        for name, text in material_texts.items():
            part += f"\n\n#### 《{name}》\n\n~~~~text\n{text.rstrip()}\n~~~~"
    lines.append(part)
    facts = "\n".join(f"- {f['事实']}" for f in persona.get("隐藏事实") or [])
    lines.append(f"### 你心里知道、但助手没问到就不会主动说的事\n\n{facts}")
    lines.append("### 什么样的结果你才接受\n\n" + "\n".join(f"- {b['说法']}" for b in persona.get("接受底线") or []))
    return "\n\n".join(lines)


def system_prompt(persona: dict, materials_dir: Path | None = None) -> str:
    text = persona_text(persona, familiar_materials(persona, materials_dir))
    return PROMPT.read_text(encoding="utf-8").replace("{{用户画像}}", text)


class UserAgentError(RuntimeError):
    """模拟用户起不来、驱动程序退出或报错、启动超时。"""


class UserAgentProcess:
    """模拟用户的 pi，经 Node 驱动程序启动与驱动。接口与会话类相同：start()、get_state()、send()、close()。"""

    #: 等驱动程序报告启动完成最多等这么久（秒）：它要起 pi、等 pi 回应两条命令。
    START_TIMEOUT = 120.0
    #: 关掉时等驱动程序报告已关、再等它退出，各最多等这么久（秒）。
    CLOSE_TIMEOUT = 30.0
    #: 出错时附上驱动程序标准错误的最后几行。
    STDERR_TAIL = 20
    #: 驱动程序的入口文件。
    DRIVER = DRIVER

    def __init__(self, profile: dict, cwd: Path, runs_dir: Path, label: str = LABEL):
        self.profile = profile
        self.cwd = Path(cwd).resolve()
        self.runs_dir = Path(runs_dir).resolve()
        self.label = label
        self.process: subprocess.Popen | None = None
        #: 模拟用户原始事件流的文件名（在 runs_dir/pi-events/ 下）。
        self.archive: str | None = None
        self._messages: queue.Queue = queue.Queue()
        self._stderr: list[str] = []
        self._state: dict = {}

    def start(self, session_file: Path | None = None) -> None:
        """启动模拟用户；给了 session_file 就续接那个会话文件。"""
        node = shutil.which("node")
        if node is None:
            raise UserAgentError("在 PATH 里找不到 node，起不了模拟用户的驱动程序。")
        self.process = subprocess.Popen([node, str(self.DRIVER)], cwd=str(REPO_ROOT), env=dict(os.environ), stdin=subprocess.PIPE,
                                        stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding="utf-8", bufsize=1)
        threading.Thread(target=self._read_stdout, args=(self.process,), daemon=True).start()
        threading.Thread(target=self._read_stderr, args=(self.process,), daemon=True).start()
        self._write({"cmd": "start", "profile": self.profile, "cwd": str(self.cwd), "runs": str(self.runs_dir), "label": self.label,
                     "session_file": str(Path(session_file).resolve()) if session_file is not None else None})
        message = self._next("启动", self.START_TIMEOUT)
        if message.get("type") != "started":
            raise self._failure(message, "启动")
        self._state = {"sessionId": message.get("session_id")}
        self.archive = message.get("archive")

    def get_state(self) -> dict:
        return dict(self._state)

    def send(self, text: str):
        """唤起模拟用户，逐条交出这一轮的 pi 事件，直到这一轮结束。"""
        self._write({"cmd": "send", "text": text})
        while True:
            message = self._next("回应", None)
            if message.get("type") == "event":
                yield message.get("event") or {}
            elif message.get("type") == "turn_end":
                return
            else:
                raise self._failure(message, "回应")

    def close(self) -> None:
        process = self.process
        if process is None:
            return
        self.process = None
        try:
            process.stdin.write(json.dumps({"cmd": "close"}) + "\n")
            process.stdin.flush()
            process.stdin.close()
        except (OSError, ValueError):
            pass
        try:
            process.wait(self.CLOSE_TIMEOUT)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(self.CLOSE_TIMEOUT)

    # ───────────── 与驱动程序交换消息 ─────────────

    def _read_stdout(self, process: subprocess.Popen) -> None:
        for line in process.stdout:
            line = line.strip()
            if not line:
                continue
            try:
                self._messages.put(json.loads(line))
            except json.JSONDecodeError:
                self._messages.put({"type": "error", "stage": "output", "message": f"驱动程序在标准输出上写了一行不是 JSON 的文字：{line[:200]}"})
        self._messages.put(None)

    def _read_stderr(self, process: subprocess.Popen) -> None:
        for line in process.stderr:
            self._stderr.append(line.rstrip("\n"))
            del self._stderr[:-self.STDERR_TAIL]

    def _write(self, command: dict) -> None:
        process = self.process
        if process is None:
            raise UserAgentError("模拟用户的驱动程序没有在运行。")
        try:
            process.stdin.write(json.dumps(command, ensure_ascii=False) + "\n")
            process.stdin.flush()
        except (OSError, ValueError):
            raise UserAgentError(f"模拟用户的驱动程序已经退出了（退出码 {process.poll()}），命令发不过去。{self._stderr_tail()}") from None

    def _next(self, stage: str, timeout: float | None) -> dict:
        try:
            message = self._messages.get(timeout=timeout)
        except queue.Empty:
            process, self.process = self.process, None
            if process is not None:
                process.kill()
                process.wait(self.CLOSE_TIMEOUT)
            raise UserAgentError(f"模拟用户的驱动程序在 {timeout:g} 秒内没有报告{stage}完成，已经把它停掉。{self._stderr_tail()}") from None
        if message is None:
            process = self.process
            code = process.wait(self.CLOSE_TIMEOUT) if process is not None else None
            raise UserAgentError(f"模拟用户的驱动程序在{stage}时退出了（退出码 {code}）。{self._stderr_tail()}")
        return message

    def _failure(self, message: dict, stage: str) -> UserAgentError:
        return UserAgentError(f"模拟用户{stage}没有成功：{message.get('message') or '驱动程序没有给原因'}")

    def _stderr_tail(self) -> str:
        tail = [line for line in self._stderr if line.strip()]
        return f"它最后写到标准错误的是：{' / '.join(tail)}" if tail else ""


def user_agent_session(persona: dict, sim_dir: Path, materials_dir: Path | None = None) -> UserAgentProcess:
    """准备好用户 agent：系统提示写进演练目录，工作目录是演练目录下一个空目录。调用方负责 start()。"""
    sim_dir = Path(sim_dir)
    prompt_file = sim_dir / "user_agent_system_prompt.md"
    prompt_file.write_text(system_prompt(persona, materials_dir), encoding="utf-8")
    profile = copy.deepcopy(json.loads(PROFILE.read_text(encoding="utf-8")))
    # 后端按代码仓根目录拼这个路径（backend/src/paths.ts 的 fromRoot），绝对路径也会被接在根目录下面，所以写成相对代码仓根目录的路径。
    profile["system_prompt_file"] = os.path.relpath(prompt_file.resolve(), REPO_ROOT)
    cwd = sim_dir / "user-agent-cwd"
    cwd.mkdir(parents=True, exist_ok=True)
    return UserAgentProcess(profile, cwd, sim_dir / "user-agent", LABEL)


def load_profile() -> dict:
    return json.loads(PROFILE.read_text(encoding="utf-8"))


__all__ = ["load_persona", "familiar_materials", "persona_text", "system_prompt", "user_agent_session", "UserAgentProcess", "UserAgentError"]
