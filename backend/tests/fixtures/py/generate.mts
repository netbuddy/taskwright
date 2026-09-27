/**
 * 重新生成本目录下 Python 版输出的夹具：在 inputs.ts 的同一组输入上调用 Python 版（server/taskwright_server），把输出写进 *.json。
 *
 *   TASKWRIGHT_PYTHON=.venv/bin/python node backend/tests/fixtures/py/generate.mts
 *
 * 只在 Python 版还在代码仓里时能运行。每个文件带 source 一项：生成时 server/ 最后一次改动所在的提交与生成日期。
 * 输出里随机器与运行变化的部分先换成占位写法（仓根、临时目录、pi 的位置、操作编号、时刻、端口），测试对自己的输出做同样的替换再比较。
 */

import { type ChildProcess, execFileSync, spawn, spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { observatoryView, runConversation } from "./observatory.ts";
import { BODIES, CARDS, CARD_BODIES, CARD_ENTRIES, CONVERSATION_DEFINITION, CONVERSATION_ENTRIES, FAKE_MODEL, normalize } from "./inputs.ts";

type Dict = Record<string, any>;
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..", "..", "..");
const PYTHON = process.env.TASKWRIGHT_PYTHON || "python3";
const env = { ...process.env, PYTHONPATH: [join(ROOT, "server"), join(ROOT, "observatory")].join(":") };
const tmp = mkdtempSync(join(tmpdir(), "taskwright-py-fixtures-"));
const commit = execFileSync("git", ["-C", ROOT, "log", "-1", "--format=%h", "--", "server"], { encoding: "utf-8" }).trim();
const source = { commit, generated: new Date().toISOString().slice(0, 10), command: "node backend/tests/fixtures/py/generate.mts" };

function python(script: string, args: string[] = [], input?: string): any {
  const done = spawnSync(PYTHON, ["-c", script, ...args], { encoding: "utf-8", env, input, maxBuffer: 64 * 1024 * 1024 });
  if (done.status !== 0) throw new Error(done.stderr);
  return JSON.parse(done.stdout);
}

function write(name: string, value: Dict): void {
  writeFileSync(join(HERE, name), JSON.stringify({ source, ...value }, null, 1) + "\n", "utf-8");
  process.stdout.write(`写好了 ${name}\n`);
}

try {
  // 1. 直接操作与卡片点击发给 pi 的命令（executor.py 的 action 与 card_click）。
  const commands = python(`
import json, sys
from taskwright_server.service import executor as ex
class Hub:
    def emit(self, *a, **k): pass
    def trigger(self): pass
e = ex.Executor("TASK-001", sys.argv[1], sys.argv[2], {}, Hub())
sent = []
class Pi:
    def alive(self): return True
    def _note(self, *a, **k): pass
    def request(self, command, **fields):
        sent.append([command, fields])
        message = fields.get("message") or ""
        if command == "prompt" and message.startswith("/tw-"):
            name, body = message.split(" ", 1)
            key = "taskwright-user-result" if name == "/tw-user" else "taskwright-ui-result"
            e._handle(self, {"type": "界面请求", "method": "setStatus", "status_key": key, "status_text": json.dumps({"op_id": json.loads(body)["op_id"], "ok": True})})
        return {}
e.pi = Pi(); e.state = "idle"; e.active_session = "S1"
bodies, cards = json.loads(sys.argv[3]), json.loads(sys.argv[4])
for body in bodies:
    e.action("S1", body)
for text, annotation in cards:
    e.card_click("S1", text, "k-1", annotation)
print(json.dumps(sent, ensure_ascii=False))
`, [tmp, join(tmp, "runs"), JSON.stringify(BODIES), JSON.stringify(CARDS)]);
  write("actions.json", { commands: normalize(commands) });

  // 2. 卡片标注（app.py 的 card_annotation）。
  write("card_annotations.json", { annotations: python(`
import json, sys
from taskwright_server.service.app import card_annotation
bodies, entries = json.loads(sys.argv[1]), json.loads(sys.argv[2])
print(json.dumps([card_annotation(b, entries) for b in bodies], ensure_ascii=False))
`, [JSON.stringify(CARD_BODIES), JSON.stringify(CARD_ENTRIES)]) });

  // 3. 带过程摘要的对话记录与切出的工作（conversation.py 与 work_summary.py）。
  write("conversation.json", python(`
import json, sys
from taskwright_server.service import conversation, work_summary
data = json.load(sys.stdin)
path = conversation.branch(data['entries'])
print(json.dumps({'messages': conversation.messages(data['entries'], 'S', data['definition']),
  'works': work_summary.works_from_entries(path, data['definition'], conversation.FALLBACK_TEXT, conversation.text_of)}, ensure_ascii=False))
`, [], JSON.stringify({ entries: CONVERSATION_ENTRIES, definition: CONVERSATION_DEFINITION })));

  // 4. 启动配置 dev（只留代码仓自带的扩展）拼出的 pi 命令行（launch.py 的 build_command），任务目录是 srs-authoring 的起始文件。
  const workspace = join(tmp, "ws");
  cpSync(join(ROOT, "task-types", "srs-authoring"), workspace, { recursive: true });
  const argv: string[] = python(`
import json, sys
from pathlib import Path
from taskwright_server import launch
p = launch.load_profile('dev'); p['extensions'] = [e for e in p['extensions'] if e['source'] == 'repo']
argv, env = launch.build_command(p, Path(sys.argv[1]), Path(sys.argv[2]), Path(sys.argv[3]))
print(json.dumps(argv, ensure_ascii=False))
`, [workspace, join(tmp, "sd"), join(tmp, "s.jsonl")]);
  write("launch_argv.json", { argv: normalize(["<pi>", ...argv.slice(1)], [[tmp, "<临时目录>"], [ROOT, "<仓根>"]]) });

  // 5. 假模型端点的命令行进程：同一份脚本、同一串请求的回答、请求记录与 pi 配置目录。
  write("fake_model_cli.json", await fakeModelCli());

  // 6. Python 版后端跑一段对话写出的归档，观测台读出的会话列表与会话详情（归一化之后）。
  const root = join(tmp, "observatory");
  const [archive, tasks] = await runConversation("python", root);
  write("observatory_view.json", { view: observatoryView(archive, tasks, root) });
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

async function fakeModelCli(): Promise<Dict> {
  const dir = join(tmp, "fake");
  writeFileSync(join(tmp, "fake-script.json"), JSON.stringify(FAKE_MODEL.script), "utf-8");
  const child: ChildProcess = spawn(PYTHON, ["-m", "taskwright_server.fake_model", "--script", join(tmp, "fake-script.json"), "--log", join(dir, "requests.jsonl"),
    "--port", "0", "--agent-dir", join(dir, "pi-agent")], { env });
  let out = "";
  child.stdout!.on("data", (c) => (out += c));
  const end = Date.now() + 15000;
  while (!out.includes("pi 配置目录已写好")) {
    if (child.exitCode !== null || Date.now() > end) throw new Error(`假端点没有起来：${out}`);
    await new Promise((ok) => setTimeout(ok, 30));
  }
  const baseUrl = /假端点已启动：(\S+)（只监听本机回环地址）/.exec(out)![1];
  try {
    const answers = [];
    for (const body of FAKE_MODEL.requests) {
      const got = await post(baseUrl, body);
      answers.push([got.status, got.text.replace(/"created": \d+/g, '"created": <秒>')]);
    }
    const lines = readFileSync(join(dir, "requests.jsonl"), "utf-8").replace(/"时刻": [0-9.]+/g, '"时刻": <秒>');
    const agent = ["models.json", "settings.json", "auth.json"].map((f) => readFileSync(join(dir, "pi-agent", f), "utf-8").replace(baseUrl, "<地址>"));
    return { answers, lines, agent };
  } finally {
    child.kill("SIGTERM");
    await new Promise((ok) => (child.exitCode !== null ? ok(null) : child.once("exit", ok)));
  }
}

function post(baseUrl: string, body: unknown): Promise<{ status: number; text: string }> {
  return new Promise((ok, fail) => {
    const data = Buffer.from(JSON.stringify(body));
    const req = request(`${baseUrl}/chat/completions`, { method: "POST", headers: { "Content-Type": "application/json", "Content-Length": data.length } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => ok({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf-8") }));
    });
    req.on("error", fail);
    req.end(data);
  });
}
