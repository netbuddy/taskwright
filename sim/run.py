"""驾驭程序：跑一次演练。

用法（在代码仓根目录下）：

    python3 -m sim.run --persona sim/personas/librarian.json [--port 8791] [--backend <已起的后端地址>]
                           [--sim-root ./sim-runs] [--materials-dir <材料所在目录>] [--max-rounds 12] [--repeat N]
                           [--profile dev] [--user-model <服务名/模型编号>]
（--materials-dir 不给时取环境变量 TASKWRIGHT_SIM_MATERIALS_DIR，两者都没有就报错）

record.json 里另记「轮数上限」与两边的模型（「执行者模型」「用户 agent 模型」）：开头按启动配置记，结束时换成事件流里实际用的。
--profile 是自己起后端时用的启动配置（backend/profiles/ 下的名字），缺省 dev；--user-model 换掉用户 agent 的模型，缺省用
sim/profiles/user_agent.json 里写的。两样都是给不接真模型的测试用的：--profile fake --user-model fake/fake-model。

批处理：--repeat N 用同一画像接连跑 N 次，编号连续；每次都各自起后端、各自判定，
全部跑完在 <sim-root> 下写一份「批处理汇总_sim-起到止.md」，逐次列停止原因、第一层是否有效、第二层各项、
隐藏事实是否问出、被拒次数，并列出每次的记录目录供评判者读。某一次中途出错，记下原因接着跑下一次。

做的事：
1. 起后端任务服务（node backend/src/main.mts，启动配置用它的默认值 dev；或接一个已起的），建任务、上传用户画像指定的材料、新建会话；
2. 起用户 agent 的 pi（RPC），系统提示按用户画像拼好：经 Node 驱动程序 sim/user_agent_driver.mts，由后端的会话类启动；
3. 每轮用一句固定的话唤起用户 agent（第 1 轮「开始，先把你想做的事告诉助手」，之后「执行者停下了，看一下界面再回应」），
   不注入任何别的指示；用户 agent 回应之后，等执行者停下（事件流里出现新的 work_ended）；记下双方原话；
4. 停止条件：轮数上限；用户 agent 表示目标达成（done）；用户 agent 放弃（give_up）；执行者连续两轮没有经「回复」说话，
   或者执行者不可用。另有一条保险：用户 agent 连续两次被叫到都没有回应，也停。用户 agent 起不来、驱动程序退出或报错时，
   停止原因写「模拟用户不可用：原因」，记录照常写下，错误再往外抛；
   双方连续几轮没有进展也停（--stall-rounds，缺省 4，写 0 不查）：一轮里没有新的修订或图、阶段没有移动也没有新的提议、
   助手的回复不带卡片、用户 agent 也没有点卡片上的按钮，就算没有进展（made_progress）。这样停的记录里另有「没有进展而停」一项；
5. 记录写进 <sim-root>/sim-<序号>/，结束后调用 judge.py 出判定报告。record.json 里自动记下代码仓的提交号与未提交的
   改动文件（「代码版本」），以及执行者实际登记的工具清单（「执行者工具清单」），判定报告与批处理汇总都列出这两项。
两个 pi 进程都由后端的会话类启动（执行者的由任务服务启动，用户 agent 的由驱动程序启动），标准输入就是 RPC 的命令通道，
结束时关掉。Langfuse 环境标签是 sim-<序号>，两边相同。
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path

from sim import judge
from sim.launch_user import UserAgentError, load_persona, load_profile, user_agent_session

REPO_ROOT = Path(__file__).resolve().parent.parent
FIRST_WAKE = "开始，先把你想做的事告诉助手"
NEXT_WAKE = "执行者停下了，看一下界面再回应"
DEFAULT_GOAL = "基准画像下执行者能否完成整理并问清隐藏事实"
EXECUTOR_WAIT = 900.0
#: 不引出助手运行的界面操作（与 sim/lib/screen.ts 的 CONTINUE_STAGE、START_ACTIVITY 一致）：用户在提议进入下一个阶段的卡片上选了
#: 「继续本阶段」，只在会话里留一条通知；用户在任务状况卡的「开展一项活动」里选了一项，只记活动记录、在对话里留一行。
#: 做了这种操作之后不等助手，下一轮照常唤起用户 agent。在「开展一项活动」里写「不选」什么都不发，同样不等助手（route 为 none）。
SILENT_ACTIONS = ("continue_stage", "start_activity")
#: 用户画像里「开场」一项的写法：演练开始、用户 agent 说第一句话之前，驾驭程序替用户在任务状况卡的「开展一项活动」里选哪一项。
#: 不写是启动需求分析（与 0.5 的走法等价：那时新任务一建好就在需求分析里）；写「不选」是不选，任务从空闲开始；
#: 写「单独开展：活动名」是单独开展那项活动。
OPENING_KEY = "开场"
OPENING_DEFAULT = "启动需求分析"
OPENING_SKIP = "不选"
OPENING_ALONE_PREFIX = "单独开展："
#: 双方连续这么多轮没有进展就停这一遍；命令行 --stall-rounds 可以改，0 是不查。
STALL_ROUNDS = 4
#: 后端推来的事件里算作进展的几种：保存了修订、保存了图、阶段移动了（开始了另一项活动）、助手发了新的提议、任务状态变了。
#: 打开条目或图记下的已读（item_viewed、diagram_viewed）不算。
PROGRESS_EVENTS = ("deliverable_changed", "diagram_changed", "activity_started", "node_entered", "stage_proposed", "task_changed")


def expects_executor(respond: dict) -> bool:
    """用户 agent 这一次回应之后助手会不会运行：什么都没有发出去（只表示完成或放弃）、或者发的是不引出运行的界面操作时不会。"""
    if respond.get("route") == "none":
        return False
    return (respond.get("sent") or {}).get("kind") not in SILENT_ACTIONS


def opening_choice(launch: dict | None, wanted: str) -> tuple[dict | None, str]:
    """照「开场」的写法在任务状况的「开展一项活动」一节里找要选的那一项：返回（那一项，说明）；不选、找不到、现在不能选时那一项为 None。

    与 sim/lib/screen.ts 的 launchOption 同一个认法：流程的一项写按钮上的字，「启动需求分析」「继续需求分析」写到这里就认；
    单独开展的写「单独开展：活动名」。任务已经在需求分析里（那一项写着正在进行）也算不用选。"""
    name = (wanted or OPENING_DEFAULT).strip()
    if name == OPENING_SKIP:
        return None, "画像写的是不选，任务从空闲开始"
    if not launch:
        return None, "任务状况里没有「开展一项活动」这一节，没有选"
    if name.startswith(OPENING_ALONE_PREFIX):
        label = name[len(OPENING_ALONE_PREFIX):].strip()
        found = next((one for one in launch.get("activities") or [] if one.get("label") == label), None)
    else:
        found = next((one for one in launch.get("flows") or [] if one.get("label") == name or str(one.get("label", "")).startswith(name + "（")), None)
    if found is None:
        return None, f"「开展一项活动」里没有「{name}」这一项，没有选"
    if not found.get("enabled"):
        return None, f"「{name}」现在不能选（{found.get('state')}），没有选"
    return found, f"选了「{found.get('label')}」"


def open_activity(backend: "Backend", task_id: str, persona: dict) -> dict:
    """演练开场：替用户启动一个工作项（界面操作 start_activity，不替用户发话，助手不因此运行）。后端为它新建一条会话，
    返回记进演练记录的一项，其中「会话」是那条新会话的编号；没有启动（画像写了不选、那一项现在不能选）时「会话」为 None。"""
    wanted = str(persona.get(OPENING_KEY) or OPENING_DEFAULT)
    status, data = backend.call("GET", f"/tasks/{task_id}/status")
    launch = ((data or {}).get("status") or {}).get("launch") if status == 200 else None
    option, note = opening_choice(launch, wanted)
    out = {"画像写的": wanted, "说明": note, "发出": None, "会话": None}
    if option is not None:
        body = {"client_id": "sim-opening", "task_id": task_id, "kind": "start_activity", "targets": [], "notify_executor": False,
                "fields": {"activity": option["activity"], "in_flow": option["in_flow"]}}
        # 不带会话：后端新建一个工作项与一条属于它的会话，回应里带新会话的编号；演练此后就在那条会话里进行。
        status, data = backend.call("POST", f"/tasks/{task_id}/actions", body)
        if status != 200:
            raise RuntimeError(f"开场选「{option.get('label')}」没有做成：{((data or {}).get('error') or {}).get('message') or status}")
        out["发出"] = body
        out["会话"] = (data or {}).get("session_id")
    return out


def clicked_card(respond: dict | None) -> bool:
    """用户 agent 这一次回应是不是点了卡片上的按钮：走直接操作的（「这几条都看过了」「先不管」「继续本阶段」），或者发的话带着卡片的。"""
    if not respond:
        return False
    return respond.get("route") == "action" or bool((respond.get("sent") or {}).get("card"))


def made_progress(events: list[dict], respond: dict | None) -> bool:
    """这一轮有没有进展。下面四样有一样就算有：有人保存了修订或者图；阶段移动了、助手发了新的提议或者任务状态变了；
    助手的回复里有带卡片的；用户 agent 点了卡片上的按钮。events 是这一轮里后端推来的全部事件。"""
    if any(e.get("event") in PROGRESS_EVENTS for e in events):
        return True
    if any(e.get("event") == "assistant_reply" and (e.get("data") or {}).get("act") and not (e.get("data") or {}).get("degraded") for e in events):
        return True
    return clicked_card(respond)


def stall_reason(rounds: int) -> str:
    return f"双方连续 {rounds} 轮没有进展：没有新的修订、卡片、阶段移动，模拟用户也没有点卡片"


def next_sim_dir(root: Path) -> Path:
    numbers = [int(p.name[4:]) for p in root.glob("sim-*") if p.name[4:].isdigit()]
    path = root / f"sim-{(max(numbers) + 1 if numbers else 1):03d}"
    path.mkdir(parents=True)
    return path


class Backend:
    """后端任务服务的 HTTP 调用，以及一条一直读着的事件流。"""

    def __init__(self, base: str, log: Path):
        self.base = base.rstrip("/")
        self.events: list[dict] = []
        self.lock = threading.Lock()
        self.log = log

    def call(self, method: str, path: str, body=None, raw: bytes | None = None, ctype: str | None = None) -> tuple[int, dict]:
        data = raw if raw is not None else (json.dumps(body, ensure_ascii=False).encode() if body is not None else None)
        headers = {"Content-Type": ctype or "application/json"} if data is not None else {}
        request = urllib.request.Request(self.base + path, data=data, method=method, headers=headers)
        try:
            with urllib.request.urlopen(request, timeout=120) as r:
                return r.status, json.loads(r.read() or b"{}")
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read() or b"{}")

    def wait_up(self, timeout: float = 30.0) -> None:
        end = time.time() + timeout
        while time.time() < end:
            try:
                if self.call("GET", "/tasks")[0] == 200:
                    return
            except OSError:
                pass
            time.sleep(0.3)
        raise RuntimeError("后端任务服务没有起来。")

    def listen(self, task_id: str) -> None:
        def read():
            current: dict = {}
            with open(self.log, "a", encoding="utf-8") as out, urllib.request.urlopen(f"{self.base}/tasks/{task_id}/events", timeout=3600) as r:
                for raw in r:
                    line = raw.decode("utf-8").rstrip("\n")
                    out.write(line + "\n")
                    out.flush()
                    if not line:
                        if "event" in current:
                            current["_收到"] = time.time()
                            with self.lock:
                                self.events.append(current)
                        current = {}
                    elif line.startswith("event: "):
                        current["event"] = line[7:]
                    elif line.startswith("data: "):
                        current["data"] = json.loads(line[6:])
        threading.Thread(target=read, daemon=True).start()

    def since(self, mark: int) -> list[dict]:
        with self.lock:
            return list(self.events[mark:])

    def mark(self) -> int:
        with self.lock:
            return len(self.events)


def upload(backend: Backend, task_id: str, path: Path) -> str:
    boundary = uuid.uuid4().hex
    body = (f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{path.name}\"\r\n"
            f"Content-Type: text/markdown\r\n\r\n").encode() + path.read_bytes() + f"\r\n--{boundary}--\r\n".encode()
    status, data = backend.call("POST", f"/tasks/{task_id}/materials", raw=body, ctype=f"multipart/form-data; boundary={boundary}")
    if status != 200:
        raise RuntimeError(f"上传材料失败：{data}")
    return data["path"]


def user_turn(events: list[dict]) -> dict:
    """用户 agent 这一次运行里做了什么：看了几次界面（看了哪些条目，其中哪几页主题是带着确认看的；另记打开过哪几张图）、回应了什么。
    looks 每看一次界面记一项：带条目编号时是那个编号，不带编号或者带的是图的编号时是 None；图记在 diagram_looks 里。"""
    looks, confirms, diagrams, respond, rejected, text = [], [], [], None, [], ""
    for e in events:
        kind = e.get("type")
        if kind == "tool_execution_start" and e.get("toolName") == "look":
            args = e.get("args") or {}
            looks.append(args.get("item_id"))
            if args.get("item_id") and args.get("confirm") is True:
                confirms.append(args["item_id"])
            if args.get("diagram_id"):
                diagrams.append(args["diagram_id"])
        if kind == "tool_execution_end" and e.get("toolName") == "respond":
            result = e.get("result") or {}
            if e.get("isError"):
                rejected.append("".join(p.get("text", "") for p in result.get("content") or [] if isinstance(p, dict)))
            else:
                respond = result.get("details")
        if kind == "message_end" and (e.get("message") or {}).get("role") == "assistant":
            parts = (e.get("message") or {}).get("content") or []
            text = "".join(p.get("text", "") for p in parts if isinstance(p, dict) and p.get("type") == "text") or text
    return {"looks": looks, "confirms": confirms, "diagram_looks": diagrams, "respond": respond, "respond_rejected": rejected, "other_text": text.strip()}


def executor_turn(events: list[dict]) -> dict:
    replies = [e["data"] for e in events if e["event"] == "assistant_reply"]
    ended = [e["data"] for e in events if e["event"] == "work_ended"]
    states = [e["data"]["state"] for e in events if e["event"] == "executor_state"]
    return {"replies": [{"text": r.get("text"), "act": r.get("act"), "informs": r.get("informs"), "via_reply_tool": r.get("via_reply_tool"),
                         "message_id": r.get("message_id")} for r in replies],
            "work": [{"outcome": w.get("outcome"), "seconds": w.get("seconds"), "step_count": w.get("step_count")} for w in ended],
            "problems": [e["data"] for e in events if e["event"] == "problem"], "states": states}


def code_version() -> dict:
    """代码仓当前的提交号，以及几个代码目录里有没有未提交的改动（有就列出文件，演练用的是工作树而不是提交）。"""
    def git(*args: str) -> str:
        try:
            return subprocess.run(["git", *args], cwd=str(REPO_ROOT), capture_output=True, text=True, timeout=30).stdout.strip()
        except (OSError, subprocess.SubprocessError):
            return ""
    dirty = [line[3:] for line in git("status", "--porcelain", "--", "agent", "backend", "sim", "web", "task-types").splitlines() if line]
    # 还没有任何提交时 rev-parse HEAD 会原样打出「HEAD」，--verify 加 -q 则什么都不打
    return {"提交号": git("rev-parse", "-q", "--verify", "HEAD") or None, "未提交的改动": dirty}


def executor_tools(sim: Path) -> list[str] | None:
    """执行者实际登记的工具清单：后端附记里扩展经状态栏报上来的「实际工具清单」，取最后一次。"""
    tools = None
    for path in sorted((sim / "backend").glob("*/pi-events/*.backend.jsonl")):
        for line in path.read_text(encoding="utf-8").splitlines():
            try:
                e = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(e, dict) and isinstance(e.get("工具"), list) and "实际工具清单" in json.dumps(e, ensure_ascii=False):
                tools = e["工具"]
    return tools


def used_model(archive: Path) -> str | None:
    """一个归档目录下 pi 实际用的模型（服务名/模型编号）：取事件流里最后一条助手消息上写的。读不到时为空。
    后端的设置里选定了语言模型时，助手实际用的可以与启动配置里写的不同，所以演练记录以事件流里的为准。"""
    found = None
    for path in sorted(Path(archive).glob("**/pi-events/*.jsonl")):
        if path.name.endswith((".backend.jsonl", ".times.jsonl")):
            continue
        for line in path.read_text(encoding="utf-8").splitlines():
            try:
                message = (json.loads(line) or {}).get("message") or {}
            except (json.JSONDecodeError, AttributeError):
                continue
            if isinstance(message, dict) and message.get("role") == "assistant" and message.get("provider") and message.get("model"):
                found = f"{message['provider']}/{message['model']}"
    return found


def batch_summary(root: Path, sims: list[Path], errors: dict[str, str], persona_name: str) -> Path:
    """批处理汇总：每次演练一节，读各自的判定摘要.json；没有摘要的（中途出错）写出错原因。"""
    first, last = sims[0].name, sims[-1].name
    lines = [f"# 批处理汇总：{first} 到 {last}", "",
             f"用户画像 {persona_name}，一共 {len(sims)} 次。每次的完整记录在各自的目录里：判定报告.md（含每轮双方原话）、"
             "record.json、执行者事件流.txt、库副本/、user_agent_system_prompt.md；两边的 Langfuse 记录按与目录同名的环境标签筛选。", "",
             "| 演练 | 代码提交号 | 执行者工具清单 | 停止原因 | 轮数 | 演练是否有效 | 第二层通过几项 | 隐藏事实问出几条 | 用户主动补充 | 被拒次数 | 执行者读材料次数 |",
             "|---|---|---|---|---|---|---|---|---|---|---|"]
    details = []
    for sim in sims:
        path = sim / "判定摘要.json"
        if not path.is_file():
            lines.append(f"| {sim.name} | | | 出错：{errors.get(sim.name, '没有判定摘要')} | | | | | | | |")
            continue
        s = json.loads(path.read_text(encoding="utf-8"))
        second = s["第二层"]
        hidden = s.get("隐藏事实") or []
        read = s.get("执行者读材料") or {}
        record = json.loads((sim / "record.json").read_text(encoding="utf-8")) if (sim / "record.json").is_file() else {}
        version = record.get("代码版本") or {}
        commit = (version.get("提交号") or "")[:7] + ("（另有未提交的改动）" if version.get("未提交的改动") else "")
        state = s.get("有效性") or ("有效" if s["有效"] else "无效")
        if s.get("作废起始轮") and state == "部分有效":
            state += f"（第 {s['作废起始轮']} 轮起作废）"
        extra = "、".join(f"第 {v['轮']} 轮" for v in s.get("用户主动补充") or []) or "没有"
        lines.append(f"| {sim.name} | {commit or '没有记'} | {'、'.join(record.get('执行者工具清单') or []) or '没有记'} | "
                     f"{s['停止原因']} | {s['轮数']} | {state} | "
                     f"{sum(second.values())}／{len(second)} | {sum(1 for h in hidden if h['问出来了'])}／{len(hidden)} | {extra} | "
                     f"{s['被工具拒绝次数']} | {'、'.join(f'{k} 读了 {v} 次' for k, v in read.items()) or '没有材料'} |")
        details += ["", f"## {sim.name}", "", f"- 记录目录：{sim}", f"- 停止原因：{s['停止原因']}；轮数：{s['轮数']}",
                    f"- 第一层：{s.get('有效性') or ('有效' if s['有效'] else '无效')}"]
        for name, ok in s["第一层"].items():
            details.append(f"  - {'通过' if ok else '不通过'}：{name}。{s.get('第一层说明', {}).get(name, '')}")
        details.append("- 第二层：")
        for name, ok in second.items():
            details.append(f"  - {'通过' if ok else '不通过'}：{name}。{s.get('第二层说明', {}).get(name, '')}")
        details.append(f"- 来源种类（最新内容）：{s.get('来源种类')}；「助手补充」全部修订累计 {s.get('助手补充累计', s.get('执行者补充累计'))} 条")
    path = root / f"批处理汇总_{first}到{last}.md"
    path.write_text("\n".join(lines + details) + "\n", encoding="utf-8")
    return path


def profile_model(name: str) -> str | None:
    """后端的一份启动配置里写的模型（服务名/模型编号）；读不到时为空。"""
    try:
        return json.loads((REPO_ROOT / "backend" / "profiles" / f"{name}.json").read_text(encoding="utf-8")).get("model")
    except (OSError, ValueError):
        return None


def build_parser(description: str = "跑用户 agent 演练；--repeat N 接连跑 N 次并写汇总。", add_help: bool = True) -> argparse.ArgumentParser:
    """演练的命令行参数。评测的命令行（sim/evals.py）把它当底子（add_help 为假），再加自己的几项。"""
    parser = argparse.ArgumentParser(description=description, add_help=add_help)
    parser.add_argument("--persona", required=True)
    parser.add_argument("--sim-root", default=str(Path.cwd() / "sim-runs"))
    parser.add_argument("--materials-dir", default=os.environ.get("TASKWRIGHT_SIM_MATERIALS_DIR", ""),
                        help="用户画像里材料文件所在的目录；不给就取环境变量 TASKWRIGHT_SIM_MATERIALS_DIR。试验材料不入代码仓")
    parser.add_argument("--backend", default="", help="已起的后端地址，例如 http://127.0.0.1:8791/api/v1；不给就自己起一个")
    parser.add_argument("--port", type=int, default=8791, help="自己起后端时用的端口；写 0 让后端自己挑空端口（测试用）")
    parser.add_argument("--max-rounds", type=int, default=12)
    parser.add_argument("--stall-rounds", type=int, default=STALL_ROUNDS,
                        help=f"双方连续这么多轮没有进展就停这一遍（没有新的修订、卡片、阶段移动，模拟用户也没有点卡片）；缺省 {STALL_ROUNDS}，写 0 不查")
    parser.add_argument("--goal", default=DEFAULT_GOAL)
    parser.add_argument("--repeat", type=int, default=1, help="同一画像接连跑几次（编号连续），大于 1 时结束后写批处理汇总")
    parser.add_argument("--profile", default="dev", help="自己起后端时用的启动配置（backend/profiles/ 下的名字），缺省 dev")
    parser.add_argument("--user-model", default="", help="用户 agent 的模型（服务名/模型编号）；不给就用 sim/profiles/user_agent.json 里写的")
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)

    if not args.materials_dir:
        parser.error("要给 --materials-dir，或者设环境变量 TASKWRIGHT_SIM_MATERIALS_DIR，指向用户画像里材料文件所在的目录。")
    if args.repeat < 1:
        parser.error("--repeat 至少是 1。")
    persona_path = Path(args.persona).resolve()
    persona = load_persona(persona_path)
    root = Path(args.sim_root).expanduser()
    sims: list[Path] = []
    errors: dict[str, str] = {}
    for i in range(args.repeat):
        sim = next_sim_dir(root)
        sims.append(sim)
        if args.repeat > 1:
            print(f"批处理第 {i + 1} 次，共 {args.repeat} 次", flush=True)
        try:
            run_once(args, persona_path, persona, sim)
        except Exception as error:      # 一次出错不拖垮整批：记下原因，接着跑下一次
            errors[sim.name] = f"{type(error).__name__}：{error}"
            print(f"{sim.name} 出错：{errors[sim.name]}", flush=True)
            if args.repeat == 1:
                raise
    if args.repeat > 1:
        print(f"批处理汇总：{batch_summary(root, sims, errors, persona_path.name)}", flush=True)
    return 0


def listening_port(log: Path, service: subprocess.Popen, timeout: float = 30.0) -> int:
    """后端用 --port 0 自己挑端口时，从它的启动输出（backend.log）里读实际端口；这样不会有「先问到空端口再交给后端」的空当。"""
    end = time.time() + timeout
    while time.time() < end:
        found = re.search(r"任务服务在 http://[^:/]+:(\d+)/", log.read_text(encoding="utf-8", errors="replace") if log.exists() else "")
        if found:
            return int(found.group(1))
        if service.poll() is not None:
            raise RuntimeError(f"后端任务服务起来就退出了（退出码 {service.returncode}），输出见 {log}。")
        time.sleep(0.1)
    raise RuntimeError(f"后端任务服务 {timeout:.0f} 秒内没有打印监听地址，输出见 {log}。")


def run_once(args: argparse.Namespace, persona_path: Path, persona: dict, sim: Path) -> Path:
    """跑一次演练，记录写进 sim 目录，结束后判定；返回判定报告的路径。"""
    tag = sim.name
    shutil.copy2(persona_path, sim / "用户画像.json")
    (sim / "materials").mkdir()
    os.environ["LANGFUSE_TRACING_ENVIRONMENT"] = tag
    record = {"演练": tag, "演练目标": args.goal, "用户画像": persona_path.name, "Langfuse 环境标签": tag,
              "开始": time.strftime("%Y-%m-%dT%H:%M:%S"), "代码版本": code_version(), "执行者工具清单": None,
              "轮数上限": args.max_rounds, "执行者模型": None if args.backend else profile_model(args.profile),
              "用户 agent 模型": args.user_model or load_profile().get("model"), "轮": [], "停止原因": None}
    print(f"演练 {tag}，用户画像 {persona_path.name}，记录在 {sim}", flush=True)

    service = None
    base = args.backend
    if not base:
        node = shutil.which("node")
        if node is None:
            raise RuntimeError("在 PATH 里找不到 node，起不了后端任务服务。")
        # 三个目录都给，放在这一次演练的目录里：哪一个不给，后端就把它放到用户数据目录下，演练不该往那里写东西。
        service = subprocess.Popen([node, str(REPO_ROOT / "backend" / "src" / "main.mts"), "--tasks", str(sim / "tasks"),
                                    "--runs", str(sim / "backend"), "--knowledge", str(sim / "knowledge"),
                                    "--port", str(args.port), "--profile", args.profile], cwd=str(REPO_ROOT),
                                   stdout=open(sim / "backend.log", "w"), stderr=subprocess.STDOUT, env=dict(os.environ))
        port = args.port or listening_port(sim / "backend.log", service)
        base = f"http://127.0.0.1:{port}/api/v1"
    backend = Backend(base, sim / "执行者事件流.txt")
    ua = None
    try:
        backend.wait_up()
        status, created = backend.call("POST", "/tasks", {"task_type": "srs-authoring", "task_name": f"{persona['名字']}的需求整理（{tag}）"})
        task_id = created["task_id"]
        for name in persona.get("材料") or []:
            source = Path(args.materials_dir).expanduser() / name
            shutil.copy2(source, sim / "materials" / name)
            upload(backend, task_id, source)
        backend.listen(task_id)
        time.sleep(0.5)
        # 开场：替用户启动一个工作项（缺省启动需求分析），演练在后端为它新建的那条会话里进行；然后才轮到用户 agent 说第一句话。
        # 画像写了不选（或者那一项现在不能选）时没有工作项：另建一条会话，它是自由讨论的会话。
        record["开场"] = open_activity(backend, task_id, persona)
        print(f"开场：{record['开场']['说明']}", flush=True)
        executor_session = record["开场"]["会话"]
        if not executor_session:
            status, session = backend.call("POST", f"/tasks/{task_id}/sessions")
            executor_session = session["session_id"]
        record.update({"后端": base, "任务编号": task_id, "执行者会话": executor_session})

        os.environ.update({"TASKWRIGHT_SIM_BACKEND": base, "TASKWRIGHT_SIM_TASK": task_id, "TASKWRIGHT_SIM_SESSION": executor_session})
        ua = user_agent_session(persona, sim, sim / "materials", args.user_model or None)
        ua.start()
        record["用户 agent 会话"] = ua.get_state().get("sessionId")

        no_reply_rounds = 0
        silent_rounds = 0
        stalled_rounds = 0
        stall_limit = getattr(args, "stall_rounds", STALL_ROUNDS)
        for n in range(1, args.max_rounds + 1):
            wake = FIRST_WAKE if n == 1 else NEXT_WAKE
            mark = backend.mark()
            ended_before = sum(1 for e in backend.since(0) if e["event"] == "work_ended")
            started = time.time()
            user = user_turn(list(ua.send(wake)))
            turn = {"轮": n, "唤起": wake, "用户 agent": user}
            respond = user["respond"]
            print(f"第 {n} 轮：用户 agent {json.dumps(respond and respond.get('sent'), ensure_ascii=False)[:120]}", flush=True)
            if respond is None:
                silent_rounds += 1
                turn["执行者"] = None
                record["轮"].append(turn)
                if silent_rounds >= 2:
                    record["停止原因"] = "用户 agent 连续两次被叫到都没有经「回应」工具回应"
                    break
                continue
            silent_rounds = 0
            if expects_executor(respond):
                end = time.time() + EXECUTOR_WAIT
                while time.time() < end:
                    events = backend.since(mark)
                    if sum(1 for e in backend.since(0) if e["event"] == "work_ended") > ended_before:
                        break
                    if any(e["event"] == "executor_state" and e["data"]["state"] in ("exited", "failed_to_start") for e in events):
                        break
                    time.sleep(0.5)
                time.sleep(0.5)
                executor = executor_turn(backend.since(mark))
                executor["等了多少秒"] = round(time.time() - started, 1)
                turn["执行者"] = executor
                record["轮"].append(turn)
                if any(s in ("exited", "failed_to_start") for s in executor["states"]):
                    record["停止原因"] = "执行者不可用"
                    break
                if not any(r["via_reply_tool"] for r in executor["replies"]):
                    no_reply_rounds += 1
                else:
                    no_reply_rounds = 0
                if no_reply_rounds >= 2:
                    record["停止原因"] = "执行者连续两轮没有经「回复」说话"
                    break
            else:
                turn["执行者"] = None
                record["轮"].append(turn)
            if respond.get("done"):
                record["停止原因"] = "用户 agent 表示目标达成"
                break
            if respond.get("give_up"):
                record["停止原因"] = f"用户 agent 放弃：{respond.get('reason')}"
                break
            turn["有进展"] = made_progress(backend.since(mark), respond)
            stalled_rounds = 0 if turn["有进展"] else stalled_rounds + 1
            if stall_limit > 0 and stalled_rounds >= stall_limit:
                record["停止原因"] = stall_reason(stalled_rounds)
                record["没有进展而停"] = {"连续轮数": stalled_rounds, "从第几轮起": n - stalled_rounds + 1}
                break
        else:
            record["停止原因"] = f"到了轮数上限 {args.max_rounds}"
    except UserAgentError as error:
        record["停止原因"] = f"模拟用户不可用：{error}"
        raise
    finally:
        if ua is not None:
            ua.close()
        if service is not None:
            service.send_signal(signal.SIGTERM)
            try:
                service.wait(30)
            except subprocess.TimeoutExpired:
                service.kill()
        record["结束"] = time.strftime("%Y-%m-%dT%H:%M:%S")
        record["执行者工具清单"] = executor_tools(sim)
        # 两边实际用的模型以事件流里写的为准；一条助手消息都没有时留着开头按启动配置记的。
        record["执行者模型"] = used_model(sim / "backend") or record["执行者模型"]
        record["用户 agent 模型"] = used_model(sim / "user-agent") or record["用户 agent 模型"]
        (sim / "record.json").write_text(json.dumps(record, ensure_ascii=False, indent=1), encoding="utf-8")
    # 库副本：pi 与后端都已退出，三个文件一起复制。
    task_dir = sim / "tasks" / record.get("任务编号", "")
    if task_dir.is_dir():
        (sim / "库副本").mkdir(exist_ok=True)
        for f in task_dir.glob("task.sqlite*"):
            shutil.copy2(f, sim / "库副本" / f.name)
        shutil.copytree(task_dir / "docs", sim / "库副本" / "docs", dirs_exist_ok=True)
    report = judge.judge(sim)
    print(f"停止原因：{record['停止原因']}；判定报告：{report}", flush=True)
    return report


if __name__ == "__main__":
    sys.exit(main())
