/**
 * 生成观测台测试用的三个小包（observatory/taskwright_observatory/tests/fixtures/packs/）：
 * - diag-full.taskwright.zip：完整诊断包；
 * - diag-redacted.taskwright.zip：脱敏诊断包；
 * - data.taskwright.zip：普通数据包（一个任务实例，不带事件归档）。
 *
 * 做法与观测台对照测试相同（fixtures/expected/observatory.ts 的 runConversation）：起后端与假模型端点，建任务实例、放一份输入资料、
 * 说一句话；假模型先读这份输入资料，再保存一次修订（来源摘录取自输入资料），最后回复。跑完停掉后端，用 data_pack.ts 的
 * exportPack 导出三个包。要本机有 pi。
 *
 * 包要进公开仓：导出之后把包里记下的本机路径换成中性写法（代码仓根目录换成 /opt/taskwright，pi 的位置换成
 * /usr/local/bin/pi，其余家目录换成 ~），并照改后的内容更新清单文件里各文件的字节数与校验值（见 SCRUB）。
 *
 * 再生：在代码仓根目录运行 `node backend/tests/fixtures/make_observatory_packs.mts`，会覆盖那三个文件。
 * 包里的时刻、编号随每次生成变；观测台的测试只核对结构与几句固定的话，不比对整包。
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { exportPack } from "../../src/data_pack.ts";
import { which } from "../../src/launch.ts";
import { ROOT } from "../helpers.ts";
import { locations } from "../pack_stack.ts";
import { runConversation } from "./expected/observatory.ts";

const INTENT = '```json\n{"acts": [{"function": "request", "confidence": "high", "summary": "照用户说的做"}]}\n```';
/** 输入资料里的那一句（runConversation 放进去的「材料.md」的全文）。 */
const SOURCE = { kind: "文档原文", locator: "inputs/材料.md", excerpt: "买家可以申请退货。" };
const TOPIC = { 标题: "退货申请", 它是什么: "买家可以申请退货。", 例子: ["买家可以申请退货。"], 标签: ["流程"], 状态: "在用" };
const SCRIPT = [
  { text: INTENT, tool_calls: [{ name: "read", arguments: { path: "inputs/材料.md" } }] },
  { tool_calls: [{ name: "save_revision", arguments: { operations: [{ op: "add", collection: "业务说明", fields: TOPIC, sources: [SOURCE] }] } }] },
  { tool_calls: [{ name: "reply", arguments: { informs: [], act: null, text: "读完了，存好了。" } }] },
];
/** 诊断包里的设置摘录用的设置：一个本地模型服务，地址是示例写法。 */
const SETTINGS = { version: 2, selection: { language: null, embedding: null },
  providers: { "taskwright-ollama": { kind: "ollama", purpose: "language", name: "ollama", base_url: "http://models.example.test:11434", models: [] } } };

/** 重写一个包：各文件里的本机路径按 argv 给的几对换掉，清单文件里各文件的字节数与校验值照新内容改。 */
const SCRUB = `
import hashlib, json, sys, zipfile
source, target, pairs = sys.argv[1], sys.argv[2], json.loads(sys.argv[3])
with zipfile.ZipFile(source) as old:
    entries = [(info, old.read(info.filename)) for info in old.infolist()]
changed = {}
for i, (info, data) in enumerate(entries):
    new = data
    for a, b in pairs:
        new = new.replace(a.encode(), b.encode())
    if new != data:
        entries[i] = (info, new)
        changed[info.filename] = new
for i, (info, data) in enumerate(entries):
    if info.filename == "manifest.json":
        manifest = json.loads(data)
        for one in manifest.get("files", []):
            if one["path"] in changed:
                one["bytes"] = len(changed[one["path"]]); one["sha256"] = hashlib.sha256(changed[one["path"]]).hexdigest()
        entries[i] = (info, (json.dumps(manifest, ensure_ascii=False, indent=2) + "\\n").encode())
with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED) as new_zip:
    for info, data in entries:
        new_zip.writestr(info, data, compress_type=zipfile.ZIP_DEFLATED)
`;

const OUT = join(ROOT, "observatory", "taskwright_observatory", "tests", "fixtures", "packs");
const root = mkdtempSync(join(tmpdir(), "obs-packs-"));
try {
  const [archive] = await runConversation(root, SCRIPT);
  const taskId = basename(archive);
  const where = locations(root);
  mkdirSync(OUT, { recursive: true });
  const made = join(root, "out");
  mkdirSync(made, { recursive: true });
  const packs: [string, Parameters<typeof exportPack>[1]][] = [
    ["diag-full.taskwright.zip", { scope: "task", taskId, to: join(made, "diag-full.taskwright.zip"),
      diagnostic: { settings: SETTINGS as any, logsDir: join(root, "logs") } }],
    ["diag-redacted.taskwright.zip", { scope: "task", taskId, to: join(made, "diag-redacted.taskwright.zip"),
      diagnostic: { settings: SETTINGS as any, logsDir: join(root, "logs"), redact: true } }],
    ["data.taskwright.zip", { scope: "task", taskId, to: join(made, "data.taskwright.zip") }],
  ];
  for (const [name, options] of packs) {
    await exportPack(where, options);
    const pi = which("pi");
    const pairs = [[ROOT, "/opt/taskwright"], ...(pi ? [[pi, "/usr/local/bin/pi"]] : []), [homedir(), "~"]];
    const done = spawnSync(process.env.TASKWRIGHT_PYTHON || "python3", ["-c", SCRUB, options.to, join(OUT, name), JSON.stringify(pairs)], { encoding: "utf-8" });
    if (done.status !== 0) throw new Error(`重写包没有成功：${done.stderr}`);
    console.log(`写好了 ${join(OUT, name)}`);
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}
