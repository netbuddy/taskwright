# 假模型端点

这是 `server/taskwright_server/fake_model/` 的 TypeScript 版：一个按脚本回固定内容的本地 HTTP 服务，接口与 OpenAI 的聊天接口兼容（`POST /v1/chat/completions`），只用 `node:http`，零依赖。它给后端的双跑对照与测试用：pi 以为自己在请求模型，实际每次拿到的回答都是测试事先写好的。这样，门禁拒绝、用户直接写入这类机制可以被确定性地测，不受真模型随机性的影响。

脚本格式、命令行参数、请求记录的写法都与 Python 版相同；同一份脚本、同一串请求，两版的回答与请求记录逐字一致（`backend/tests/fake_model.test.ts` 核对）。双跑对照 `backend/compare/sessions.mts` 让两版后端都用这一版。

## 它能回什么

一条「回答」是一个对象，下面几项按需写：

| 键 | 意思 |
|---|---|
| `text` | 助手回复的文字。 |
| `tool_calls` | 工具调用的列表，每项是 `{"name": 工具名, "arguments": {参数}, "id": 调用编号}`。`id` 可以不写，不写时由假端点生成 `call_fake_<第几次请求>_<第几个>`；测试想按调用编号查库时自己写上。列表里写两项，就是「这一轮同时发两个工具调用」。 |
| `delay` | 先等这么多秒再回，用来测「执行者正在运行时」发生的事，例如运行中途的用户直接写入。 |
| `status` | 回一个错误状态码，例如 `503`，用来测自动重试。这时 `error_body` 是错误说明的文字。 |

`text` 与 `tool_calls` 可以同时写。两样都不写时，回一段空文字。

pi 实测用的是流式请求（请求体里 `stream` 为真），假端点按 SSE 逐块发，最后一块是 `data: [DONE]`。非流式请求也支持，回一个完整的 `chat.completion` 对象。

## 脚本的格式

脚本是一个对象，也可以直接是一个列表（等于只写了 `sequence`）：

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
   在代码里直接用假端点时，规则可以不写 `reply` 而写 `reply_from`：一个函数，拿到请求体，返回回答。回答要引用请求里才有的东西（例如提示里某句话的会话条目编号）时用它。
2. 规则都不满足时，从 `sequence` 里取下一条。
3. `sequence` 也用完了，就回 `default`；没写 `default` 时回一句「好的。」。

规则的条件（`when`）只看这个请求本身的事实，没写的条件不管：

| 条件 | 满足的意思 |
|---|---|
| `request_no` | 这是第几个请求，从 1 起。 |
| `last_role` | 请求里最后一条消息的角色，例如 `user`、`tool`。工具结果回到模型时，最后一条消息的角色是 `tool`。 |
| `last_contains` | 最后一条消息的文字包含这段文字。 |
| `any_contains` | 请求里任意一条消息的文字包含这段文字。 |

在代码里用，脚本直接写成对象或列表传给 `new FakeModel(脚本, 请求记录路径, { autoIntent })`；写成 JSON 文件，是给手工启动用的：

```
node backend/fake_model/main.mts --script 脚本.json --log 请求记录.jsonl [--port 0] [--agent-dir 目录]
```

`autoIntent` 为真时，用户说话之后第一个只有工具调用、没有文字的回答，前面自动补一段理解（与 Python 版的 `auto_intent` 相同）；命令行起的假端点不补。

## 请求记录

每个请求追加一行到请求记录文件（jsonl），这一行有四项：

- `序号`：第几个请求。
- `请求体`：pi 发来的请求体原样，包括完整的消息列表与工具清单。
- `回答`：假端点这次回了什么。
- `按哪一条给的`：这次回答来自哪里，例如「rules 第 1 条」「sequence 的下一条」「default」。

用 `fake.requests()` 读回全部记录，据此断言「模型看到了什么」。例如工具拒绝之后的下一个请求里，最后一条消息就是那条工具结果，拒绝理由的原文就在里面。

手工查看的命令：

```bash
node -e "for (const l of require('fs').readFileSync(process.argv[1], 'utf-8').split('\n').filter(Boolean)) {
  const r = JSON.parse(l); console.log(r['序号'], r['按哪一条给的'], r['请求体'].messages.map((m) => m.role)); }" 请求记录.jsonl
```

与 Python 版的一处传输差别：流式回答 Python 版不写长度、靠关闭连接结束，这一版用分块传输（chunked）再关闭连接；客户端读到的数据块完全相同。

## 每个测试用自己的实例

`await new FakeModel(...).start()` 不给端口时绑 0 号端口，由操作系统挑一个空闲端口，`fake.baseUrl` 给出地址。每个使用者起自己的实例，不与别人共用。实测时吃过亏：两个实验共用一个假端点，会互相覆盖对方的脚本。

pi 这一侧用 `writeAgentDir(目录, fake.baseUrl)`（`agent_config.ts`）写一个配置目录，里面的 `models.json` 只登记假端点这一家模型服务（服务名 `fake`，模型编号 `fake-model`）。启动 pi 时把环境变量 `PI_CODING_AGENT_DIR` 设成这个目录，`--model` 写 `fake/fake-model`。本机用户目录下 pi 的全局配置一概不碰。

## 手工起一个假端点

```bash
node backend/fake_model/main.mts --script 脚本.json --log 请求记录.jsonl --agent-dir /tmp/fake-agent
```

启动后，终端会打印假端点的地址与配置目录。另开一个终端，用 `PI_CODING_AGENT_DIR=/tmp/fake-agent pi --model fake/fake-model ...` 启动 pi 即可。按 Ctrl+C 停掉假端点。
