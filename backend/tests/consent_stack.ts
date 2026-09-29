/**
 * 卡片同意类集成测试共用的验证栈：起真的后端进程与真的 pi，模型换成进程内的假端点；建一个 srs-authoring 任务与一条会话，
 * 材料是 inputs/材料.md 里的一句话。complete_consent.test.ts 与 problem_consent.test.ts 共用。
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { join } from "node:path";
import { writeAgentDir } from "../fake_model/agent_config.ts";
import { FakeModel } from "../fake_model/server.ts";
import { ROOT, spawnBackend } from "./helpers.ts";

export type Dict = Record<string, any>;
export const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));

export const NO_PI = spawnSync("pi", ["--version"], { encoding: "utf-8" }).error ? "本机 PATH 上没有 pi" : false;
const DROPPED_ENV = ["TASKWRIGHT_LANGFUSE_PLUGIN", "TASKWRIGHT_LANGFUSE_ENV_FILE", "TASKWRIGHT_RUNS_DIR", "TASKWRIGHT_TASKS_ROOT",
  "LANGFUSE_PUBLIC_KEY", "LANGFUSE_SECRET_KEY", "LANGFUSE_BASE_URL", "LANGFUSE_TRACING_ENVIRONMENT"];

export const MATERIAL = "读者凭借书证在自助机上借书。";

/** 假端点的一步：助手经「回复」说一段话，act 是向用户要的回应。 */
export const reply = (text: string, id: string, act: Dict | null = null) => ({ tool_calls: [{ id, name: "reply", arguments: { informs: [], act, text } }] });

export type Stack = {
  call: (method: string, path: string, body?: unknown) => Promise<{ status: number; body: any }>;
  taskId: string; session: string; dir: string;
  db: (sql: string, ...args: string[]) => Dict[];
  send: (body: Dict) => Promise<void>;
  action: (body: Dict) => Promise<{ status: number; body: any }>;
  /** 会话文件里带某次工具调用的那条助手消息的会话条目编号（卡片点击要交它）。 */
  entryOfCall: (callId: string) => string;
};

/** 起一套验证栈（假端点、真后端、真 pi），建任务与会话，交给 body；结束时停掉。 */
export async function withStack(tmp: string, name: string, script: Dict, body: (s: Stack) => Promise<void>): Promise<void> {
  const dir = join(tmp, name);
  mkdirSync(dir, { recursive: true });
  const fake = await new FakeModel(script, join(dir, "fake.jsonl"), { autoIntent: true }).start();
  const env: Dict = { ...process.env, PI_CODING_AGENT_DIR: writeAgentDir(join(dir, "pi-agent"), fake.baseUrl), TASKWRIGHT_LOG_DIR: join(dir, "logs") };
  for (const name of DROPPED_ENV) delete env[name];
  const { child, port } = await spawnBackend(["--tasks", join(dir, "tasks"), "--runs", join(dir, "runs"), "--profile", "fake", "--host", "127.0.0.1"],
    { cwd: dir, env });
  try {
    const call = (method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> => new Promise((ok, fail) => {
      const data = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
      const req = request({ host: "127.0.0.1", port, path, method, timeout: 60000,
        headers: data ? { "Content-Type": "application/json", "Content-Length": data.length } : {} }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => ok({ status: res.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString("utf-8") || "null") }));
      });
      req.on("error", fail);
      req.on("timeout", () => req.destroy(new Error("超时")));
      req.end(data);
    });
    const taskId: string = (await call("POST", "/api/v1/tasks", { task_type: "srs-authoring", task_name: name })).body.task_id;
    writeFileSync(join(dir, "tasks", taskId, "inputs", "材料.md"), `${MATERIAL}\n`, "utf-8");
    const session: string = (await call("POST", `/api/v1/tasks/${taskId}/sessions`)).body.session_id;
    // 只读查库；评审正在写库时偶尔读不出（子进程没有输出），按空列表算：轮询接着等，断言处读不出也会因为对不上而失败。
    const db = (sql: string, ...args: string[]) => JSON.parse(spawnSync(process.execPath, ["-e",
      `const {DatabaseSync}=require("node:sqlite");const db=new DatabaseSync(process.argv[1],{readOnly:true});` +
      `console.log(JSON.stringify(db.prepare(process.argv[2]).all(...process.argv.slice(3))))`,
      join(dir, "tasks", taskId, "task.sqlite"), sql, ...args], { encoding: "utf-8" }).stdout || "[]");
    const messages = async () => (await call("GET", `/api/v1/tasks/${taskId}/sessions`)).body.sessions.find((s: Dict) => s.session_id === session)?.message_count ?? 0;
    /** 发一句话（或一次卡片点击），等这一轮做完：这条会话的消息数变多、执行者回到空闲。 */
    const send = async (body: Dict) => {
      const before = await messages();
      assert.equal((await call("POST", `/api/v1/tasks/${taskId}/messages?session=${session}`, body)).status, 200);
      for (const end = Date.now() + 60000; ;) {
        const state = (await call("GET", `/api/v1/tasks/${taskId}/snapshot`)).body.executor.state;
        if ((await messages()) > before && state === "idle") return;
        if (Date.now() > end) throw new Error(`等这一轮做完超时，执行者 ${state}`);
        await sleep(100);
      }
    };
    const action = (body: Dict) => call("POST", `/api/v1/tasks/${taskId}/actions?session=${session}`, { client_id: `a-${body.kind}`, task_id: taskId, ...body });
    const entryOfCall = (callId: string): string => {
      const sessionDir = join(dir, "runs", taskId, "pi-sessions", "service");
      const file = join(sessionDir, readdirSync(sessionDir).find((n) => n.endsWith(`_${session}.jsonl`))!);
      return readFileSync(file, "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l))
        .find((e) => e.type === "message" && (e.message?.content ?? []).some((p: Dict) => p?.type === "toolCall" && p.id === callId)).id;
    };
    await body({ call, taskId, session, dir, db, send, action, entryOfCall });
  } finally {
    if (child.exitCode === null) {
      await new Promise<void>((ok) => {
        const timer = setTimeout(() => child.kill("SIGKILL"), 20000);
        child.once("exit", () => { clearTimeout(timer); ok(); });
        child.kill("SIGTERM");
      });
    }
    await fake.stop();
  }
}
