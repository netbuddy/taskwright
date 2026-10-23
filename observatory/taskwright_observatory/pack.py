"""打开一个数据包（产品导出的 .taskwright.zip，诊断包是其中一种）给观测台看。

    python3 -m taskwright_observatory --pack <包路径>

包解到用户缓存目录 `$XDG_CACHE_HOME/taskwright/observatory/<包 SHA-256 前 16 位>/`（没设 XDG_CACHE_HOME 时是 ~/.cache），
按内容指纹分目录：同一个包再开一次不重解。先解到旁边的临时目录，解完写下 .complete 再改名成正式目录；正式目录在而没有
.complete 的（上次解到一半），删掉重解。解好之后以其中的 runs/ 与 tasks/ 当归档目录与任务目录所在目录。

包里的 manifest.json 给出包头：格式、产品版本、任务库格式、诊断包那一节（用途、粒度、任务、模型、日志范围）。
包的格式或任务库格式比观测台认得的新时（对照见 taskdb.py 的 KNOWN_PACK_FORMAT 与 KNOWN_TASK_DB_VERSION），不解析包里的数据，
页面只显示包头与一句说明：半读出来的页面会误导排查。
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import zipfile
from dataclasses import dataclass, field
from pathlib import Path

from taskwright_observatory.taskdb import KNOWN_PACK_FORMAT, KNOWN_TASK_DB_VERSION

#: 解好的目录里表示「解完了」的标记文件。
COMPLETE_MARK = ".complete"
#: 包里的清单文件、后端日志目录与设置摘录。
MANIFEST = "manifest.json"
LOGS_DIR = "logs"
SETTINGS_EXCERPT = "settings.redacted.json"


class PackError(Exception):
    """包打不开：不是 zip、没有清单文件、清单读不懂、里面有指向包外的路径。"""


@dataclass
class OpenedPack:
    """一个解好的包：来源路径、解到的目录、清单内容；too_new 不是空的时，不解析包里的数据。"""
    source: Path
    root: Path
    manifest: dict
    too_new: str = ""
    fingerprint: str = ""
    extra: dict = field(default_factory=dict)

    @property
    def runs_dir(self) -> Path:
        return self.root / "runs"

    @property
    def tasks_dir(self) -> Path:
        return self.root / "tasks"


def cache_root(env: dict | None = None) -> Path:
    """解包的缓存目录。"""
    env = os.environ if env is None else env
    base = env.get("XDG_CACHE_HOME") or str(Path.home() / ".cache")
    return Path(base).expanduser() / "taskwright" / "observatory"


def fingerprint_of(path: Path) -> str:
    """包文件 SHA-256 的前 16 位十六进制。"""
    digest = hashlib.sha256()
    with open(path, "rb") as stream:
        for chunk in iter(lambda: stream.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()[:16]


def _extract(source: Path, target: Path) -> None:
    """把包解到 target（一个还不存在的目录）。成员路径是绝对路径、或者带 .. 走出 target 的，整个包拒绝。"""
    target.mkdir(parents=True)
    base = target.resolve()
    with zipfile.ZipFile(source) as archive:
        for member in archive.infolist():
            name = member.filename
            dest = (target / name).resolve()
            if name.startswith(("/", "\\")) or not (dest == base or str(dest).startswith(str(base) + os.sep)):
                raise PackError(f"包里有指向包外的路径「{name}」，不打开。")
        archive.extractall(target)


def too_new_text(manifest: dict) -> str:
    """包的格式或任务库格式比观测台认得的新时给人看的一句话；认得时是空的。"""
    product = str(manifest.get("product_version") or "导出它的那一")
    pack_format = manifest.get("pack_format")
    if isinstance(pack_format, int) and pack_format > KNOWN_PACK_FORMAT:
        return f"这个包是格式 {pack_format}，这个观测台只认到格式 {KNOWN_PACK_FORMAT}，请用 {product} 版观测台。"
    db_version = manifest.get("task_db_version")
    if isinstance(db_version, int) and db_version > KNOWN_TASK_DB_VERSION:
        return (f"这个包里的任务库是格式 {db_version}，这个观测台只认到格式 {KNOWN_TASK_DB_VERSION}，"
                f"请用 {product} 版观测台。")
    return ""


def open_pack(source: Path, env: dict | None = None) -> OpenedPack:
    """解开（或找到已经解好的）一个包，读它的清单。"""
    source = Path(source).expanduser().resolve()
    if not source.is_file():
        raise PackError(f"包文件不存在：{source}")
    if not zipfile.is_zipfile(source):
        raise PackError(f"这不是一个数据包（不是 zip 文件）：{source}")
    mark = fingerprint_of(source)
    root = cache_root(env) / mark
    if root.is_dir() and not (root / COMPLETE_MARK).is_file():
        shutil.rmtree(root)
    if not root.is_dir():
        root.parent.mkdir(parents=True, exist_ok=True)
        temp = root.parent / f".{mark}.{os.getpid()}.tmp"
        if temp.exists():
            shutil.rmtree(temp)
        try:
            _extract(source, temp)
            (temp / COMPLETE_MARK).write_text(str(source) + "\n", encoding="utf-8")
            try:
                temp.rename(root)
            except OSError:
                # 别的观测台进程同时解好了同一个包：用它的。
                if not (root / COMPLETE_MARK).is_file():
                    raise
                shutil.rmtree(temp)
        except BaseException:
            shutil.rmtree(temp, ignore_errors=True)
            raise
    try:
        manifest = json.loads((root / MANIFEST).read_text(encoding="utf-8"))
    except FileNotFoundError:
        raise PackError(f"包里没有 {MANIFEST}，不是产品导出的数据包：{source}") from None
    except (OSError, json.JSONDecodeError) as error:
        raise PackError(f"包里的 {MANIFEST} 读不懂：{error}") from None
    if not isinstance(manifest, dict):
        raise PackError(f"包里的 {MANIFEST} 不是一个对象。")
    return OpenedPack(source=source, root=root, manifest=manifest, too_new=too_new_text(manifest), fingerprint=mark)


PURPOSE_NAMES = {"full": "完整", "redacted": "脱敏"}
GRANULARITY_NAMES = {"task": "一个任务实例"}


def model_text(model) -> str:
    """清单里记的模型给人看的写法：对象（{provider, model, from}）写成「模型（供应商，取自…）」，与包里说明.txt 的写法相同。"""
    if isinstance(model, dict):
        notes = "，".join(one for one in [str(model.get("provider") or ""), f"取自{model['from']}" if model.get("from") else ""] if one)
        return f"{model.get('model') or '？'}（{notes}）" if notes else str(model.get("model") or "")
    return str(model or "")


def header(pack: OpenedPack) -> dict:
    """首页顶部「诊断包」一块的各项。普通数据包（清单里没有 diagnostic 一节）写明不是诊断包。"""
    manifest = pack.manifest
    diagnostic = manifest.get("diagnostic") if isinstance(manifest.get("diagnostic"), dict) else None
    tasks = [t.get("task_id") for t in manifest.get("tasks") or [] if isinstance(t, dict) and t.get("task_id")]
    log_range = (diagnostic or {}).get("log_range")
    if isinstance(log_range, dict) and (log_range.get("from") or log_range.get("to")):
        range_text = f"{log_range.get('from') or '？'} 到 {log_range.get('to') or '？'}"
    else:
        range_text = "没有带后端日志"
    model = (diagnostic or {}).get("launch_model") or (diagnostic or {}).get("model") or ""
    return {
        "包文件": str(pack.source),
        "解到": str(pack.root),
        "是不是诊断包": diagnostic is not None,
        "用途": PURPOSE_NAMES.get(str((diagnostic or {}).get("purpose")), str((diagnostic or {}).get("purpose") or ""))
                if diagnostic else "数据包（不是诊断包）",
        "粒度": GRANULARITY_NAMES.get(str((diagnostic or {}).get("granularity")), str((diagnostic or {}).get("granularity") or ""))
                if diagnostic else str(manifest.get("scope") or ""),
        "任务编号": "、".join(tasks),
        "会话编号": str((diagnostic or {}).get("session_id") or ""),
        "导出时刻": str(manifest.get("exported_at") or ""),
        "产品版本": str(manifest.get("product_version") or ""),
        "包格式": manifest.get("pack_format"),
        "任务库格式": manifest.get("task_db_version"),
        "模型": model_text(model),
        "日志范围": range_text if diagnostic else "",
        "带没带事件归档": bool(manifest.get("with_events")),
        "格式过新": pack.too_new,
    }


def log_files(pack: OpenedPack) -> list[dict]:
    """包里 logs/ 下的后端日志：名字、字节数、行数，按名字排。"""
    folder = pack.root / LOGS_DIR
    if not folder.is_dir():
        return []
    rows = []
    for path in sorted(p for p in folder.iterdir() if p.is_file()):
        data = path.read_bytes()
        rows.append({"文件": path.name, "字节数": len(data), "行数": data.count(b"\n") + (0 if data.endswith(b"\n") or not data else 1)})
    return rows


def log_text(pack: OpenedPack, name: str) -> str:
    """一份后端日志的全文；名字不在 logs/ 下的（含路径分隔符、..）当作没有。"""
    if not name or "/" in name or "\\" in name or name in (".", ".."):
        raise FileNotFoundError(name)
    path = pack.root / LOGS_DIR / name
    if not path.is_file():
        raise FileNotFoundError(name)
    return path.read_text(encoding="utf-8", errors="replace")


def settings_excerpt(pack: OpenedPack) -> dict | None:
    """包里的设置摘录（settings.redacted.json）；没有时是 None，读不懂时给原文。"""
    path = pack.root / SETTINGS_EXCERPT
    if not path.is_file():
        return None
    text = path.read_text(encoding="utf-8", errors="replace")
    try:
        return {"内容": json.loads(text)}
    except json.JSONDecodeError:
        return {"原文": text}
