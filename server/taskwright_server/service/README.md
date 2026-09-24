# 任务服务（server/taskwright_server/service）

给前端的 HTTP 接口，形状见 docs/api.md。只用 Python 标准库；不写任务数据库，库只由 pi 进程里的工具与扩展命令写。

## 怎样起

```bash
python -m taskwright_server.service --tasks <放任务目录的上级目录> --runs <归档目录> --port <端口>
```

- 绑 `0.0.0.0`；端口由命令行给。
- 启动配置默认取 `profiles/dev.json`（`--profile` 可换）。Langfuse 照终端客户端的做法经环境变量给：`TASKWRIGHT_LANGFUSE_PLUGIN`、`TASKWRIGHT_LANGFUSE_ENV_FILE`、`LANGFUSE_TRACING_ENVIRONMENT`。
- 按进程号 `kill` 时会先关掉各任务的 pi，再打印每个任务的事件分发统计（轮询次数、提示次数、推送的库事件数）。
- 每个任务的 pi 会话文件与原始事件流放在 `<归档目录>/<任务编号>/pi-sessions/service/` 与 `pi-events/`。

## 接口一览

| 接口 | 做什么 |
|---|---|
| `GET /api/v1/tasks` | 任务列表。 |
| `POST /api/v1/tasks` | 新建任务：`{task_type, task_name, domain_tag}`，返回 `{ok, task_id}`。 |
| `GET /api/v1/tasks/{task_id}` | 任务页：任务、材料清单、会话列表。 |
| `GET/POST …/sessions` | 会话列表；新建会话（执行者正在工作时 `session_busy`）。 |
| `GET …/events?session=` | 事件流（SSE），带 `Last-Event-ID` 补发，差距超过 500 条发 `resync`。 |
| `GET …/snapshot?session=` | 整份数据；带 `session` 时按需启动或续接 pi。 |
| `POST …/messages?session=` | 用户说一句话；`origin: "card_choice"` 带 `annotation` 时走扩展命令 `/tw-ui`。 |
| `POST …/actions?session=` | 直接操作，经扩展命令 `/tw-user` 写库，响应只有 `{ok, client_id, op_id}`。 |
| `POST …/control?session=` | `{"action": "stop"}`：清掉排队的话并中止。 |
| `POST …/materials` | 上传材料（multipart，只收 `.md`、`.txt`，5 MB 以内）。 |
| `GET …/materials/content?path=`、`…/items/{item_id}/versions`、`…/conversation?session=&before=&limit=` | 按需读取。 |
| `POST …/documents/preview`、`…/download` | 按任务目录里的模板渲染选中的条目版本。 |

测试：单元测试在 `server/tests/test_service_units.py`，集成测试（假模型端点加真实 pi）在 `server/tests/integration/test_service_with_fake_model.py`。
