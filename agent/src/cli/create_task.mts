/**
 * 创建任务的命令行入口：不经 pi，也不经模型。
 *
 * 2026-09-21 起任务由用户在界面上创建，执行者没有「创建任务」工具。后端（server/taskwright_server/create_task.py）
 * 建好任务目录、放好起始文件之后，起一个 Node 子进程运行本文件，由它调用与工具相同的核心函数
 * lib/create_task.ts 的 createTask 写任务记录。写库的入口因此仍只在 agent 的代码里。
 *
 * 用法：
 *   node cli/create_task.mts --dir <任务目录> --definition <任务定义相对任务目录的路径>
 *        --op-id <后端生成的操作编号，ui- 开头> [--name <任务名>] [--tag <领域标签>] [--task-id <任务编号>]
 *
 * 结果写到标准输出，一行 JSON：成功是 {"ok": true, "task_id", "task_name", "task_type", "domain_tag", "event_seq"}，
 * 退出码 0；失败是 {"ok": false, "error": "给人看的一句中文"}，退出码 1。发起方记「用户」；
 * 这时还没有任何 pi 会话，事件与任务行的会话编号为空文字。
 */

import { parseArgs } from "node:util";
import { createTask } from "../lib/create_task.ts";
import { ACTOR_USER } from "../lib/db.ts";

/** 用户操作编号的前缀，与后端和不变式核对里的约定一致。 */
const OPERATION_PREFIX = "ui-";

function fail(message: string): never {
  process.stdout.write(JSON.stringify({ ok: false, error: message }) + "\n");
  process.exit(1);
}

let values: Record<string, string | undefined>;
try {
  ({ values } = parseArgs({
    options: {
      dir: { type: "string" },
      definition: { type: "string" },
      "op-id": { type: "string" },
      name: { type: "string" },
      tag: { type: "string" },
      "task-id": { type: "string" },
    },
    strict: true,
  }) as { values: Record<string, string | undefined> });
} catch (error) {
  fail(`命令行参数不对：${(error as Error).message}`);
}

const missing = ["dir", "definition", "op-id"].filter((key) => !values[key]);
if (missing.length > 0) fail(`缺少参数：${missing.map((key) => `--${key}`).join("、")}。`);
if (!values["op-id"]!.startsWith(OPERATION_PREFIX)) {
  fail(`--op-id 应当是后端生成的操作编号，以 ${OPERATION_PREFIX} 开头，现在是「${values["op-id"]}」。`);
}

try {
  const outcome = createTask(
    { workspaceDir: values.dir!, sessionId: "", callId: values["op-id"]!, actor: ACTOR_USER },
    { definition_path: values.definition!, task_name: values.name ?? null, domain_tag: values.tag ?? null, task_id: values["task-id"] ?? null },
  );
  const d = outcome.details;
  process.stdout.write(
    JSON.stringify({
      ok: true,
      task_id: d.task_id,
      task_name: d.task_name,
      task_type: d.task_type,
      domain_tag: d.domain_tag,
      event_seq: d.event_seq,
    }) + "\n",
  );
} catch (error) {
  fail((error as Error).message);
}
