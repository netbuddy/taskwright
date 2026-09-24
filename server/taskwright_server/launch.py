"""启动配置：把启动参数配置读成一条 pi 命令行与一份环境变量。

全部代码里拼 pi 命令行的地方只有本模块的 build_command 函数这一处，别处一律不拼。

配置文件（profiles/ 下的 JSON）里不写任何机器上的绝对路径，也不写任何密钥。
随机器变化的三样东西经环境变量给：

    TASKWRIGHT_LANGFUSE_PLUGIN    Langfuse 观测插件所在的目录（或直接指向它的扩展入口文件）。
    TASKWRIGHT_LANGFUSE_ENV_FILE  存放 Langfuse 密钥与服务地址的文件，这个文件在代码仓之外。
    TASKWRIGHT_RUNS_DIR           运行目录，原始事件流与会话文件都归档到这里。

怎么设这三个变量，见本目录的 README。
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
from pathlib import Path

#: 配置文件所在目录。
PROFILE_DIR = Path(__file__).resolve().parent / "profiles"

#: 代码仓根目录：本包的上一级。配置里写「跟着代码走」的扩展时，路径相对它解析。
REPO_ROOT = Path(__file__).resolve().parents[2]

#: 环境变量名。集中写在这里，别处引用这几个常量，不要重复写字符串。
ENV_PLUGIN = "TASKWRIGHT_LANGFUSE_PLUGIN"
ENV_KEY_FILE = "TASKWRIGHT_LANGFUSE_ENV_FILE"
ENV_RUNS_DIR = "TASKWRIGHT_RUNS_DIR"

#: Langfuse 里那个项目的编号。它不是密钥，但随部署变化，所以也经环境变量给。
ENV_PROJECT_ID = "TASKWRIGHT_LANGFUSE_PROJECT_ID"

#: Langfuse 插件自己读的环境变量里，表示「这批数据属于哪个环境」的那一个。
ENV_TRACING_ENVIRONMENT = "LANGFUSE_TRACING_ENVIRONMENT"


class LaunchError(Exception):
    """启动配置有问题，带一句说明缺什么、怎么补。"""


def load_profile(name: str = "dev") -> dict:
    """读一份启动配置。name 是 profiles 目录下的文件名，不带扩展名。"""
    path = PROFILE_DIR / f"{name}.json"
    if not path.is_file():
        available = "、".join(sorted(p.stem for p in PROFILE_DIR.glob("*.json"))) or "（一个都没有）"
        raise LaunchError(f"找不到启动配置「{name}」。可用的配置有：{available}。")
    return json.loads(path.read_text(encoding="utf-8"))


def read_env_file(path: Path) -> dict[str, str]:
    """读一个每行写着「名字=值」的文件。以井号开头的行与空行跳过，值两头的引号去掉。"""
    values: dict[str, str] = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        name, _, value = line.partition("=")
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        values[name.strip()] = value
    return values


def resolve_extension(entry: dict) -> Path | None:
    """把配置里的一条扩展说明解析成一个真实存在的文件路径。缺了非必需的就返回 None。"""
    name = entry.get("name", "（没写名字的扩展）")
    source = entry.get("source")
    if source == "repo":
        path = REPO_ROOT / entry["path"]
        if not path.is_file():
            raise LaunchError(f"扩展「{name}」应当在代码仓的 {entry['path']}，但那里没有这个文件。")
        return path
    if source == "env":
        variable = entry["env"]
        raw = os.environ.get(variable, "").strip()
        if not raw:
            if entry.get("required", True):
                raise LaunchError(
                    f"扩展「{name}」要靠环境变量 {variable} 指路，但这个变量没有设。"
                    f"把它设成插件所在的目录，再重新启动。"
                )
            return None
        path = Path(raw).expanduser()
        if path.is_dir():
            path = path / entry.get("entry", "src/index.ts")
        if not path.is_file():
            raise LaunchError(f"扩展「{name}」按环境变量 {variable} 找到的位置不是一个文件：{path}")
        return path
    raise LaunchError(f"扩展「{name}」的 source 只能写 repo 或 env，现在写的是 {source!r}。")


def runs_dir() -> Path:
    """运行目录。没设环境变量时用当前目录下的 runs 子目录。"""
    raw = os.environ.get(ENV_RUNS_DIR, "").strip()
    return Path(raw).expanduser() if raw else Path.cwd() / "runs"


def build_environment(profile: dict) -> dict[str, str]:
    """组装交给 pi 进程的环境变量。

    密钥从代码仓之外的那个文件读进来，只经环境变量传给 pi，不落任何文件、不进命令行参数
    （命令行参数在进程列表里是所有人可见的）。
    """
    env = dict(os.environ)
    key_file = os.environ.get(ENV_KEY_FILE, "").strip()
    loaded: dict[str, str] = {}
    if key_file:
        path = Path(key_file).expanduser()
        if not path.is_file():
            raise LaunchError(f"环境变量 {ENV_KEY_FILE} 指向的文件不存在：{path}")
        loaded = read_env_file(path)
    for name in profile.get("env_passthrough", []):
        value = loaded.get(name) or os.environ.get(name)
        if value:
            env[name] = value
    environment_tag = (profile.get("langfuse") or {}).get("environment")
    if environment_tag:
        env.setdefault(ENV_TRACING_ENVIRONMENT, environment_tag)
        env[ENV_TRACING_ENVIRONMENT] = env.get(ENV_TRACING_ENVIRONMENT) or environment_tag
    return env


def describe_extensions(profile: dict) -> list[tuple[str, Path | None]]:
    """把配置里的扩展逐条解析出来，返回（名字, 路径或 None）的列表，给启动说明与排查用。"""
    return [(entry.get("name", "（没写名字的扩展）"), resolve_extension(entry))
            for entry in profile.get("extensions", [])]


def build_command(profile: dict, workspace: Path, session_dir: Path,
                  session_file: Path | None = None, interactive: bool = False) -> tuple[list[str], dict[str, str]]:
    """组装启动 pi 的命令行与环境变量。这是全部代码里唯一拼 pi 命令行的地方。

    session_file 给了就让 pi 接着那个会话文件往下跑，用来实现「重启并续接原会话」。
    interactive 为真时不写 --mode，pi 以自带的终端界面（交互模式）运行，给人亲手验证用（server/taskwright_server/tui.py）；
    其余参数与 RPC 模式一字不差，好让两种模式下执行者手上的扩展、工具、系统提示、skill 与模型相同。
    """
    executable = shutil.which(profile.get("executable", "pi"))
    if executable is None:
        raise LaunchError("在 PATH 里找不到 pi 命令，先把 pi 装好再启动。")
    argv = [executable] if interactive else [executable, "--mode", profile.get("mode", "rpc")]
    for name, path in describe_extensions(profile):
        if path is not None:
            argv += ["-e", str(path)]
    flags = profile.get("flags", {})
    if flags.get("no_extensions"):
        argv.append("--no-extensions")
    if flags.get("no_skills"):
        argv.append("--no-skills")
    if flags.get("approve"):
        argv.append("--approve")
    if flags.get("offline"):
        argv.append("--offline")
    tools = profile.get("tools")
    if tools:
        argv += ["--tools", ",".join(tools)]
    model = profile.get("model")
    if model:
        argv += ["--model", model]
    thinking = profile.get("thinking")
    if thinking:
        argv += ["--thinking", thinking]
    # 技能自动发现关掉之后，任务目录里的技能要显式加载；目录不在就不加，pi 也就不会报「路径不存在」。
    skills_dir = profile.get("workspace_skills_dir")
    if skills_dir and (Path(workspace) / skills_dir).is_dir():
        argv += ["--skill", str((Path(workspace) / skills_dir).resolve())]
    argv += ["--session-dir", str(session_dir)]
    if session_file is not None:
        argv += ["--session", str(session_file)]
    prompt_file = profile.get("system_prompt_file")
    if prompt_file:
        path = REPO_ROOT / prompt_file
        if not path.is_file():
            raise LaunchError(f"配置里写的系统提示文件不存在：{prompt_file}")
        argv += ["--system-prompt", path.read_text(encoding="utf-8")]
    return argv, build_environment(profile)


def startup_record(profile: dict, argv: list[str]) -> dict:
    """把这一次启动的几样事实收成一份记录，交给会话类写进后端补记文件。

    这几样东西 pi 的标准输出里一律没有：它不会告诉外面「我把哪个扩展加载到了哪个文件」，
    也不会重复一遍自己的命令行。以前它们只被打在终端上，关掉终端就没了，
    观测台因此说不出扩展有没有加载成功。现在把它们落一份盘。
    """
    return {
        "命令行": list(argv),
        # 这里只说「后端把这个扩展解析到了哪个文件、那个文件在不在」。
        # pi 有没有真的把它加载起来是另一回事：文件在、但里面有语法错误时 pi 会报错退出，
        # 那种情形只能看标准错误与退出码，所以这里不写「加载成功」。
        "扩展": [{"名字": name, "解析到的文件": str(path) if path else "", "文件在不在": path is not None}
                 for name, path in describe_extensions(profile)],
        "工具白名单": list(profile.get("tools") or []),
        "模型": profile.get("model", ""),
        "环境标签": (profile.get("langfuse") or {}).get("environment", ""),
    }


def redact(argv: list[str]) -> str:
    """把命令行写成一行给人看。命令行里本来就不含密钥，这里只是把任务目录外的长路径缩短。"""
    home = str(Path.home())
    return " ".join(part.replace(home, "~") for part in argv)


def observability_settings(profile: dict) -> dict[str, str]:
    """给终端客户端拼 Langfuse 链接用的几样东西：服务地址、项目编号、环境标签。

    服务地址在代码仓之外的那个密钥文件里，项目编号在环境变量里。取不到就返回空串，
    调用方据此少显示一行，不报错。
    """
    values: dict[str, str] = {}
    key_file = os.environ.get(ENV_KEY_FILE, "").strip()
    if key_file:
        path = Path(key_file).expanduser()
        if path.is_file():
            values = read_env_file(path)
    return {
        "base_url": (values.get("LANGFUSE_BASE_URL") or os.environ.get("LANGFUSE_BASE_URL") or "").rstrip("/"),
        "project_id": (values.get(ENV_PROJECT_ID) or os.environ.get(ENV_PROJECT_ID) or "").strip(),
        "environment": (profile.get("langfuse") or {}).get("environment", ""),
    }


# ───────────── 启动那一刻的知识仓库与上下文文件 ─────────────

#: 知识仓库在任务目录里的位置：执行方法（skill）与各类文档。只记这两处下面每份文件的路径与摘要值。
KNOWLEDGE_DIRS = (".pi/skills", "docs")

#: pi 在一个目录里找上下文文件时依次试的文件名，与 pi 的 resource-loader 里写的一样，找到第一个就停。
CONTEXT_FILE_NAMES = ("AGENTS.override.md", "AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD")


def knowledge_snapshot(workspace: Path) -> dict:
    """启动那一刻任务目录知识仓库里每份文件的路径、字节数与内容摘要值（SHA-256 的前 16 位）。

    只记摘要值，不记内容：观测台据此说出这一次用的是哪一版知识，前后两次启动之间哪份文件变过。
    """
    root = Path(workspace)
    files = []
    for sub in KNOWLEDGE_DIRS:
        base = root / sub
        if not base.is_dir():
            continue
        for path in sorted(base.rglob("*")):
            if not path.is_file():
                continue
            try:
                data = path.read_bytes()
            except OSError as error:
                files.append({"路径": str(path.relative_to(root)), "字节数": None, "摘要值": "",
                              "说明": f"读不出来：{error}"})
                continue
            files.append({"路径": str(path.relative_to(root)), "字节数": len(data),
                          "摘要值": hashlib.sha256(data).hexdigest()[:16]})
    return {"摘要算法": "SHA-256 取前 16 位十六进制", "位置": list(KNOWLEDGE_DIRS), "文件": files}


def context_file_candidates(argv: list[str], workspace: Path, env: dict[str, str]) -> dict:
    """pi 会放进系统提示的上下文文件（AGENTS.md 一类）。

    pi 的 RPC 没有查询这一项的命令，后端取不到 pi 实际加载的清单。这里如实写明取不到，
    另外照 pi 的发现规则在磁盘上查一遍：pi 的配置目录，加上任务目录与它的每一级上级目录，
    每个目录里按固定的几个文件名找第一个存在的。命令行带了 --no-context-files 时 pi 一个都不加载。
    """
    disabled = "--no-context-files" in argv or "-nc" in argv
    agent_dir = Path(env.get("PI_CODING_AGENT_DIR") or Path.home() / ".pi" / "agent").expanduser()
    found: list[str] = []
    directories = [agent_dir]
    current = Path(workspace).resolve()
    ancestors = []
    while True:
        ancestors.append(current)
        if current.parent == current:
            break
        current = current.parent
    directories.extend(reversed(ancestors))
    for directory in directories:
        for name in CONTEXT_FILE_NAMES:
            candidate = directory / name
            if candidate.is_file():
                if str(candidate) not in found:
                    found.append(str(candidate))
                break
    return {
        "取得到吗": False,
        "为什么取不到": "pi 的 RPC 没有查询上下文文件的命令，扩展之外的程序拿不到 pi 实际加载的清单。",
        "命令行关掉了上下文文件吗": disabled,
        "照 pi 的发现规则在磁盘上查到的": [] if disabled else found,
        "查了哪些目录": [str(d) for d in directories],
        "说明": ("命令行带了 --no-context-files，pi 不会加载任何上下文文件。" if disabled else
                 "下面这份是后端照 pi 的发现规则在启动那一刻查到的，不是 pi 报告的；"
                 "要核实 pi 实际放进了什么，看 Langfuse 里第一条生成记录的系统提示有没有 <project_context> 一节。"),
    }
