# 假模型端点

这是一个按脚本回固定内容的本地 HTTP 服务，接口与 OpenAI 的聊天接口兼容（`POST /v1/chat/completions`），只用 Python 标准库。它给 RPC 集成测试用：pi 以为自己在请求模型，实际每次拿到的回答都是测试事先写好的。这样，门禁拒绝、用户直接写入这类机制可以被确定性地测，不受真模型随机性的影响。

集成测试在 `server/tests/integration/`。

## 它能回什么

一条「回答」是一个 dict，下面几项按需写：

| 键 | 意思 |
|---|---|
| `text` | 助手回复的文字。 |
| `tool_calls` | 工具调用的列表，每项是 `{"name": 工具名, "arguments": {参数}, "id": 调用编号}`。`id` 可以不写，不写时由假端点生成 `call_fake_<第几次请求>_<第几个>`；测试想按调用编号查库时自己写上。列表里写两项，就是「这一轮同时发两个工具调用」。 |
| `delay` | 先等这么多秒再回，用来测「执行者正在运行时」发生的事，例如运行中途的用户直接写入。 |
| `status` | 回一个错误状态码，例如 `503`，用来测自动重试。这时 `error_body` 是错误说明的文字。 |

`text` 与 `tool_calls` 可以同时写。两样都不写时，回一段空文字。

pi 实测用的是流式请求（请求体里 `stream` 为真），假端点按 SSE 逐块发，最后一块是 `data: [DONE]`。非流式请求也支持，回一个完整的 `chat.completion` 对象。

## 脚本的格式

脚本是一个 dict，也可以直接是一个列表（等于只写了 `sequence`）：

```json
{
  "rules": [
    {"when": {"last_role": "tool", "last_contains": "被拒"}, "reply": {"text": "我改一下。"}, "max_uses": 1}
  ],
  "sequence": [
    {"tool_calls": [{"name": "create_task", "arguments": {"definition_path": "docs/task-definitions/srs-authoring.json"}, "id": "call-create"}]},
    {"text": "任务已经建好了。"}
  ],
  "default": {"text": "好的。"}
}
```

每来一个请求，假端点按下面的次序挑回答：

1. 先按先后试 `rules`。第一条条件全部满足、而且没有用完次数（`max_uses`，不写就不限次数）的规则给出回答。
   在 Python 里直接用假端点时，规则可以不写 `reply` 而写 `reply_from`：一个函数，拿到请求体，返回回答。回答要引用请求里才有的东西（例如提示里某句话的会话条目编号）时用它。
2. 规则都不满足时，从 `sequence` 里取下一条。
3. `sequence` 也用完了，就回 `default`；没写 `default` 时回一句「好的。」。

规则的条件（`when`）只看这个请求本身的事实，没写的条件不管：

| 条件 | 满足的意思 |
|---|---|
| `request_no` | 这是第几个请求，从 1 起。 |
| `last_role` | 请求里最后一条消息的角色，例如 `user`、`tool`。工具结果回到模型时，最后一条消息的角色是 `tool`。 |
| `last_contains` | 最后一条消息的文字包含这段文字。 |
| `any_contains` | 请求里任意一条消息的文字包含这段文字。 |

在 Python 里用，脚本直接写成 dict 或列表传给 `FakeModel`；写成 JSON 文件，是给下面的手工启动用的。

## 请求记录

每个请求追加一行到请求记录文件（jsonl），这一行有四项：

- `序号`：第几个请求。
- `请求体`：pi 发来的请求体原样，包括完整的消息列表与工具清单。
- `回答`：假端点这次回了什么。
- `按哪一条给的`：这次回答来自哪里，例如「rules 第 1 条」「sequence 的下一条」「default」。

测试用 `fake.requests()` 读回全部记录，据此断言「模型看到了什么」。例如工具拒绝之后的下一个请求里，最后一条消息就是那条工具结果，拒绝理由的原文就在里面。

手工查看的命令：

```bash
python3 -c "import json,sys
for l in open(sys.argv[1]):
    r=json.loads(l); print(r['序号'], r['按哪一条给的'], [m['role'] for m in r['请求体']['messages']])" 请求记录.jsonl
```

## 每个测试用自己的实例

`FakeModel(...).start()` 不给端口时绑 0 号端口，由操作系统挑一个空闲端口，`fake.base_url` 给出地址。每个测试起自己的实例，不与别的测试共用。实测时吃过亏：两个实验共用一个假端点，会互相覆盖对方的脚本。

pi 这一侧用 `write_agent_dir(目录, fake.base_url)` 写一个配置目录，里面的 `models.json` 只登记假端点这一家模型服务（服务名 `fake`，模型编号 `fake-model`）。启动 pi 时把环境变量 `PI_CODING_AGENT_DIR` 设成这个目录，`--model` 写 `fake/fake-model`。本机用户目录下 pi 的全局配置一概不碰。

## 怎样新写一个集成测试

照 `server/tests/integration/test_rpc_with_fake_model.py` 里的样子写。试验台 `rig.py` 的 `Rig` 一次备齐以下几样：

- 一个从起始文件复制出来的空任务目录；
- 一个自己的假端点；
- 一个只认假端点的 pi 配置目录；
- 一个经产品自己的会话类 `PiSession` 以 RPC 方式启动的 pi 进程。

pi 进程加载 agent 扩展，工具白名单取开发用启动配置里的那一份，不加载 Langfuse 插件。

```python
from tests.integration.rig import Rig, call, tool_results

script = [
    {"tool_calls": [call("create_task", {"definition_path": "docs/task-definitions/srs-authoring.json"}, "call-1")]},
    {"text": "建好了。"},
]
with Rig(script) as rig:
    events = rig.say("帮我整理一份需求规格说明。")      # 经 RPC 发一句话，收齐到 agent_settled 为止
    tasks = rig.rows("SELECT task_id, call_id FROM task")  # 只读查 task.sqlite
    requests = rig.requests()                              # 假端点记下的请求
assert tasks[0]["call_id"] == "call-1"
```

出了 `with` 块，pi 与假端点都会停掉，临时目录也会删掉。写测试时守三条：

1. **断言只看事实。** 事实指库里的行、`tool_results(events)` 给出的工具结果、`rig.session_entries()` 给出的会话文件条目，以及 `rig.requests()` 给出的请求体。不断言对话是否按脚本走。
2. **每个测试从空任务目录开始，单独可跑。** 测试之间不共用任何东西。
3. **需要测试专用扩展时用 `extra_extensions` 加上。** 例如「用户直接写入」一条加的是 `rig.py` 里的 `USER_WRITE_EXTENSION`。

想事后查看某次运行的任务目录、事件流与请求记录，运行前设环境变量 `TASKWRIGHT_IT_KEEP=1`，试验台会保留临时目录，并把路径打印出来：

```bash
TASKWRIGHT_IT_KEEP=1 python3 -m pytest server/tests/integration -q -s -k 用户直接写入
```

保留下来的目录里有这几样：

- `ws/`：任务目录，含 `task.sqlite`。
- `fake_requests.jsonl`：请求记录。
- `runs/pi-events/`：原始事件流与后端补记。
- `runs/pi-sessions/`：pi 的会话文件。
- `pi-agent/`：测试用的 pi 配置目录。

## 手工起一个假端点

```bash
python3 -m taskwright_server.fake_model --script 脚本.json --log 请求记录.jsonl --agent-dir /tmp/fake-agent
```

启动后，终端会打印假端点的地址与配置目录。另开一个终端，用 `PI_CODING_AGENT_DIR=/tmp/fake-agent pi --model fake/fake-model ...` 启动 pi 即可。按 Ctrl+C 停掉假端点。
