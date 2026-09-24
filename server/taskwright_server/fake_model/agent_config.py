"""给 pi 准备一个只认假端点的配置目录。

pi 读配置目录的位置看环境变量 PI_CODING_AGENT_DIR；把它指到测试自己的临时目录，
里面只放一份 models.json，只登记假端点这一家模型服务，本机用户目录下 pi 的全局配置一概不碰。
"""

from __future__ import annotations

import json
from pathlib import Path

from taskwright_server.fake_model.server import MODEL_ID

#: pi 的环境变量：配置目录在哪里。
ENV_AGENT_DIR = "PI_CODING_AGENT_DIR"

#: models.json 里登记的模型服务名。启动 pi 时 --model 写「服务名/模型编号」。
PROVIDER = "fake"

#: 启动 pi 时 --model 参数的值。
MODEL_ARG = f"{PROVIDER}/{MODEL_ID}"


def write_agent_dir(target: Path, base_url: str) -> Path:
    """在 target 下写好 pi 的配置目录，返回目录路径。base_url 是假端点的地址，例如 http://127.0.0.1:43210/v1。"""
    target = Path(target)
    target.mkdir(parents=True, exist_ok=True)
    models = {"providers": {PROVIDER: {
        "baseUrl": base_url,
        "api": "openai-completions",
        "apiKey": "fake-placeholder-key",
        "compat": {"supportsDeveloperRole": False, "supportsReasoningEffort": False},
        "models": [{"id": MODEL_ID, "name": "按脚本回话的假模型", "reasoning": False, "input": ["text"],
                    "contextWindow": 32768, "maxTokens": 8192,
                    "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0}}],
    }}}
    (target / "models.json").write_text(json.dumps(models, ensure_ascii=False, indent=1), encoding="utf-8")
    (target / "settings.json").write_text("{}", encoding="utf-8")
    (target / "auth.json").write_text("{}", encoding="utf-8")
    return target
