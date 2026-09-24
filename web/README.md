# web：任务型智能体的前端骨架

三页：任务列表页、任务页、工作视图。技术栈是 React、Ant Design、Ant Design X，用 Vite 开发与构建，接口照接口约定（docs/api.md），以及与后端对齐之后的几处补充（见本文末尾）。

## 目录

| 路径 | 是什么 |
|---|---|
| `src/api/types.ts` | 接口类型，字段名与约定逐字一致。 |
| `src/api/client.ts` | 全部 HTTP 请求都经这里发出；错误统一成 `ApiError`。组件不直接调用 fetch。 |
| `src/api/events.ts` | 事件流（SSE）的读取与解析。用 fetch 读流，重连时自己带上 `Last-Event-ID`；45 秒收不到任何东西就主动重连。 |
| `src/state/workState.ts` | 工作视图的状态与事件应用规则，是纯函数，测试直接调用。 |
| `src/state/useWorkView.ts` | 工作视图的数据来源：先连事件流，再读整份数据，之后只听事件；收到 `resync` 或发现序号缺口时重读一次整份数据。 |
| `src/pages/` | 三页。 |
| `src/components/` | 外壳、新建任务、生成文档、完成条件；`work/` 下是工作视图的对话区、卡片、条目区、条目详情、确认已失效的差异、文档区。 |
| `src/model/` | 由数据算出的状态（评审、确认、筛选）、列表字段按步骤对齐的比对、时间与数字的写法。 |
| `src/test/` | 组件测试（Vitest）。 |
| `mock/` | 假服务，以及把真实试跑归档导出成假服务数据的脚本。 |

## 怎样起

```bash
cd web
npm install

# 用假服务开发（不需要后端）
python3 mock/export_fixture.py --lab <放试跑归档的目录> --run <归档目录名>   # 把一次真实试跑导出到 mock/runtime/（不入库）
npm run mock                        # 假服务，端口 5681（环境变量 MOCK_PORT 可改）
npm run dev                         # 开发服务器，端口 5680，/api 代理到 5681

# 接真后端（后端起法见后端的说明）
TASKWRIGHT_WEB_PORT=5682 TASKWRIGHT_API_TARGET=http://127.0.0.1:8791 npm run dev
```

开发服务器绑 `0.0.0.0`，端口与代理目标都由环境变量给（`TASKWRIGHT_WEB_PORT`、`TASKWRIGHT_API_TARGET`）。

假服务有三个演示开关，只有假服务有：

- `POST /__mock/busy {"on": true}`：模拟执行者正在另一条会话里工作；
- `POST /__mock/disconnect`：断开全部事件流，用来看前端怎样重连并补发；
- `POST /__mock/resync`：给全部事件流发一条 `resync`。

## 测试

```bash
npm test          # Vitest：事件应用规则、事件流解析、列表按步骤对齐、卡片五种主行为的按钮走向、直接操作的错误显示
npm run build     # 类型检查加生产构建
```

## 几条写法约定

- **随任务定义变化的文字一律从接口取，不写死。** 这类文字包括集合名、字段名、枚举取值、完成条件名、任务类型。「先不管」按钮按取值「用户决定保留」认出它适用的集合，不按字段名认。
- **界面上的状态变化只来自事件流。** 说话、直接操作的响应只当作「接受了还是拒绝了」：接受时登记「正在保存」，等库事件到了才改界面；拒绝时就地显示原因。不做乐观更新。
- **发给执行者的话只用接口约定的固定模板**，常量在 `src/components/work/ReplyCard.tsx` 的 `TEMPLATES` 里。

## 已与后端对上的几处补充

- 说话、直接操作、停下、往前读对话这四个请求，都在路径后面带 `?session={session_id}`。
- 卡片点击时，说话的请求体多带两项：`origin: "card_choice"`，以及 `card: { reply_message_id, kind, choice }`。
- 快照里 `conversation.messages` 的每一条都有 `type` 字段。
- `user_message` 带 `client_id`；`ui_action_noted` 带 `revision_no` 与 `op_id`；`confirmation_recorded` 带 `op_id`。
- 库事件的操作种类多了 `restore`，表示撤销了一次删除。
- 新增错误码 `not_found`，新增接口 `GET /api/v1/task-types`。
- 成功响应都带 `ok: true`；列表类接口的内容放在一个键下，例如 `{ok, tasks}`、`{ok, sessions}`、`{ok, versions}`。
