/**
 * 双跑对照：对两个后端执行同一串读取一侧的操作，把每个响应归一化之后逐条比较，输出一致或差异清单。
 *
 * 用法：
 *   node backend/compare/compare.mts --a http://127.0.0.1:8960 --a-tasks <A 的任务目录> --a-runs <A 的归档目录>
 *                                    --b http://127.0.0.1:8961 --b-tasks <B 的任务目录> --b-runs <B 的归档目录> [--out 结果.json]
 *
 * 两个后端各自用自己的、只放本次新建任务的任务目录与归档目录；不要把已有的任务目录交给它们。
 * 操作序列：建任务（含两种出错）、上传三种材料（含重名与五种出错）、经造数夹具写入修订与会话文件（夹具在 agent 的测试目录里，
 * 用真实的写入函数）、加一个被别的服务占用的任务与一个旧格式的任务、读任务列表、任务页、会话列表、条目修订史、修订日志、
 * 材料内容与原样、生成文档的预览与下载，以及错误路径各一例。
 *
 * 归一化规则（两边都做）：
 * 1. 任务编号（TASK-年月日-四位）按首次出现的先后换成 TASK-1、TASK-2……；
 * 2. 带时区的时刻（年-月-日T时:分:秒±时:分）换成「<时刻>」，库里的本地时刻（年-月-日T时:分:秒.毫秒）换成「<库时刻>」，
 *    界面修改出处里的「年-月-日 时:分」换成「<分钟>」；时刻相等与否由旧库的进程内对照核对（read_only.mts）；
 * 3. 任务目录与归档目录的绝对路径换成「<任务根>」「<归档根>」；
 * 4. 占用标记里的进程号换成「<进程号>」；后端生成的操作编号 ui-op-十二位 换成「ui-op-<编号>」；
 * 5. JSON 响应按键名排序后比较（键的先后不算差异）；非 JSON 响应比较内容类型与归一化后的正文。
 * 响应头只比状态码、Content-Type、Content-Disposition。
 */

import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { refundRulesDocx } from "./docx_fixture.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SEED = join(ROOT, "agent", "tests", "fixtures", "seed_compare_task.mts");
const CREATE_CLI = join(ROOT, "agent", "src", "cli", "create_task.mts");

interface Side { name: string; url: string; tasks: string; runs: string }
interface Reply { status: number; headers: Record<string, string | string[] | undefined>; body: Buffer }

/** 发一个请求（node:http，不用 fetch）。 */
function call(base: string, method: string, path: string, body?: Buffer | string, headers: Record<string, string> = {}): Promise<Reply> {
  return new Promise((done, fail) => {
    const url = new URL(path, base);
    const data = body === undefined ? undefined : Buffer.isBuffer(body) ? body : Buffer.from(body, "utf-8");
    const req = request(url, { method, headers: { ...headers, ...(data ? { "Content-Length": String(data.length) } : {}) } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => done({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on("error", fail);
    });
    req.on("error", fail);
    req.end(data);
  });
}

function multipart(filename: string, content: Buffer): [Buffer, Record<string, string>] {
  const boundary = "----taskwright-compare";
  const head = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`, "utf-8");
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`, "utf-8");
  return [Buffer.concat([head, content, tail]), { "Content-Type": `multipart/form-data; boundary=${boundary}` }];
}

// ───────────── 归一化 ─────────────

class Normalizer {
  private ids = new Map<string, string>();
  private side: Side;
  constructor(side: Side) {
    this.side = side;
  }

  text(value: string): string {
    let out = value;
    for (const [path, label] of [[resolve(this.side.tasks), "<任务根>"], [resolve(this.side.runs), "<归档根>"]] as const) out = out.split(path).join(label);
    out = out.replace(/TASK-\d{8}-[0-9A-F]{4}/g, (id) => {
      if (!this.ids.has(id)) this.ids.set(id, `TASK-${this.ids.size + 1}`);
      return this.ids.get(id)!;
    });
    out = out.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}/g, "<时刻>");
    out = out.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}/g, "<库时刻>");
    out = out.replace(/第 (\d+) 次修改（\d{4}-\d{2}-\d{2} \d{2}:\d{2}）/g, "第 $1 次修改（<分钟>）");
    out = out.replace(/ui-op-[0-9a-f]{12}/g, "ui-op-<编号>");
    return out;
  }

  value(value: unknown, key = ""): unknown {
    if (typeof value === "string") return this.text(value);
    if (Array.isArray(value)) return value.map((v) => this.value(v));
    if (value !== null && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(value).sort()) out[k] = key === "occupied" && k === "pid" ? "<进程号>" : this.value((value as any)[k], k);
      return out;
    }
    return value;
  }

  reply(r: Reply) {
    const type = String(r.headers["content-type"] ?? "");
    const disposition = r.headers["content-disposition"] ? this.text(String(r.headers["content-disposition"])) : null;
    let body: unknown;
    if (type.startsWith("application/json")) {
      try {
        body = this.value(JSON.parse(r.body.toString("utf-8")));
      } catch {
        body = { 不是合法的JSON: this.text(r.body.toString("utf-8")) };
      }
    } else if (/^text\//.test(type)) body = this.text(r.body.toString("utf-8"));
    else body = { 字节数: r.body.length, 摘要: r.body.toString("base64").slice(0, 64) };
    return { status: r.status, content_type: type.replace(/;\s*/, "; "), content_disposition: disposition, body };
  }
}

/** 两个归一化后的值的差异：[路径, A 的值, B 的值]。 */
function diff(a: unknown, b: unknown, path = ""): [string, unknown, unknown][] {
  if (JSON.stringify(a) === JSON.stringify(b)) return [];
  if (Array.isArray(a) && Array.isArray(b)) {
    const out: [string, unknown, unknown][] = [];
    for (let i = 0; i < Math.max(a.length, b.length); i++) out.push(...diff(a[i], b[i], `${path}[${i}]`));
    return out;
  }
  if (a && b && typeof a === "object" && typeof b === "object" && !Array.isArray(a) && !Array.isArray(b)) {
    const out: [string, unknown, unknown][] = [];
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) out.push(...diff((a as any)[k], (b as any)[k], path ? `${path}.${k}` : k));
    return out;
  }
  return [[path || "（整体）", a, b]];
}

// ───────────── 操作序列 ─────────────

type Step = { label: string; run: (side: Side, state: Record<string, string>) => Promise<Reply> };

function node(args: string[]): void {
  const done = spawnSync(process.execPath, args, { encoding: "utf-8", windowsHide: true });
  if (done.status !== 0) throw new Error(`子进程失败：${args.join(" ")}\n${done.stdout}\n${done.stderr}`);
}

const MD = Buffer.from("# 退款需求\n\n买家在收货后七天内可以申请退款。\r\n退款由平台审核。\n", "utf-8");
const TXT = Buffer.from("会议纪要\n退款金额原路退回。\n", "utf-8");
const json = (value: unknown): [string, Record<string, string>] => [JSON.stringify(value), { "Content-Type": "application/json" }];
const get = (label: string, path: (s: Record<string, string>) => string): Step =>
  ({ label, run: (side, s) => call(side.url, "GET", path(s)) });
const post = (label: string, path: (s: Record<string, string>) => string, body: unknown, raw = false): Step =>
  ({ label, run: (side, s) => {
    const [data, headers] = raw ? [String(body), { "Content-Type": "application/json" }] : json(body);
    return call(side.url, "POST", path(s), data, headers);
  } });
const upload = (label: string, filename: string, content: Buffer): Step =>
  ({ label, run: (side, s) => {
    const [data, headers] = multipart(filename, content);
    return call(side.url, "POST", `/api/v1/tasks/${s.task}/materials`, data, headers);
  } });
const T = (s: Record<string, string>) => `/api/v1/tasks/${s.task}`;
const enc = encodeURIComponent;

const STEPS: Step[] = [
  get("任务类型", () => "/api/v1/task-types"),
  get("任务列表（空）", () => "/api/v1/tasks"),
  post("建任务", () => "/api/v1/tasks", { task_type: "srs-authoring", task_name: "  跨境电商退款  ", domain_tag: "电商" }),
  post("建任务：没有这种任务类型", () => "/api/v1/tasks", { task_type: "no-such-type" }),
  post("建任务：请求体不是 JSON", () => "/api/v1/tasks", "{不是json", true),
  post("建任务：请求体不是对象", () => "/api/v1/tasks", "[1, 2]", true),
  upload("上传 .md", "需求说明.md", MD),
  upload("上传 .txt", "会议纪要.txt", TXT),
  upload("上传 .docx", "退款规则.docx", refundRulesDocx()),
  upload("上传重名文件（加 -2）", "需求说明.md", MD),
  upload("上传：类型不支持", "报价.pdf", Buffer.from("%PDF")),
  upload("上传：投影保留名", "退款规则.docx.txt", TXT),
  upload("上传：损坏的 .docx", "坏文件.docx", Buffer.from("不是 zip")),
  upload("上传：文件名带路径", "../越界.md", MD),
  upload("上传：超过 5 MB", "大文件.md", Buffer.alloc(5 * 1024 * 1024 + 10, 0x61)),
  { label: "上传：请求里没有文件", run: (side, s) => call(side.url, "POST", `/api/v1/tasks/${s.task}/materials`, "abc", { "Content-Type": "text/plain" }) },
  { label: "（造数：修订、界面操作、评审、会话文件；占用中与旧格式各一个任务）", run: async (side, s) => {
    node([SEED, "seed", join(side.tasks, s.task), side.runs]);
    const occupied = join(side.tasks, "TASK-20260101-0CC0");
    cpSync(join(ROOT, "task-types", "srs-authoring"), occupied, { recursive: true });
    node([CREATE_CLI, "--dir", occupied, "--definition", "docs/task-definitions/srs-authoring.json", "--op-id", "ui-op-compare", "--name", "别人的任务", "--task-id", "TASK-20260101-0CC0"]);
    // 被同一台主机上活着的进程（1 号进程）占用：两个后端都不接手它。
    writeFileSync(join(occupied, "service.lock"), JSON.stringify({ port: 9999, pid: 1, started_at: "2026-01-01T00:00:00", host: hostname() }) + "\n");
    node([SEED, "old-format", join(side.tasks, "TASK-20250101-01D0")]);
    return { status: 0, headers: {}, body: Buffer.from("") };
  } },
  get("任务列表（含占用中、旧格式）", () => "/api/v1/tasks"),
  get("任务页", T),
  get("会话列表", (s) => `${T(s)}/sessions`),
  get("条目修订史 UC-001", (s) => `${T(s)}/items/UC-001/revisions`),
  get("条目修订史 CON-002（删过又恢复）", (s) => `${T(s)}/items/CON-002/revisions`),
  get("条目修订史：没有这个条目", (s) => `${T(s)}/items/UC-999/revisions`),
  get("修订日志", (s) => `${T(s)}/revisions`),
  get("材料内容 .md", (s) => `${T(s)}/materials/content?path=${enc("inputs/需求说明.md")}`),
  get("材料内容 .txt", (s) => `${T(s)}/materials/content?path=${enc("inputs/会议纪要.txt")}`),
  get("材料内容 .docx（投影）", (s) => `${T(s)}/materials/content?path=${enc("inputs/退款规则.docx")}`),
  get("材料内容：越出材料目录", (s) => `${T(s)}/materials/content?path=${enc("inputs/../task.sqlite")}`),
  get("材料内容：没有这份材料", (s) => `${T(s)}/materials/content?path=${enc("inputs/没有.md")}`),
  get("材料内容：不带 path", (s) => `${T(s)}/materials/content`),
  get("材料原样 .docx", (s) => `${T(s)}/materials/raw?path=${enc("inputs/退款规则.docx")}`),
  get("材料原样 .md", (s) => `${T(s)}/materials/raw?path=${enc("inputs/需求说明-2.md")}`),
  post("文档预览（最新修订）", (s) => `${T(s)}/documents/preview`, {}),
  post("文档预览（修订 3）", (s) => `${T(s)}/documents/preview`, { revision_no: 3 }),
  post("文档预览（只列两个条目）", (s) => `${T(s)}/documents/preview`, { items: ["UC-001", "DN-001"] }),
  post("文档预览：修订号超过最新", (s) => `${T(s)}/documents/preview`, { revision_no: 99 }),
  post("文档预览：那时不在的条目", (s) => `${T(s)}/documents/preview`, { revision_no: 1, items: ["CON-002"] }),
  post("文档预览：修订号写错", (s) => `${T(s)}/documents/preview`, { revision_no: "三" }),
  post("文档预览：格式不支持", (s) => `${T(s)}/documents/preview`, { format: "html" }),
  post("文档下载", (s) => `${T(s)}/documents/download`, {}),
  get("打开被占用的任务", () => "/api/v1/tasks/TASK-20260101-0CC0"),
  get("打开旧格式的任务", () => "/api/v1/tasks/TASK-20250101-01D0"),
  get("打开没有的任务", () => "/api/v1/tasks/TASK-20990101-FFFF"),
  get("没有这个接口", () => "/api/v1/nothing"),
  get("路径末尾带斜杠", () => "/api/v1/task-types/"),
  { label: "不支持的方法 PUT", run: (side) => call(side.url, "PUT", "/api/v1/tasks") },
];

// ───────────── 主流程 ─────────────

const { values } = parseArgs({
  options: {
    a: { type: "string" }, "a-tasks": { type: "string" }, "a-runs": { type: "string" },
    b: { type: "string" }, "b-tasks": { type: "string" }, "b-runs": { type: "string" },
    out: { type: "string" },
  },
  strict: true,
});
for (const k of ["a", "a-tasks", "a-runs", "b", "b-tasks", "b-runs"] as const) {
  if (!values[k]) {
    process.stderr.write(`缺少参数 --${k}。用法见文件开头的说明。\n`);
    process.exit(2);
  }
}
const sides: Side[] = [
  { name: "A", url: values.a!, tasks: values["a-tasks"]!, runs: values["a-runs"]! },
  { name: "B", url: values.b!, tasks: values["b-tasks"]!, runs: values["b-runs"]! },
];
for (const side of sides) mkdirSync(side.runs, { recursive: true });

const states = sides.map(() => ({} as Record<string, string>));
const normalizers = sides.map((side) => new Normalizer(side));
const results = [];
let same = 0;
for (const step of STEPS) {
  const got = [];
  for (let i = 0; i < sides.length; i++) {
    const reply = await step.run(sides[i], states[i]);
    if (step.label === "建任务" && reply.status === 200) states[i].task = JSON.parse(reply.body.toString("utf-8")).task_id;
    got.push(normalizers[i].reply(reply));
  }
  const differences = diff(got[0], got[1]);
  if (!differences.length) same += 1;
  results.push({ label: step.label, same: differences.length === 0, differences, a: got[0], b: got[1] });
  const mark = differences.length ? "差异" : "一致";
  process.stdout.write(`${mark}  ${step.label}（${got[0].status} / ${got[1].status}）\n`);
  for (const [path, a, b] of differences.slice(0, 20)) {
    process.stdout.write(`      ${path}\n        A: ${JSON.stringify(a)?.slice(0, 300)}\n        B: ${JSON.stringify(b)?.slice(0, 300)}\n`);
  }
}
process.stdout.write(`\n共 ${STEPS.length} 步，一致 ${same} 步，有差异 ${STEPS.length - same} 步。\n`);
if (values.out) writeFileSync(values.out, JSON.stringify(results, null, 2) + "\n", "utf-8");
process.exit(same === STEPS.length ? 0 : 1);
