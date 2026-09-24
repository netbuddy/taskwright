"""假模型端点：按脚本回固定内容的 OpenAI 兼容本地服务，给 RPC 集成测试用。说明见同目录 README.md。"""

from taskwright_server.fake_model.agent_config import ENV_AGENT_DIR, MODEL_ARG, write_agent_dir
from taskwright_server.fake_model.server import FakeModel

__all__ = ["FakeModel", "write_agent_dir", "ENV_AGENT_DIR", "MODEL_ARG"]
