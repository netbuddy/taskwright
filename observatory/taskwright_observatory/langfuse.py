"""到 Langfuse 的链接：第一级不用密钥，第二级用密钥读一次就能精确定位到某一步。

Langfuse 是自托管的大模型应用观测平台。它给 pi 的一次运行建一条**运行记录**（trace，
界面上写作 Pi Turn），给一次模型请求建一条**生成记录**（generation，写作 LLM Call），
给一次工具调用建一条**工具记录**（写作 Tool: 工具名）。

观测台给两级链接：

- **第一级，不用密钥。** 有运行记录编号就拼得出
  `<服务地址>/project/<项目标识>/traces/<运行记录编号>`，点过去落在那条运行记录上。
  编号是 pi 进程里那个只读小扩展在每一轮开始时报出来的（Langfuse 官方扩展把它写在环境变量
  `LANGFUSE_PI_PARENT_TRACE_ID` 里）。
- **第二级，要密钥。** 配了密钥时，本模块用 Langfuse 的公开读取接口把那条运行记录下的观测记录
  取回来，按 `metadata.tool_id` 与 pi 的调用编号精确对上工具调用，按 `metadata.assistant_index`
  对上模型请求（这个序号从 0 起，数的是这条运行记录里第几次模型请求），于是每一步都能拼出
  `<服务地址>/project/<项目标识>/traces/<运行记录编号>?observation=<观测记录编号>`。
  这两种地址格式都在 Langfuse 3.162.0 上实地点过。

几条规矩：

1. **只发 GET**，只读，不往 Langfuse 写任何东西。
2. **密钥只在本模块内部用**：不进接口返回、不进页面、不进日志、不落盘。
3. **取回来的东西只在内存里缓存**，观测台不另存数据。
4. 取回生成记录时顺带数一下它输入里的对话消息条数（不含系统提示）。观测台自己也从事件流里
   数了一个数，两个数都拿得到时界面上并排显示，各自注明来源，不挑一个。
5. **Langfuse 不通或者密钥不对，页面照常工作**：退回第一级链接，健康页如实显示不可达。
   一次失败之后短时间内不再重试，免得每开一次页面都干等几秒。
"""

from __future__ import annotations

import base64
import json
import os
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

#: 读一次 Langfuse 最多等这么久（秒）。宁可退回第一级链接，也不让页面卡住。
REQUEST_TIMEOUT = 5.0

#: 一次失败之后，这么多秒内不再去试。
RETRY_AFTER_FAILURE = 60.0

#: 存放 Langfuse 密钥与服务地址的那个文件，由这个环境变量指路。
ENV_KEY_FILE = "TASKWRIGHT_LANGFUSE_ENV_FILE"


def read_env_file(path: Path) -> dict[str, str]:
    """读一个每行写着「名字=值」的文件。以井号开头的行与空行跳过，值两头的引号去掉。"""
    values: dict[str, str] = {}
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return values
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        name, _, value = line.partition("=")
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        values[name.strip()] = value
    return values


def count_input_messages(value) -> int | None:
    """数一条生成记录的输入里有几条对话消息，系统提示不算。

    Langfuse 把发给模型的那一串消息原样存在观测记录的 input 里，第一条通常是系统提示。
    形状不是一串消息时返回空值，界面上就只显示观测台自己数出来的那个数。
    """
    if not isinstance(value, list):
        return None
    count = 0
    for item in value:
        if not isinstance(item, dict):
            return None
        if str(item.get("role") or "") == "system":
            continue
        count += 1
    return count


class LangfuseLinks:
    """按运行记录编号给出到 Langfuse 的第一级与第二级链接。"""

    def __init__(self, base_url: str = "", project_id: str = "", key_file: str = ""):
        self.base_url = (base_url or "").rstrip("/")
        self.project_id = project_id or ""
        raw = key_file or os.environ.get(ENV_KEY_FILE, "")
        values = read_env_file(Path(raw).expanduser()) if raw else {}
        #: 密钥只留在这个私有字段里，别处一律取不到。
        self._public_key = values.get("LANGFUSE_PUBLIC_KEY", "")
        self._secret_key = values.get("LANGFUSE_SECRET_KEY", "")
        self.base_url = self.base_url or (values.get("LANGFUSE_BASE_URL", "") or "").rstrip("/")
        self._lock = threading.Lock()
        self._cache: dict[str, dict] = {}     # 运行记录编号 → 这条记录下各步的链接
        self._reachable: bool | None = None   # 还没试过时是空值
        self._last_error = ""
        self._quiet_until = 0.0

    # ───────────── 配置与状态 ─────────────

    @property
    def can_link(self) -> bool:
        """有服务地址与项目标识就拼得出第一级链接。"""
        return bool(self.base_url and self.project_id)

    @property
    def has_keys(self) -> bool:
        """配了密钥才做得了第二级链接。"""
        return bool(self._public_key and self._secret_key)

    def status(self) -> dict:
        """给健康页看的状态。这里面一个密钥字符都没有。"""
        if not self.can_link:
            state, note = "未配", ("没有给 Langfuse 的服务地址或项目标识，所以连第一级链接也拼不出来。"
                                  "用 --langfuse-base 与 --langfuse-project 给上，或者设好对应的环境变量。")
        elif not self.has_keys:
            state, note = "未配密钥", ("配了服务地址与项目标识，所以第一级链接（直达那条运行记录）可用；"
                                      "没有配 Langfuse 密钥，所以第二级链接（直达某一次模型请求或某一次"
                                      "工具调用）做不了。密钥从环境变量 "
                                      f"{ENV_KEY_FILE} 指向的文件里读。")
        elif self._reachable is None:
            state, note = "还没试过", "配了密钥，但这一次还没有向 Langfuse 发过读取请求，所以说不出通不通。"
        elif self._reachable:
            state, note = "可达", "配了密钥，最近一次读取请求成功了，第二级链接可用。"
        else:
            state, note = "不可达", ("配了密钥，但最近一次读取请求没有成功，所以第二级链接退回了第一级。"
                                    f"出错原因原文是：{self._last_error}")
        return {
            "状态": state,
            "说明": note,
            "服务地址": self.base_url or "（没有给）",
            "项目标识": self.project_id or "（没有给）",
            "有没有配密钥": self.has_keys,
            "缓存了几条运行记录": len(self._cache),
        }

    # ───────────── 第一级 ─────────────

    def session_url(self, session_id: str) -> str:
        if not (self.can_link and session_id):
            return ""
        return f"{self.base_url}/project/{self.project_id}/sessions/{session_id}"

    def sessions_url(self) -> str:
        if not self.can_link:
            return ""
        return f"{self.base_url}/project/{self.project_id}/sessions"

    def trace_url(self, trace_id: str) -> str:
        if not (self.can_link and trace_id):
            return ""
        return f"{self.base_url}/project/{self.project_id}/traces/{trace_id}"

    def observation_url(self, trace_id: str, observation_id: str) -> str:
        if not (self.can_link and trace_id and observation_id):
            return ""
        return f"{self.trace_url(trace_id)}?observation={observation_id}"

    # ───────────── 第二级 ─────────────

    def _get(self, path: str):
        """向 Langfuse 发一次 GET。密钥只出现在请求头里，不进日志。"""
        request = urllib.request.Request(
            self.base_url + path,
            headers={"Authorization": "Basic " + base64.b64encode(
                f"{self._public_key}:{self._secret_key}".encode()).decode()},
            method="GET")
        with urllib.request.urlopen(request, timeout=REQUEST_TIMEOUT) as response:
            return json.load(response)

    def steps_of(self, trace_id: str) -> dict:
        """取这条运行记录下各步的链接。取不到就返回空的那一份，调用方据此退回第一级。

        返回的形状：
            {"取到了吗": bool, "工具调用": {调用编号: 链接}, "模型请求": {序号: 链接},
             "模型请求消息条数": {序号: 条数}, "说明": str}

        「模型请求消息条数」数的是那条生成记录输入里的对话消息，系统提示不算在内。
        """
        empty = {"取到了吗": False, "工具调用": {}, "模型请求": {}, "模型请求消息条数": {},
                 "说明": "没有取到这条运行记录下的观测记录，所以只给到这条运行记录那一级。"}
        if not (self.can_link and self.has_keys and trace_id):
            return empty
        with self._lock:
            if trace_id in self._cache:
                return self._cache[trace_id]
            if time.time() < self._quiet_until:
                return {**empty, "说明": "刚才向 Langfuse 读取没有成功，暂时不再重试，"
                                         "所以只给到这条运行记录那一级。"}
        try:
            # Langfuse 的读取接口每页最多 100 条（给 200 会回 400），所以按页取完。
            rows = []
            page = 1
            while True:
                payload = self._get(
                    f"/api/public/observations?traceId={trace_id}&limit=100&page={page}")
                batch = payload.get("data") or []
                rows.extend(batch)
                total_pages = ((payload.get("meta") or {}).get("totalPages")) or 1
                if page >= total_pages or not batch or page >= 10:
                    break
                page += 1
        except (urllib.error.URLError, OSError, ValueError, TimeoutError) as error:
            with self._lock:
                self._reachable = False
                self._last_error = str(error)
                self._quiet_until = time.time() + RETRY_AFTER_FAILURE
            return {**empty, "说明": "向 Langfuse 读取这条运行记录时出错了，所以只给到这条记录那一级。"}

        tools: dict[str, str] = {}
        requests: dict[int, str] = {}
        counts: dict[int, int] = {}
        for row in rows:
            metadata = row.get("metadata") if isinstance(row.get("metadata"), dict) else {}
            observation_id = str(row.get("id") or "")
            if not observation_id:
                continue
            tool_id = metadata.get("tool_id")
            if tool_id:
                tools[str(tool_id)] = self.observation_url(trace_id, observation_id)
            index = metadata.get("assistant_index")
            if isinstance(index, int):
                requests[index] = self.observation_url(trace_id, observation_id)
                messages = count_input_messages(row.get("input"))
                if messages is not None:
                    counts[index] = messages
        found = {"取到了吗": True, "工具调用": tools, "模型请求": requests,
                 "模型请求消息条数": counts,
                 "说明": f"从 Langfuse 取到了这条运行记录下的 {len(rows)} 条观测记录："
                         f"{len(tools)} 条工具记录按调用编号对上，"
                         f"{len(requests)} 条生成记录按它在这条记录里的先后对上，"
                         f"其中 {len(counts)} 条数得出输入里的对话消息条数。"}
        with self._lock:
            self._reachable = True
            self._last_error = ""
            self._cache[trace_id] = found
        return found
