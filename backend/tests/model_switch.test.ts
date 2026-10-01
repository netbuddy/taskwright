/**
 * 在界面上选定的语言模型在下一次打开或者新建会话时生效（docs/api.md §10.4）：起真的后端进程与真的 pi，模型换成进程内的假端点。
 * 先按启动配置的模型开第一条会话说一句；再经接口登记一个模型服务、勾选一个模型、选定它；新建会话、切回第一条会话，
 * 各说一句，假端点收到的请求里的模型名都应当是选定的那个（pi 新建会话时回到启动参数里的模型、切回旧会话时恢复那条会话记下的模型，
 * 后端每次都用 set_model 换过去）。最后把选定的模型改成模型登记里没有的，新建会话时照「助手不可用」的方式说明原因。
 * pi 的配置目录与产品设置文件都在本文件的临时目录里。
 */

import assert from "node:assert/strict";
import { type ChildProcess, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { join } from "node:path";
import { after, test } from "node:test";
import { writeAgentDir } from "../fake_model/agent_config.ts";
import { FakeModel } from "../fake_model/server.ts";
import { captureConsole, spawnBackend, tempDir } from "./helpers.ts";

captureConsole();

type Dict = Record<string, any>;
const tmp = tempDir();
after(() => rmSync(tmp, { recursive: true, force: true }));
const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));

const NO_PI = spawnSync("pi", ["--version"], { encoding: "utf-8" }).error ? "本机 PATH 上没有 pi" : false;
const DROPPED_ENV = ["TASKWRIGHT_LANGFUSE_PLUGIN", "TASKWRIGHT_LANGFUSE_ENV_FILE", "TASKWRIGHT_RUNS_DIR", "TASKWRIGHT_TASKS_ROOT",
  "LANGFUSE_PUBLIC_KEY", "LANGFUSE_SECRET_KEY", "LANGFUSE_BASE_URL", "LANGFUSE_TRACING_ENVIRONMENT"];

const INTENT = '```json\n{"acts": [{"function": "request", "confidence": "high", "summary": "照用户说的做"}]}\n```';
const SCRIPT = {
  rules: [{ when: { last_role: "tool" }, reply: { text: "好的。" } }],
  default: { text: INTENT, tool_calls: [{ name: "reply", arguments: { informs: [], act: null, text: "我在。" } }] },
};

test("选定的模型在新建会话与切回旧会话时生效；换不过去时说明原因", { skip: NO_PI }, async () => {
  const fake = await new FakeModel(SCRIPT, join(tmp, "fake.jsonl")).start();
  const agentDir = writeAgentDir(join(tmp, "pi-agent"), fake.baseUrl);
  const settings = join(tmp, "settings", "settings.json");
  const env: Dict = { ...process.env, PI_CODING_AGENT_DIR: agentDir, TASKWRIGHT_SETTINGS_FILE: settings, TASKWRIGHT_LOG_DIR: join(tmp, "logs"), PI_OFFLINE: "1" };
  for (const name of DROPPED_ENV) delete env[name];
  mkdirSync(join(tmp, "work"), { recursive: true });
  let child: ChildProcess | null = null;
  try {
    const started = await spawnBackend(["--tasks", join(tmp, "work", "tasks"), "--runs", join(tmp, "work", "runs"), "--profile", "fake", "--host", "127.0.0.1"], { env });
    child = started.child;
    const call = (method: string, path: string, body?: unknown) => new Promise<{ status: number; body: any }>((ok, fail) => {
      const data = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
      const req = request({ host: "127.0.0.1", port: started.port, path, method, timeout: 60000,
        headers: data ? { "Content-Type": "application/json", "Content-Length": data.length } : {} }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => ok({ status: res.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString("utf-8") || "null") }));
      });
      req.on("error", fail);
      req.on("timeout", () => req.destroy(new Error("超时")));
      req.end(data);
    });
    const sessions = async (taskId: string) => (await call("GET", `/api/v1/tasks/${taskId}/sessions`)).body.sessions as Dict[];
    const say = async (taskId: string, sessionId: string, text: string) => {
      const count = async () => (await sessions(taskId)).find((s) => s.session_id === sessionId)?.message_count ?? 0;
      const before = await count();
      const sent = await call("POST", `/api/v1/tasks/${taskId}/messages?session=${sessionId}`, { text, client_id: `c-${text}` });
      assert.equal(sent.status, 200, JSON.stringify(sent.body));
      const end = Date.now() + 60000;
      for (;;) {
        const state = (await call("GET", `/api/v1/tasks/${taskId}/snapshot`)).body.executor.state;
        if ((await count()) > before && state === "idle") return;
        if (Date.now() > end) throw new Error(`等这一轮做完超时，执行者 ${state}`);
        await sleep(100);
      }
    };
    /** 假端点最近一次收到的请求里的模型名。 */
    const lastModel = () => fake.requests().at(-1)?.请求体?.model;

    const taskId = (await call("POST", "/api/v1/tasks", { task_type: "srs-authoring", task_name: "换模型" })).body.task_id;
    const first = (await call("POST", `/api/v1/tasks/${taskId}/sessions`)).body.session_id;
    await say(taskId, first, "你好");
    assert.equal(lastModel(), "fake-model", "没有选过模型时用启动配置里的");

    // 经接口登记假端点为一个兼容 OpenAI 接口的服务，手工加一个模型 other-model 并选定它（假端点不看模型名，照样回答）。
    const added = await call("POST", "/api/v1/model-config/providers", { kind: "openai_compatible", name: "假端点", base_url: fake.baseUrl });
    assert.equal(added.status, 200, JSON.stringify(added.body));
    const id = added.body.provider.id;
    assert.equal((await call("POST", `/api/v1/model-config/providers/${id}`, { models: [{ id: "other-model", type: "language", enabled: true, context_window: 32768 }] })).status, 200);
    const picked = await call("POST", "/api/v1/model-config/selection", { language: { provider_id: id, model_id: "other-model" }, embedding: null });
    assert.equal(picked.status, 200, JSON.stringify(picked.body));
    assert.equal((await call("GET", "/api/v1/service")).body.model.name, `${id}/other-model`);

    const second = (await call("POST", `/api/v1/tasks/${taskId}/sessions`)).body.session_id;
    await say(taskId, second, "新会话里说一句");
    assert.equal(lastModel(), "other-model", "新建会话之后用选定的模型");

    assert.equal((await call("GET", `/api/v1/tasks/${taskId}/snapshot?session=${first}`)).status, 200);
    await say(taskId, first, "回到第一条会话");
    assert.equal(lastModel(), "other-model", "切回旧会话之后也用选定的模型");

    // 选定的模型在模型登记里不存在（手工改了设置文件）：新建会话时换不过去，助手不可用并说明原因。
    const value = JSON.parse(readFileSync(settings, "utf-8"));
    value.pi_dirs[agentDir].selection.language = { provider: id, model: "no-such-model" };
    writeFileSync(settings, JSON.stringify(value));
    const refused = await call("POST", `/api/v1/tasks/${taskId}/sessions`);
    assert.equal(refused.status, 503, JSON.stringify(refused.body));
    assert.equal(refused.body.error.code, "executor_unavailable");
    const executor = (await call("GET", `/api/v1/tasks/${taskId}/snapshot`)).body.executor;
    assert.equal(executor.state, "failed_to_start");
    assert.equal(executor.text, `选定的模型「${id}/no-such-model」用不了，模型登记里找不到它。请到设置的「模型」一栏检查。`);
  } finally {
    if (child && child.exitCode === null) {
      await new Promise<void>((ok) => {
        const timer = setTimeout(() => child!.kill("SIGKILL"), 20000);
        child!.once("exit", () => {
          clearTimeout(timer);
          ok();
        });
        child!.kill("SIGTERM");
      });
    }
    await fake.stop();
  }
});
