/**
 * 已有任务的只读对照：不起任何后端服务，在进程内分别调用两版的扫描、列表与拼装函数，逐项比较输出。
 *
 * 用法：
 *   node backend/compare/read_only.mts --tasks <已有的任务目录> --runs <已有的归档目录> [--out 结果.json]
 *
 * 用在已有的、不能写的任务数据上：两版的库一律只读打开；占用标记的写入换成不写文件的版本（不接手、不覆盖、不删），
 * 所以正被别的服务占着的任务照样能读出任务页。比较的内容：任务列表、每个任务的任务页、会话列表、修订日志、
 * 每个条目的修订史、按最新修订生成的文档。输出不做归一化，时刻与编号都要逐字相同。
 * Python 版经子进程调用（代码写在下面的 PY 里），TypeScript 版在本进程里调用。
 */

import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import * as library from "../src/library.ts";
import * as render from "../src/render.ts";
import { Service, wordsLocator } from "../src/service.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

const PY = `
import json, sys
from pathlib import Path
from taskwright_server.service import app, library, occupancy, render
from taskwright_server.service.errors import ApiError
occupancy.claim = lambda task_dir, port: None      # 只读对照：不写占用标记
occupancy.release = lambda task_dir: None
real_stdout, sys.stdout = sys.stdout, sys.stderr   # 扫描时打印的提示走标准错误，标准输出只放结果
service = app.Service(Path(sys.argv[1]), Path(sys.argv[2]), {}, port=None)

def attempt(fn):
    try:
        return {"ok": fn()}
    except ApiError as e:
        return {"error": e.body()}
    except Exception as e:
        return {"exception": type(e).__name__ + ": " + str(e)}

out = {"tasks": attempt(service.list_tasks), "each": {}}
for task_id, t in sorted(service.tasks.items()):
    one = {"page": attempt(lambda: service.task_page(t)), "sessions": attempt(t.executor.list_sessions),
           "log": attempt(lambda: service.revision_log(t))}
    page = one["page"].get("ok") or {}
    one["items"] = {i["item_id"]: attempt(lambda i=i: library.item_revisions(t.dir, i["item_id"])) for i in page.get("items") or []}
    def document():
        conn = library.open_ro(t.dir)
        try:
            data = library.read_all(conn)
        finally:
            conn.close()
        return render.render(t.dir, library.Library(data), None, None, app.words_locator(t))
    one["document"] = attempt(document)
    out["each"][task_id] = one
real_stdout.write(json.dumps(out, ensure_ascii=False))
`;

function attempt(fn: () => unknown) {
  try {
    return { ok: fn() };
  } catch (error: any) {
    if (typeof error?.body === "function") return { error: error.body() };
    return { exception: `${error?.name}: ${error?.message}` };
  }
}

function typescriptSide(tasks: string, runs: string) {
  const service = new Service(tasks, runs, {}, { claim: () => null, release: () => {}, createTasksDir: false });
  const out: Record<string, any> = { tasks: attempt(() => service.listTasks()), each: {} };
  for (const [taskId, t] of [...service.tasks].sort((a, b) => library.byCodePoint(a[0], b[0]))) {
    const one: Record<string, any> = {
      page: attempt(() => service.taskPage(t)), sessions: attempt(() => t.sessions.list()), log: attempt(() => service.revisionLog(t)),
    };
    const items = (one.page.ok?.items ?? []) as { item_id: string }[];
    one.items = Object.fromEntries(items.map((i) => [i.item_id, attempt(() => library.itemRevisions(t.dir, i.item_id))]));
    one.document = attempt(() => render.render(t.dir, library.libraryOf(t.dir), null, null, wordsLocator(t)));
    out.each[taskId] = one;
  }
  return out;
}

function pythonSide(tasks: string, runs: string) {
  const done = spawnSync(process.env.TASKWRIGHT_PYTHON || "python3", ["-c", PY, tasks, runs], {
    encoding: "utf-8", maxBuffer: 512 * 1024 * 1024, windowsHide: true,
    env: { ...process.env, PYTHONPATH: [join(ROOT, "server"), join(ROOT, "observatory")].join(":") },
  });
  if (done.status !== 0) throw new Error(`Python 一侧失败：${done.stderr}`);
  return JSON.parse(done.stdout);
}

/** 键按字母排好之后的 JSON（键的先后不算差异）。 */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((k) => [k, canonical((value as any)[k])]));
  return value;
}

function diff(a: unknown, b: unknown, path: string, out: [string, unknown, unknown][]): void {
  if (JSON.stringify(canonical(a)) === JSON.stringify(canonical(b))) return;
  if (Array.isArray(a) && Array.isArray(b)) {
    for (let i = 0; i < Math.max(a.length, b.length); i++) diff(a[i], b[i], `${path}[${i}]`, out);
    return;
  }
  if (a && b && typeof a === "object" && typeof b === "object" && !Array.isArray(a) && !Array.isArray(b)) {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) diff((a as any)[k], (b as any)[k], `${path}.${k}`, out);
    return;
  }
  out.push([path, a, b]);
}

const { values } = parseArgs({ options: { tasks: { type: "string" }, runs: { type: "string" }, out: { type: "string" } }, strict: true });
if (!values.tasks || !values.runs) {
  process.stderr.write("用法：node backend/compare/read_only.mts --tasks <任务目录> --runs <归档目录> [--out 结果.json]\n");
  process.exit(2);
}
const py = pythonSide(values.tasks, values.runs);
const ts = typescriptSide(values.tasks, values.runs);
const sections: [string, unknown, unknown][] = [["任务列表", py.tasks, ts.tasks]];
for (const taskId of [...new Set([...Object.keys(py.each), ...Object.keys(ts.each)])].sort(library.byCodePoint)) {
  for (const key of ["page", "sessions", "log", "items", "document"]) {
    sections.push([`${taskId} ${{ page: "任务页", sessions: "会话列表", log: "修订日志", items: "条目修订史", document: "生成文档" }[key]}`, py.each[taskId]?.[key], ts.each[taskId]?.[key]]);
  }
}
let same = 0;
const report = [];
for (const [label, a, b] of sections) {
  const differences: [string, unknown, unknown][] = [];
  diff(a, b, "", differences);
  if (!differences.length) same += 1;
  const kind = a && typeof a === "object" ? Object.keys(a as object)[0] : "缺";
  report.push({ label, same: !differences.length, kind, differences });
  process.stdout.write(`${differences.length ? "差异" : "一致"}  ${label}（${kind}）\n`);
  for (const [path, x, y] of differences.slice(0, 20)) {
    process.stdout.write(`      ${path}\n        Python: ${JSON.stringify(x)?.slice(0, 300)}\n        TS:     ${JSON.stringify(y)?.slice(0, 300)}\n`);
  }
}
process.stdout.write(`\n共 ${sections.length} 项，一致 ${same} 项，有差异 ${sections.length - same} 项。\n`);
if (values.out) writeFileSync(values.out, JSON.stringify({ report, python: py, typescript: ts }, null, 2) + "\n", "utf-8");
process.exit(same === sections.length ? 0 : 1);
