"""起用户 agent 的 pi：复用 server/taskwright_server/launch.py 的组装逻辑（经会话类 PiSession），只在这里把系统提示按用户画像拼好。

用户画像里只有自然语言部分交给扮演者：人设、目标、材料说明、隐藏事实的「事实」、接受底线的「说法」；
隐藏事实的关键词与接受底线的判据是给判定程序用的，不给扮演者看。

画像的「熟悉的材料」列出扮演者自己整理过的材料文件：启动时从材料目录读出全文，
放进系统提示，扮演者就知道材料里写了什么。材料原文只在运行时读入，写进演练目录下的系统提示副本，
不写进画像文件，也不进代码仓。「看界面」照旧不返回材料。
"""

from __future__ import annotations

import copy
import json
from pathlib import Path

from taskwright_server import launch
from taskwright_server.pi_session import PiSession

HERE = Path(__file__).resolve().parent
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


def user_agent_session(persona: dict, sim_dir: Path, materials_dir: Path | None = None) -> PiSession:
    """准备好用户 agent 的会话类：系统提示写进演练目录，工作目录是演练目录下一个空目录。调用方负责 start()。"""
    sim_dir = Path(sim_dir)
    prompt_file = sim_dir / "user_agent_system_prompt.md"
    prompt_file.write_text(system_prompt(persona, materials_dir), encoding="utf-8")
    profile = copy.deepcopy(json.loads(PROFILE.read_text(encoding="utf-8")))
    profile["system_prompt_file"] = str(prompt_file)      # 绝对路径：launch.py 拼路径时绝对路径原样保留
    cwd = sim_dir / "user-agent-cwd"
    cwd.mkdir(parents=True, exist_ok=True)
    return PiSession(profile, cwd, sim_dir / "user-agent", LABEL)


def load_profile() -> dict:
    return json.loads(PROFILE.read_text(encoding="utf-8"))


__all__ = ["load_persona", "familiar_materials", "persona_text", "system_prompt", "user_agent_session", "launch"]
