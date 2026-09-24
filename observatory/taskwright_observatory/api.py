"""读取接口：把归档目录与任务目录里读到的事实，拼成界面要用的几份数据。

这一层只做拼接与关联，不做推断。所有判断口径都写在字段名或说明文字里，
界面照着显示就行，不再自己算一遍。

层次与命名跟着 pi 走：会话 session → 一次运行 agent run（由一次提示 prompt 触发）→ 轮 turn →
模型请求 provider request → 工具调用 tool call。不属于 pi 的概念另外标明来源：
任务、修订、里程碑是领域概念（来自 task.sqlite），「一次 pi 进程启动」是后端概念（来自后端归档）。

接口是按「以后产品前端也能直接用」来设计的，返回里都带着来源信息（归档文件名与行号、
事件序号、调用编号、会话文件里的条目编号），好让人一路追回原始记录。
"""

from __future__ import annotations

import os
from pathlib import Path

from taskwright_observatory import taskdb
from taskwright_observatory import concepts
from taskwright_observatory import health as health_module
from taskwright_observatory import runs, workspaces as workspaces_module
from taskwright_observatory.langfuse import LangfuseLinks
from taskwright_observatory.labels import load_tool_names
from taskwright_observatory.revisions import describe_operation, project_revisions
from taskwright_observatory.shared import local_clock, local_time, shorten_home


class NotFound(Exception):
    """请求的东西不存在。服务层据此回 404。"""


def task_key(workspace_name: str, task_id: str) -> str:
    """任务在观测台里的键。任务标识只在一个任务目录内唯一，所以要把任务目录名带上。"""
    return f"{workspace_name}/{task_id}"


class Index:
    """一次读取：把归档目录与任务目录都扫一遍，建好互相对照要用的几张表。"""

    def __init__(self, archive_dir: Path | list[Path], workspaces_dir: Path,
                 langfuse_base: str = "", langfuse_project: str = "",
                 links: LangfuseLinks | None = None):
        # 归档目录可以给一个，也可以给好几个（例如同一台机器上几次试跑的归档一起看），会话按开始时刻合在一起排。
        dirs = archive_dir if isinstance(archive_dir, (list, tuple)) else [archive_dir]
        self.archive_dirs = [Path(d) for d in dirs]
        self.archive_dir = self.archive_dirs[0]
        self.workspaces_dir = Path(workspaces_dir)
        # 链接对象由服务层建一次传进来，好让它内存里那份缓存不随本对象重建而丢。
        self.links = links or LangfuseLinks(langfuse_base, langfuse_project)
        self.tool_names = load_tool_names()

        self.sessions = sorted((s for d in self.archive_dirs for s in runs.build_sessions(d)),
                               key=lambda s: (s["开始时刻"] or 0.0))
        self.workspaces = workspaces_module.scan_workspaces(self.workspaces_dir)
        self.workspace_names = {w["任务目录"] for w in self.workspaces}
        self.events_by_call = workspaces_module.index_by_call_id(self.workspaces)
        self.model_calls_by_call = workspaces_module.model_calls_by_tool_call(self.workspaces)

        # 不同任务目录里的任务可能重名（它们是同一个任务定义的不同实例），所以这里的键是
        # 「任务目录名/任务标识」，不是任务标识本身。界面上的链接用的也是这个合起来的键。
        self.tasks: dict[str, dict] = {}
        self.projections: dict[str, dict] = {}
        self.task_workspace: dict[str, str] = {}
        for workspace in self.workspaces:
            for task in workspace["任务"]:
                key = task_key(workspace["任务目录"], task["任务标识"])
                self.tasks[key] = task
                self.projections[key] = project_revisions(task)
                self.task_workspace[key] = workspace["任务目录"]

        #: （任务目录名, 调用编号）→ 这次调用产生的那一次修订。调用编号只在一个任务目录里查，不跨库。
        self.revision_by_call: dict[tuple[str, str], dict] = {}
        for key, projection in self.projections.items():
            for revision in projection["修订"]:
                self.revision_by_call[(self.task_workspace[key], revision["调用编号"])] = {
                    "任务的键": key,
                    "任务标识": self.tasks[key]["任务标识"],
                    "任务目录": self.task_workspace[key],
                    "修订序号": revision["修订序号"],
                    "修订总数": projection["修订次数"]}

        #: （任务目录名, 调用编号）→ 它出现在哪条会话的第几次运行、第几轮里。
        self.call_place: dict[tuple[str, str], dict] = {}
        for session in self.sessions:
            ws = self.workspace_name_of(session)
            for one in session["运行"]:
                for turn in one["轮"]:
                    for call in turn["工具调用"]:
                        if call["调用编号"]:
                            self.call_place[(ws, call["调用编号"])] = {
                                "会话编号": session["会话编号"],
                                "运行序号": one["运行序号"],
                                "轮号": turn["轮号"],
                                "归档文件": turn["归档文件"],
                            }

    # ───────────── Langfuse 链接 ─────────────

    def langfuse_session_url(self, session_id: str) -> str:
        """拼一条到 Langfuse 会话页的链接。缺地址或项目标识时返回空串，界面就不显示链接。"""
        return self.links.session_url(session_id)

    def langfuse_sessions_url(self) -> str:
        return self.links.sessions_url()

    # ───────────── 会话与任务的对应 ─────────────

    def workspace_name_of(self, session: dict) -> str:
        """这条会话在哪个任务目录里跑：会话文件头上记的工作目录的目录名。

        会话文件缺失时没有工作目录可取，退而拿归档目录名对任务目录名（见 by_archive_dir_name）；两样都对不上是空串。
        """
        cwd = session.get("工作目录") or ""
        return Path(cwd).name if cwd else self.by_archive_dir_name(session)

    def by_archive_dir_name(self, session: dict) -> str:
        """会话文件缺失时的后备：归档按任务分目录存放（runs/<任务目录名>/pi-events/…），归档目录名与某个任务目录同名，
        就算这条会话在那个任务目录里跑。会话文件在、或者 pi 没有启动起来的，不走这条路。对不上返回空串。"""
        if session.get("启动失败") or session.get("会话文件"):
            return ""
        name = session.get("归档目录名") or ""
        return name if name in self.workspace_names else ""

    def events_of_call(self, workspace: str, call_id: str) -> list[dict]:
        """这次调用在库里写下的事件，只在这条会话所在的任务目录里找，不跨库。

        调用编号只在一个任务目录的库里有意义；跨库找会把不同任务里碰巧相同的编号对上（例如假模型端点
        自动生成的编号）。会话没有记工作目录时说不出它在哪个任务目录，一律当作找不到。
        """
        if not workspace or not call_id:
            return []
        return [e for e in self.events_by_call.get(call_id, []) if e["任务目录"] == workspace]

    def model_calls_of_call(self, workspace: str, call_id: str) -> list[dict]:
        """这次工具调用在工具里直接发起的模型调用，同样只在会话所在的任务目录里找。"""
        if not workspace or not call_id:
            return []
        return [c for c in self.model_calls_by_call.get(call_id, []) if c.get("任务目录") == workspace]

    def tasks_of_session(self, session: dict) -> list[dict]:
        """这条会话属于哪个任务。

        一库一任务（新格式的库）：会话在哪个任务目录里跑，就属于那个目录里的那个任务，不看它有没有写过库——
        任务由用户在界面上创建，执行者只聊天、只读文件的会话也属于这个任务。旧格式的库一库可以有好几个任务，
        仍按这条会话的工具调用编号在这个任务目录的库里写下的事件来对。
        """
        ws = self.workspace_name_of(session)
        how = "按归档目录名对上" if ws and not session.get("工作目录") else "会话所在的任务目录"
        found: dict[str, dict] = {}
        for key, name in self.task_workspace.items():
            if name == ws and self.tasks[key].get("格式") == taskdb.FORMAT_CURRENT:
                task = self.tasks[key]
                found[key] = {"任务的键": key, "任务标识": task["任务标识"], "任务类型": task["任务类型"],
                              "任务名": (task.get("新库") or {}).get("任务名") or task["任务类型"],
                              "任务目录": ws, "本会话写下的修订": [], "怎么对上的": how}
        for one in session["运行"]:
            for turn in one["轮"]:
                for call in turn["工具调用"]:
                    for event in self.events_of_call(ws, call["调用编号"]):
                        key = task_key(event["任务目录"], event["任务标识"])
                        entry = found.setdefault(key, {
                            "任务的键": key,
                            "任务标识": event["任务标识"],
                            "任务类型": event["任务类型"],
                            "任务名": event["任务类型"],
                            "任务目录": event["任务目录"],
                            "本会话写下的修订": [],
                            "怎么对上的": "调用编号" + ("（任务目录按归档目录名对上）" if how == "按归档目录名对上" else ""),
                        })
                        mark = self.revision_by_call.get((ws, call["调用编号"]))
                        if mark and mark["修订序号"] not in entry["本会话写下的修订"]:
                            entry["本会话写下的修订"].append(mark["修订序号"])
        for key, entry in found.items():
            task = self.tasks.get(key, {})
            projection = self.projections.get(key, {})
            entry["状态"] = task.get("状态", "")
            entry["修订总数"] = projection.get("修订次数", 0)
            entry["本会话写下的修订"].sort()
        return list(found.values())

    def workspace_of_session(self, session: dict) -> dict:
        """这条会话在哪个任务目录里跑的，那个任务目录现在的库是什么状态。

        工作目录取自 pi 会话文件头上记的 cwd。任务目录里没有库文件时说明那里还没有任务记录
        （现在任务由用户在界面上创建；更早的库由执行者调用「创建任务」工具建）。
        """
        cwd = session.get("工作目录") or ""
        by_name = "" if cwd else self.by_archive_dir_name(session)
        if by_name:
            cwd = os.path.expanduser(next(w["任务目录路径"] for w in self.workspaces if w["任务目录"] == by_name))
        if not cwd:
            return {"任务目录": "", "任务目录路径": "", "库的格式": "", "说明": "会话文件里没有记工作目录，所以说不出它在哪个任务目录。"}
        path = Path(cwd)
        fmt = taskdb.format_of_workspace(path) if path.is_dir() else ""
        note = ""
        if not path.is_dir():
            note = "这个任务目录现在已经不在了。"
        elif fmt in (taskdb.FORMAT_MISSING, taskdb.FORMAT_EMPTY):
            note = taskdb.NO_TASK_YET + "：这个任务目录里没有任务数据库，还没有任务记录。"
        if by_name:
            note = ("这条会话的会话文件不在归档里，取不到工作目录；归档目录名与任务目录同名，所以按归档目录名对上。" + note)
        return {"任务目录": path.name, "任务目录路径": shorten_home(cwd), "库的格式": fmt, "说明": note,
                "怎么对上的": "按归档目录名对上" if by_name else "会话文件里记的工作目录",
                "交付物页的键": f"{path.name}/" if fmt in (taskdb.FORMAT_MISSING, taskdb.FORMAT_EMPTY) else ""}

    def changes_of_call(self, call: dict, workspace: str) -> list[dict]:
        """这次工具调用带来了什么变化，按实际写下的内容用领域名字分类。

        「创建任务」写下的叫「任务的变化」，「保存修订」写下的叫「交付物的变化」。被拒绝的「保存修订」
        把模型想做的每个操作列出来，标明没有写入。什么都没有写下时返回空列表，界面据此写
        「这次调用没有改动交付物，也没有留下其他记录」。
        """
        changes: list[dict] = []
        for event in self.events_of_call(workspace, call["调用编号"]):
            key = task_key(event["任务目录"], event["任务标识"])
            task = self.tasks.get(key, {})
            if task.get("格式") != taskdb.FORMAT_CURRENT:
                continue
            content = event.get("内容") or {}
            if event["事件名"] == "TASK_CREATED":
                changes.append({
                    "种类": "任务的变化",
                    "任务的键": key,
                    "任务编号": event["任务标识"],
                    "任务名": content.get("task_name", ""),
                    "任务定义文件": content.get("definition_path", ""),
                    "集合": content.get("collections", []),
                    "说明": "创建了一个任务，状态是进行中。",
                    "事件序号": event["事件序号"],
                })
            elif event["事件名"] == "REVISION_SAVED":
                new_task = task["新库"]
                changes.append({
                    "种类": "交付物的变化",
                    "任务的键": key,
                    "任务编号": event["任务标识"],
                    "修订序号": content.get("revision_no"),
                    "变化": [describe_operation(new_task, op) for op in content.get("operations") or []],
                    "事件序号": event["事件序号"],
                })
            elif event["事件名"] in ("CONFIRMATION_RECORDED", "ITEM_VIEWED"):
                judgement = next((j for j in task["新库"].get("判读", []) if j["事件序号"] == event["事件序号"]), None)
                basis_kind = content.get("basis")
                accepted = all(one.get("accepted", True) for one in content.get("items") or [])
                changes.append({
                    "种类": "确认的登记",
                    "任务的键": key,
                    "任务编号": event["任务标识"],
                    "说明": ("用户打开条目详情看过了（或在卡片上点了「这几条都看过了」），记为已读，已读就算确认。" if basis_kind == "viewed"
                             else "用户在界面上改了这个条目，改出来的内容随修订自动算作确认。" if basis_kind == "ui_edit"
                             else "早期版本由模型读用户原话登记的确认，依据是摘出的原话。" if basis_kind == "user_words"
                             else "用户在界面上点了确认。" if accepted
                             else "用户在界面上撤回了确认；已读是条目级、单向的，看过的条目仍算看过。"),
                    "依据种类": {"viewed": "已读", "user_words": "对话里的话", "ui_edit": "界面修改"}.get(basis_kind, "界面点击"),
                    "判读序号": judgement["判读序号"] if judgement else None,
                    "明细": judgement["明细"] if judgement else content.get("items", []),
                    "依据": judgement["依据"] if judgement else None,
                    "事件序号": event["事件序号"],
                })
            elif event["事件名"] == "TASK_COMPLETED":
                waived = content.get("waived") or []
                changes.append({
                    "种类": "任务的完成",
                    "任务的键": key,
                    "任务编号": event["任务标识"],
                    "任务名": task["新库"].get("任务名", ""),
                    "说明": f"任务的状态从「{content.get('status_before')}」变为「{content.get('status_after')}」。"
                            + (f"下面这些完成条件是按开发期开关当作已满足的：{'、'.join(waived)}。" if waived else ""),
                    "事件序号": event["事件序号"],
                })
        model_calls = self.model_calls_of_call(workspace, call["调用编号"])
        if model_calls:
            changes.append({
                "种类": "工具里的模型调用",
                "说明": (f"这次工具调用在工具里直接发起了 {len(model_calls)} 次模型调用。这些调用不经过 pi 的运行循环，"
                         "Langfuse 里看不到，提示全文与原始输出都在库里的 model_call 表。"),
                "调用": model_calls,
            })
        if not changes and call.get("是否被拒") is True and call.get("工具") == "save_revision":
            operations = (call.get("参数") or {}).get("operations")
            changes.append({
                "种类": "被拒绝的保存修订",
                "说明": "工具拒绝了这次调用，下面这些操作一个都没有写入。",
                "想做的操作": operations if isinstance(operations, list) else [],
                "参数原样": call.get("参数") or {},
            })
        return changes

    def unmatched_calls_note(self, session: dict) -> str:
        """这条会话调过工具、但库里找不到对应事件时，给一句如实的说明。

        这不是缺陷，常见的原因是那个任务目录后来被重建过：库重建了，会话记录还留着。
        """
        if self.tasks_of_session(session):
            return ""
        ws = self.workspace_name_of(session)
        if not ws:
            if not session.get("会话文件"):
                return ("这条会话的会话文件不在归档里，取不到工作目录；归档目录名也对不上任何一个任务目录，"
                        "所以说不出它在哪个任务目录里跑，对不上任务。")
            return "会话文件里没有记工作目录，说不出它在哪个任务目录里跑，所以对不上任务。"
        if ws not in {w["任务目录"] for w in self.workspaces}:
            return f"这条会话的任务目录 {ws} 不在当前扫到的目录里，所以对不上任务。"
        return f"任务目录 {ws} 里还没有任务记录。"

    # ───────────── 各个读取接口 ─────────────

    def archive_dirs_text(self) -> str:
        """归档目录给人读的写法。好几个归档目录都在同一个目录下面时（例如 --runs ./runs 收进来的），只写一次上一级。"""
        parents = {d.parent for d in self.archive_dirs}
        if len(self.archive_dirs) > 1 and len(parents) == 1:
            return (f"{shorten_home(str(next(iter(parents))))} 下面的 {len(self.archive_dirs)} 个归档目录"
                    f"（{'、'.join(d.name for d in self.archive_dirs)}）")
        return "、".join(str(d) for d in self.archive_dirs)

    def overview(self) -> dict:
        real = [s for s in self.sessions if not s["启动失败"]]
        return {
            "归档目录": self.archive_dirs_text(),
            "任务目录所在目录": str(self.workspaces_dir),
            "会话数": len(real),
            "启动失败次数": len(self.sessions) - len(real),
            "任务目录数": len(self.workspaces),
            "任务数": len(self.tasks),
            "工具中文名": self.tool_names,
            "Langfuse 全部会话": self.langfuse_sessions_url(),
            "有没有配 Langfuse": self.links.can_link,
            "Langfuse 状态": self.links.status(),
        }

    def session_list(self) -> dict:
        """会话列表。每行带任务名与会话名，页面按它们找会话；任务名取自对上的第一个任务。"""
        rows = []
        for session in self.sessions:
            tasks = self.tasks_of_session(session)
            rows.append({
                "会话编号": session["会话编号"],
                "会话名": session.get("会话名", ""),
                "任务名": tasks[0]["任务名"] if tasks else "",
                "任务编号": tasks[0]["任务标识"] if tasks else "",
                "任务怎么对上的": tasks[0]["怎么对上的"] if tasks else "",
                "归档名": "、".join(session["归档名"]),
                "开始时刻": local_time(session["开始时刻"]),
                # 给页面排序用的原始秒数，显示仍用上面那一项。
                "开始秒": session["开始时刻"] or 0,
                "结束时刻": local_clock(session["结束时刻"]),
                "运行次数": session["运行次数"],
                "轮数": session["轮数"],
                "模型请求次数": session["模型请求次数"],
                "工具调用次数": session["工具调用次数"],
                "被拒次数": session["被拒次数"],
                "是否重启过": session["是否重启过"],
                "pi 进程启动次数": session["pi 进程启动次数"],
                "终态": session["终态"],
                "启动失败": session["启动失败"],
                "启动失败原因": session.get("启动失败原因", ""),
                "归档文件": [l["归档文件"] for l in session["启动"]],
                "提取出的任务": tasks,
                "任务对不上的说明": self.unmatched_calls_note(session),
                "所在任务目录": self.workspace_of_session(session),
                "Langfuse 链接": self.langfuse_session_url(session["会话编号"]),
            })
        return {"会话": rows}

    def _session_or_404(self, session_id: str) -> dict:
        for session in self.sessions:
            if session["会话编号"] == session_id:
                return session
            if not session["会话编号"] and session.get("归档文件") == session_id:
                return session
        raise NotFound(f"找不到会话「{session_id}」。")

    @staticmethod
    def mark_corrections(runs_of_session: list[dict]) -> None:
        """给每一次被拒的调用标上「后来在哪一步改过来了」。

        算法：这次被拒之后，同一条会话里再出现的下一次同名工具调用，就是它的改正那一步。
        那一次成功了就算改正成功，仍然被拒就算没改过来，后面再没有同名调用就算没有再试。
        范围是整条会话，不是一次运行——模型被拒之后常常先回头问一句，改正落在下一次运行里。
        """
        flat = [(one, turn, call)
                for one in runs_of_session for turn in one["轮"] for call in turn["工具调用"]]
        for index, (one, turn, call) in enumerate(flat):
            if call["是否被拒"] is not True:
                call["改正"] = None
                continue
            later = [x for x in flat[index + 1:] if x[2]["工具"] == call["工具"]]
            if not later:
                call["改正"] = {"有没有再试": False}
                continue
            next_run, next_turn, next_call = later[0]
            call["改正"] = {
                "有没有再试": True,
                "改正成功": next_call["是否被拒"] is False,
                "运行序号": next_run["运行序号"],
                "轮号": next_turn["轮号"],
                "是不是同一次运行": next_run["运行序号"] == one["运行序号"],
            }

    def session_detail(self, session_id: str) -> dict:
        session = self._session_or_404(session_id)
        ws = self.workspace_name_of(session)
        self.mark_corrections(session["运行"])
        shown_runs = []
        for one in session["运行"]:
            turns = []
            milestones = []
            trace_id = one.get("Langfuse 运行记录编号", "")
            # 第二级链接要向 Langfuse 读一次。读不到就是空的那一份，下面自然退回第一级。
            steps = self.links.steps_of(trace_id) if trace_id else {
                "取到了吗": False, "工具调用": {}, "模型请求": {}, "模型请求消息条数": {},
                "说明": "这次运行没有带出 Langfuse 运行记录编号，所以连第一级链接也拼不出来。"}
            # 一次运行里第几次模型请求，从 0 起数，跨轮接着数。Langfuse 那条生成记录的
            # metadata.assistant_index 数的是同一件事，所以两边按这个序号对上。
            request_index = 0
            for turn in one["轮"]:
                calls = []
                for call in turn["工具调用"]:
                    written = self.events_of_call(ws, call["调用编号"])
                    mark = self.revision_by_call.get((ws, call["调用编号"]))
                    calls.append({
                        **call,
                        "工具中文名": self.tool_names.get(call["工具"], ""),
                        "库里写下的事件": [{
                            "任务目录": e["任务目录"],
                            "任务标识": e["任务标识"],
                            "事件序号": e["事件序号"],
                            "事件名": e["事件名"],
                            "来源": e["来源"],
                            "发起方": e["发起方"],
                            "内容": e["内容"],
                            "时刻": local_time(e["时刻"]),
                        } for e in written],
                        "产生的修订": mark,
                        "带来的变化": self.changes_of_call(call, ws),
                        "Langfuse 直达链接": steps["工具调用"].get(call["调用编号"], ""),
                    })
                    if mark:
                        milestones.append({
                            "名目": "形成修订 %d" % mark["修订序号"],
                            "任务标识": mark["任务标识"],
                            "任务的键": mark["任务的键"],
                            "修订序号": mark["修订序号"],
                            "挂在哪一轮后面": turn["轮号"],
                            "调用编号": call["调用编号"],
                            # 时间条上这面小旗插在哪里：这次调用结束那一行的收到时刻。
                            "收到时刻": call["结束收到时刻"],
                        })
                shown_requests = []
                for one_request in turn["模型请求"]:
                    counted = one_request["带的消息（观测台数出来的）"]
                    from_langfuse = steps.get("模型请求消息条数", {}).get(request_index)
                    shown_requests.append({
                        **one_request,
                        "助手消息时刻文字": local_time(one_request["助手消息时刻"]),
                        "这次运行里的第几次模型请求": request_index + 1,
                        "带的消息": {
                            "观测台数出来的": counted,
                            "取自 Langfuse 的": from_langfuse,
                            "两个数一样吗": (from_langfuse is None or from_langfuse == counted),
                            "观测台是怎么数的": "从事件流里数出来的对话消息条数，不含系统提示。",
                            "Langfuse 是怎么数的": "那条生成记录输入里的对话消息条数，"
                                                   "不含系统提示。",
                        },
                        "Langfuse 直达链接": steps["模型请求"].get(request_index, ""),
                    })
                    request_index += 1
                turns.append({
                    "轮号": turn["轮号"],
                    "pi 给的轮号": turn["pi 给的轮号"],
                    "自数轮号": turn["自数轮号"],
                    "轮号是谁给的": turn["轮号是谁给的"],
                    "新一段低层运行的原因": turn.get("新一段低层运行的原因"),
                    "给人读的序数": turn["给人读的序数"],
                    "运行序号": turn["运行序号"],
                    "助手文字": turn["助手文字"],
                    "Langfuse 运行记录链接": self.links.trace_url(trace_id),
                    "这一轮是这条运行记录里的第几个生成记录": turn["自数轮号"] + 1,
                    "模型请求": shown_requests,
                    "工具调用": calls,
                    "工具调用是不是并行的": turn["工具调用是不是并行的"],
                    "工具结果消息": turn["工具结果消息"],
                    "耗时秒": turn["耗时秒"],
                    "开始收到时刻": turn["开始收到时刻"],
                    "结束收到时刻": turn["结束收到时刻"],
                    "开始时刻文字": local_clock(turn["开始收到时刻"]),
                    "归档文件": turn["归档文件"],
                    "开始行号": turn["开始行号"],
                    "结束行号": turn["结束行号"],
                })
            shown_runs.append({
                "运行序号": one["运行序号"],
                "启动序号": one["启动序号"],
                "时间条": self.timeline_of(one),
                "低层运行段": one.get("低层运行段", []),
                "停止原因": one.get("停止原因", ""),
                "归档文件": one["归档文件"],
                "Langfuse 运行记录编号": trace_id,
                "Langfuse 运行记录链接": self.links.trace_url(trace_id),
                "各轮报来的运行记录编号一致吗": one.get("各轮报来的运行记录编号一致吗", True),
                "第二级链接": {"取到了吗": steps["取到了吗"], "说明": steps["说明"]},
                "提示": {**one["提示"], "时刻文字": local_time(one["提示"]["时刻"])},
                "用户消息": [{**m, "时刻文字": local_time(m["时刻"])} for m in one["用户消息"]],
                "轮": turns,
                "里程碑": milestones,
                "界面请求": one["界面请求"],
                "被中止": one["被中止"],
                "这次运行没有正常收尾": one.get("这次运行没有正常收尾", False),
                "自动重试": one["自动重试"],
                "压缩": one["压缩"],
                "排队变化": one["排队变化"],
                "助手最后说的话": one["助手最后说的话"],
                "助手最后说的话从哪来": one.get("助手最后说的话从哪来", ""),
                "助手最后一条消息的条目编号": one["助手最后一条消息的条目编号"],
                "耗时秒": one["耗时秒"],
            })
        return {
            "会话编号": session["会话编号"],
            "会话名": session.get("会话名", ""),
            "归档名": "、".join(session["归档名"]),
            "开始时刻": local_time(session["开始时刻"]),
            "结束时刻": local_time(session["结束时刻"]),
            "运行次数": session["运行次数"],
            "轮数": session["轮数"],
            "模型请求次数": session["模型请求次数"],
            "工具调用次数": session["工具调用次数"],
            "被拒次数": session["被拒次数"],
            "是否重启过": session["是否重启过"],
            "pi 进程启动次数": session["pi 进程启动次数"],
            "终态": session["终态"],
            "启动失败": session["启动失败"],
            "启动失败原因": session.get("启动失败原因", ""),
            "会话文件": session["会话文件"],
            "会话文件条目数": session["会话文件条目数"],
            "扩展写入的消息": [{**m, "时刻": local_time(m["时刻"]), "时刻秒": m["时刻"]}
                               for m in session.get("扩展写入的消息", [])],
            "启动": [{
                "归档文件": l["归档文件"],
                "启动时刻": local_time(l["启动时刻"]),
                "事件行数": l["事件行数"],
                "有没有收到时刻": l["有没有收到时刻"],
                "读不懂的行数": len(l["读不懂的行"]),
                "会话文件": l["会话文件"],
                "有没有后端补记": l["后端补记"]["有没有"],
                "后端补记启动": l["后端补记"]["启动"],
                "后端补记退出": l["后端补记"]["退出"],
                "实际工具清单": l["后端补记"]["实际工具清单"],
                "后端补记标准错误": l["后端补记"]["标准错误"],
                "后端补记界面请求应答": l["后端补记"]["界面请求应答"],
                "知识仓库摘要": l["后端补记"].get("知识仓库摘要"),
                "上下文文件": l["后端补记"].get("上下文文件"),
                "已加载的 skill": l["后端补记"].get("已加载的 skill"),
                "未归到任何一次运行的界面请求": l.get("未归到任何一次运行的界面请求", []),
            } for l in session["启动"]],
            "运行": shown_runs,
            "提取出的任务": self.tasks_of_session(session),
            "任务对不上的说明": self.unmatched_calls_note(session),
            "所在任务目录": self.workspace_of_session(session),
            "Langfuse 链接": self.langfuse_session_url(session["会话编号"]),
            "Langfuse 状态": self.links.status(),
            "在 Langfuse 里应当看到的条数": {
                "运行记录": session["运行次数"],
                "生成记录": session["模型请求次数"],
                "工具记录": session["工具调用次数"],
                "说明": "Langfuse 的「Pi Turn」是一条运行记录（trace），对应 pi 的一次运行；"
                        "「LLM Call」是一条生成记录（generation），对应 pi 的一次模型请求；"
                        "「Tool: 某工具」是一条工具记录，对应 pi 的一次工具调用。"
                        "观测台按事件流数出来的三个数就写在上面，点链接过去数一数，"
                        "对得上就说明两边记的是同一条会话。",
            },
            "任务是谁立的": self.who_created_note(session),
        }

    def who_created_note(self, session: dict) -> str:
        """这条会话对上的任务是谁建的，按库里创建任务那条记录的发起方与编号如实说。"""
        found = self.tasks_of_session(session)
        formats = {self.tasks.get(t["任务的键"], {}).get("格式") for t in found}
        if taskdb.FORMAT_LEGACY in formats:
            return ("库里这个任务的头几条事件，发起方写的是「驱动程序」、来源写的是 "
                    "tod.task.start，也就是任务由测试夹具用旧命令预先建好，不是助手立项的。")
        for t in found:
            new = self.tasks.get(t["任务的键"], {}).get("新库") or {}
            call_id = new.get("创建它的调用编号") or ""
            if call_id.startswith("ui-"):
                return (f"任务由用户在界面上创建（后端经创建任务的命令行入口写下任务记录，发起方是用户，"
                        f"操作编号 {call_id}），助手没有创建任务的工具。")
            if new:
                return "任务由助手调用「创建任务」工具创建（早期的做法），库也是那一次调用建的。"
        return ""

    @staticmethod
    def timeline_of(one: dict) -> dict:
        """这次运行的时间条能不能画，横轴从哪到哪。

        横轴一律用后端收到事件的时刻：`agent_start` 那一行到 `agent_settled` 那一行。
        任务数据库里事件的时刻、pi 消息自带的时间戳、Langfuse 记的时刻都来自别的时钟，
        不参与定位，只在文字里显示并注明是谁记的。收到时刻缺了就不画，也不拿别的时钟顶替。
        """
        start, end = one.get("开始收到时刻"), one.get("结束收到时刻")
        if not one.get("有没有收到时刻索引", False):
            return {"能不能画": False, "起": None, "止": None,
                    "画不出的原因": "这次运行所在的归档旁边没有收到时刻索引文件"
                                    "（与归档同名的 .times.jsonl），所以每一行是什么时候收到的"
                                    "无从知道，时间条画不出来。这条归档跑在后端记收到时刻这件事"
                                    "做出来之前。下面的步骤流照常显示。"}
        if start is None or end is None:
            return {"能不能画": False, "起": start, "止": end,
                    "画不出的原因": "这次运行的开头或收尾那一行在收到时刻索引里查不到，"
                                    "所以横轴的起止定不下来，时间条画不出来。"
                                    "观测台不拿别的时钟顶替。下面的步骤流照常显示。"}
        return {"能不能画": True, "起": start, "止": end, "画不出的原因": "",
                "横轴是什么": "横轴是真实时间，位置与长度一律按后端收到这条事件的时刻算"
                              "（归档旁边的 .times.jsonl，与事件流逐行对应）。"}

    def task_detail(self, key: str) -> dict:
        workspace_name, _, task_id = key.partition("/")
        if not task_id:
            # 只给了任务目录名：这个任务目录还没有创建任务时，交付物页照实这样说。
            for workspace in self.workspaces:
                if workspace["任务目录"] == workspace_name:
                    return {"格式": workspace.get("格式", ""), "任务的键": key, "任务目录": workspace_name,
                            "任务目录路径": workspace["任务目录路径"],
                            "没有任务": True,
                            "说明": workspace.get("说明") or taskdb.NO_TASK_YET + "。"}
            raise NotFound(f"找不到任务目录「{workspace_name}」。")
        if key not in self.tasks:
            raise NotFound(f"找不到任务「{key}」。")
        if self.tasks[key].get("格式") == taskdb.FORMAT_CURRENT:
            return self.current_task_detail(key)
        task = self.tasks[key]
        projection = self.projections[key]
        revisions = []
        for revision in projection["修订"]:
            place = self.call_place.get((self.task_workspace.get(key, ""), revision["调用编号"]), {})
            revisions.append({**revision, "产生它的那一步": place})
        return {
            "任务的键": key,
            "任务标识": task["任务标识"],
            "任务类型": task["任务类型"],
            "任务目录": self.task_workspace.get(key, ""),
            "状态": task["状态"],
            "实例名": task["实例名"],
            "任务定义文件": task["任务定义文件"],
            "领域规矩": task["领域规矩"],
            "开始时刻": local_time(task["开始时刻"]),
            "结束时刻": local_time(task["结束时刻"]),
            "字段顺序": projection["字段顺序"],
            "字段说明": task["字段说明"],
            "字段现值": task["字段现值"],
            "建库时的变更条数": projection["建库时的变更条数"],
            "修订": revisions,
            "修订次数": projection["修订次数"],
            "涉及会话": sorted({r["产生它的那一步"].get("会话编号", "") for r in revisions} - {""}),
            "完成条件": {
                "有没有": False,
                "说明": "任务定义里还没有完成条件这一项，所以这里列不出清单。"
                        "任务定义里现在有的是做法的分步列表与交付物说明，它们说的是怎么做与做出什么，"
                        "不是「做到什么程度算做完」。",
            },
            "评审与交付": {
                "有没有": False,
                "说明": "这一版还没有评审与交付这两类记录：产品代码里还没有做这两件事，"
                        "库里也就没有对应的事件，所以这里不画徽标。",
            },
            "Langfuse 链接": self.langfuse_session_url(
                revisions[0]["产生它的那一步"].get("会话编号", "")) if revisions else "",
        }

    def current_task_detail(self, key: str) -> dict:
        """新格式任务的交付物页：按集合列出条目的当前内容、每个条目改动过的修订与来源、修订列表。"""
        task = self.tasks[key]["新库"]
        projection = self.projections[key]
        revisions = []
        for revision in projection["修订"]:
            place = self.call_place.get((self.task_workspace.get(key, ""), revision["调用编号"]), {})
            revisions.append({**revision, "产生它的那一步": place})
        collections = []
        for collection in task["任务定义"]["集合"]:
            items = [i for i in task["条目"] if i["所属集合"] == collection["名称"]]
            collections.append({
                "名称": collection["名称"],
                "编号前缀": collection["编号前缀"],
                "字段": collection["字段"],
                "现有条目数": sum(1 for i in items if i["在第几次修订删除"] is None),
                "已删除条目数": sum(1 for i in items if i["在第几次修订删除"] is not None),
                "条目": items,
            })
        sessions = sorted({r["会话编号"] for r in task["修订"]} | {task["创建它的会话编号"]} - {""})
        return {
            "格式": taskdb.FORMAT_CURRENT,
            "任务的键": key,
            "任务标识": task["任务编号"],
            "任务名": task["任务名"],
            "交付物名称": task["任务定义"]["交付物名称"],
            "任务目录": self.task_workspace.get(key, ""),
            "状态": task["状态"],
            "任务定义文件": task["任务定义文件"],
            "执行方法": task["任务定义"].get("执行方法", ""),
            "领域规矩": task["任务定义"].get("领域规矩", []),
            "完成条件": task["任务定义"]["完成条件"],
            "开始时刻": task["开始时刻"].replace("T", " ")[:19],
            "结束时刻": (task["结束时刻"] or "").replace("T", " ")[:19],
            "创建它的会话编号": task["创建它的会话编号"],
            "创建它的调用编号": task["创建它的调用编号"],
            "集合": collections,
            "修订": revisions,
            "修订次数": projection["修订次数"],
            "涉及会话": sessions,
            "评审与确认": "这一版还没有「请求评审」工具，库里的评审表是空的；确认标记（已读、界面修改、撤回）在看板的「用户已确认」一栏里看。",
            "Langfuse 链接": self.langfuse_session_url(sessions[0]) if sessions else "",
        }

    def call_detail(self, call_id: str) -> dict:
        # 同一个编号可能出现在不同任务目录里（例如假模型端点自动生成的编号），取会话里出现的第一处，
        # 事件与修订只在那一处的任务目录里找。
        ws, place = next(((w, p) for (w, c), p in self.call_place.items() if c == call_id), ("", {}))
        events = self.events_of_call(ws, call_id) if ws else self.events_by_call.get(call_id, [])
        if not events and not place:
            raise NotFound(f"找不到调用编号「{call_id}」。")
        return {
            "调用编号": call_id,
            "出现在哪里": place,
            "库里写下的事件": [{**e, "时刻": local_time(e["时刻"])} for e in events],
            "产生的修订": self.revision_by_call.get((ws or (events[0]["任务目录"] if events else ""), call_id)),
            "Langfuse 链接": self.langfuse_session_url(place.get("会话编号", "")),
            "怎么对照": "这一串在三处各有各的叫法：在 pi 的事件流与观测台上叫「调用编号」"
                        "（toolCallId），在任务目录的库里叫 call_id，在 Langfuse 的工具记录里"
                        "叫 tool_id（在 Metadata 一栏里）。三处应当逐字相同。",
        }

    def touched_workspaces(self, sessions: list[dict]) -> set[str]:
        """这些会话属于哪几个任务目录里的任务（按任务目录挂接，见 tasks_of_session）。"""
        names: set[str] = set()
        for session in sessions:
            names.update(t["任务目录"] for t in self.tasks_of_session(session))
        return names

    def health(self, scope: str) -> dict:
        if scope in ("", "all", "全部"):
            chosen = self.sessions
            scope_text = (f"全部会话（这个归档目录下一共 {len(self.sessions)} 次 pi 进程启动记录，"
                          f"含没有启动起来的那几次）")
        else:
            chosen = [self._session_or_404(scope)]
            scope_text = f"当前会话（{chosen[0].get('会话名') or '未命名会话'}）"
        # 不变式核对只看这些会话真的写过的任务目录。这个目录下没有会话碰过的那些旧任务目录不在范围内，
        # 免得把与这次运行无关的库也列一遍。
        touched = self.touched_workspaces(chosen)
        # 健康页要回答「到 Langfuse 通不通」，所以先拿范围里第一个运行记录编号去读一次。
        # 读过就有缓存，不会每开一次页面都发请求。
        first_trace = next((one.get("Langfuse 运行记录编号") for session in chosen
                            for one in session["运行"] if one.get("Langfuse 运行记录编号")), "")
        if first_trace:
            self.links.steps_of(first_trace)
        result = health_module.build_health(chosen, self.workspaces, touched,
                                            self.links.status())
        result["核对了几个任务目录"] = len(touched)
        result["没有核对的任务目录"] = sorted(
            {w["任务目录"] for w in self.workspaces} - touched)
        result["范围"] = scope_text
        result["范围取值"] = scope or "all"
        return result

    def session_options(self) -> list[dict]:
        """给健康页的范围选择器用。同一个归档名可能跑过好几次，所以标签上带开始时刻。"""
        return [{"会话编号": s["会话编号"] or s.get("归档文件", ""),
                 "名字": s.get("会话名") or "未命名会话",
                 "开始时刻": local_time(s["开始时刻"]),
                 "启动失败": s["启动失败"]} for s in self.sessions]

    def concepts(self) -> dict:
        """概念对照页要用的几张表。内容与出处都在 concepts.py 里，那里是唯一的一份。"""
        return concepts.build()
