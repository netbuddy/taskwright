/**
 * 后端测试共用的夹具。写库一律经 agent 测试目录里的夹具脚本（子进程运行，内部调用真实的写入函数），
 * 后端的代码与测试都不导入写入函数。个别测试要在夹具库的副本上补几行（模拟旧库、补事件），
 * 用 sqlRun 在临时副本上直接执行 SQL；那只是测试夹具，不是产品代码的写入路径。
 */

import { type ChildProcess, type SpawnOptions, spawn, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { format } from "node:util";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
/** 后端的入口。 */
export const BACKEND_MAIN = join(ROOT, "backend", "src", "main.mts");
const FIXTURES = join(ROOT, "agent", "tests", "fixtures");

/** 与服务端测试同一份演示任务定义：用例、待定事项两个集合。 */
export const DEMO_DEFINITION = {
  任务名: "演示任务",
  交付物: {
    名称: "演示交付物", 文档模板: "docs/templates/demo.md", 每个条目附带: "来源",
    条目集合: [
      { 名称: "用例", 编号前缀: "UC", 字段: [{ 名: "名称", 类型: "文本", 必填: true }, { 名: "步骤", 类型: "文本列表", 必填: true }] },
      { 名称: "待定事项", 编号前缀: "TBD", 字段: [
        { 名: "事项", 类型: "文本", 必填: true },
        { 名: "状态", 类型: "枚举", 必填: true, 取值: ["未解决", "已解决"] },
        { 名: "关联条目", 类型: "条目引用", 必填: false }] },
    ],
  },
  完成条件: { 用例: ["至少一个条目"], 待定事项: ["没有状态为未解决的条目"] },
  执行方法: ".pi/skills/demo/SKILL.md",
  领域规矩: ["docs/domain-knowledge/demo.md"],
};

let captured: string[] | null = null;

/**
 * 把本进程里 console 的输出（log、info、debug、dir、warn、error）收进内存，不写标准输出与标准错误；返回收到的内容，
 * 每调用一次 console 记一条，写法与 console 相同（util.format）。一个进程只接一次，再调用返回同一个数组。
 *
 * 为什么：Node 的测试框架让每个测试文件在子进程里运行，子进程经标准输出把结果数据回报给框架。测试进程里直接运行的后端代码
 * 用 console.log 写日志时，日志与结果数据在标准输出上交错，框架偶尔读坏整个文件的结果（Unable to deserialize cloned data），
 * 与断言无关。凡是在测试进程里运行会写日志的后端代码的测试文件，都在开头调用它；要核对日志的测试从返回的数组里读。
 * 用 spawn 起的后端进程不受影响：它的标准输出、标准错误接到测试进程的管道上，不是测试进程自己的标准输出。
 */
export function captureConsole(): string[] {
  if (captured) return captured;
  const lines: string[] = [];
  captured = lines;
  for (const name of ["log", "info", "debug", "dir", "warn", "error"] as const) {
    console[name] = (...args: unknown[]) => void lines.push(format(...args));
  }
  return lines;
}

/**
 * 等一件事，最多等 ms 毫秒：到时没有结果就以「等 what 超过 N 秒」失败，而不是一直等下去。what 写在等什么，
 * 例如「后端打印监听地址」。计时器在事情有结果时清掉，不会让测试进程多留一刻。
 */
export function within<T>(what: string, ms: number, promise: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_, fail) => {
    timer = setTimeout(() => fail(new Error(`等${what}超过 ${ms / 1000} 秒，没有等到。`)), ms);
  });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

const madeDirs: string[] = [];
process.on("exit", () => {
  // 测试自己在结束时会清；这里兜住中途失败、清理没有跑到的那些。清不掉不算测试失败。
  for (const dir of madeDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // 不管。
    }
  }
});
export function tempDir(prefix = "taskwright-backend-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  madeDirs.push(dir);
  return dir;
}

function node(args: string[]): void {
  const done = spawnSync(process.execPath, args, { encoding: "utf-8" });
  if (done.status !== 0) throw new Error(`夹具脚本失败：${done.stderr}`);
}

/**
 * 演示任务目录。withDb 为真时库由夹具写出：修订 1 新增 UC-001（名称「申请退款」）与 TBD-001；修订 2 把 UC-001 改成
 * 「买家申请退款」、改 TBD-001、新增 UC-002；修订 3 删除 UC-002。事件 1 是创建任务，事件 2 到 4 是三次修订。
 */
export function makeWorkspace(root: string, name: string, withDb: boolean): string {
  const ws = join(root, name);
  mkdirSync(join(ws, "docs", "task-definitions"), { recursive: true });
  writeFileSync(join(ws, "docs", "task-definitions", "demo.json"), JSON.stringify(DEMO_DEFINITION), "utf-8");
  if (withDb) node([join(FIXTURES, "build_current_db.mts"), ws]);
  return ws;
}

/**
 * 用真实任务类型的起始文件建一个任务目录，按几批各写一次：一批是操作列表时保存一次修订，是 { diagram, said } 时保存一张图。
 * 任务一建好就由用户移到写条目阶段（夹具里的 { stage }），这样各批里助手可以直接写用例；测工作阶段的测试不用它。
 */
export function makeTypedTask(root: string, taskType: string, materials: Record<string, string>, batches: unknown[]): string {
  const ws = join(root, "task");
  cpSync(join(ROOT, "task-types", taskType), ws, { recursive: true });
  mkdirSync(join(ws, "inputs"), { recursive: true });
  for (const [name, text] of Object.entries(materials)) writeFileSync(join(ws, "inputs", name), text, "utf-8");
  node([join(FIXTURES, "build_task_db.mts"), ws, `docs/task-definitions/${taskType}.json`, JSON.stringify([{ stage: "写条目" }, ...batches])]);
  return ws;
}

/**
 * 用 0.4.3 的任务类型文件（tests/fixtures/task_dirs/0.4.3/docs：任务定义、模板、评审规则，集合里是「领域说明」）建一个任务目录，
 * 用法与 makeTypedTask 相同。0.4 建的任务不迁移、照旧能用，测它们的，以及只测与任务类型无关的机制（图、导出、依据已变）的，用它：
 * 这样的任务没有「总体分析」集合，也就没有「先有一页想清楚的主题才能写条目」那道门。
 */
export function makeLegacyTask(root: string, materials: Record<string, string>, batches: unknown[]): string {
  const ws = join(root, "task");
  mkdirSync(ws, { recursive: true });
  cpSync(join(ROOT, "backend", "tests", "fixtures", "task_dirs", "0.4.3", "docs"), join(ws, "docs"), { recursive: true });
  mkdirSync(join(ws, "inputs"), { recursive: true });
  for (const [name, text] of Object.entries(materials)) writeFileSync(join(ws, "inputs", name), text, "utf-8");
  node([join(FIXTURES, "build_task_db.mts"), ws, "docs/task-definitions/srs-authoring.json", JSON.stringify(batches)]);
  return ws;
}

/** 把夹具目录复制一份，给要改库的测试用。 */
export function copyWorkspace(ws: string, to: string): string {
  cpSync(ws, to, { recursive: true });
  return to;
}

/** 在测试夹具库上直接执行几条 SQL（每条可带参数）。只用于临时副本。 */
export function sqlRun(ws: string, statements: [string, ...unknown[]][]): void {
  const db = new DatabaseSync(join(ws, "task.sqlite"));
  try {
    for (const [sql, ...params] of statements) db.prepare(sql).run(...(params as any[]));
  } finally {
    db.close();
  }
}

export function sqlGet(ws: string, sql: string, ...params: unknown[]): Record<string, any> | undefined {
  const db = new DatabaseSync(join(ws, "task.sqlite"), { readOnly: true });
  try {
    const row = db.prepare(sql).get(...(params as any[]));
    return row ? { ...row } : undefined;
  } finally {
    db.close();
  }
}

/**
 * 起一个后端进程，端口给 0，由操作系统挑一个空闲端口；等它打印出监听地址，返回进程、实际端口与它到此为止的全部输出。
 * 不先向系统要一个端口、关掉再交给后端：那样中间有空隙，几个会话同时跑测试时端口会被别人占去。
 * args 是端口以外的命令行参数；options 的 stdio 由这里定（两路输出都收下）。没等到（进程退出或超时）时先结束进程再抛错。
 */
export async function spawnBackend(args: string[], options: Omit<SpawnOptions, "stdio"> = {}, ms = 15_000):
  Promise<{ child: ChildProcess; port: number; output: () => string }> {
  // 没给知识库目录时放在任务目录的旁边（同一个临时目录里），不落到用户数据目录下。
  const at = args.indexOf("--tasks");
  const knowledge = !args.includes("--knowledge") && at >= 0 ? ["--knowledge", join(dirname(args[at + 1]), "knowledge")] : [];
  const child = spawn(process.execPath, [BACKEND_MAIN, ...args, ...knowledge, "--port", "0"], { ...options, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout!.on("data", (c) => (out += c));
  child.stderr!.on("data", (c) => (out += c));
  const end = Date.now() + ms;
  for (;;) {
    const m = /任务服务在 http:\/\/[^:]+:(\d+)\//.exec(out);
    if (m) return { child, port: Number(m[1]), output: () => out };
    const gone = child.exitCode !== null || child.signalCode !== null;
    if (gone || Date.now() > end) {
      if (!gone) {
        child.kill("SIGKILL");
        await new Promise((ok) => child.once("exit", ok));
      }
      throw new Error(`后端没有起来：${gone ? `进程已经退出（退出码 ${child.exitCode}，信号 ${child.signalCode}）` : `${ms / 1000} 秒内没有打印监听地址`}。它的输出：${out}`);
    }
    await new Promise((ok) => setTimeout(ok, 50));
  }
}

/**
 * 发一句话并等助手把这一轮做完。send 去发话（发话接口返回就算发完）；这里先订阅这个任务的事件连接，连上了才发，
 * 然后等这条会话的 work_ended 事件：后端在一轮结束时推这个事件，紧接着把执行者置回空闲。
 *
 * 不能用「这条会话的消息数变多、执行者是空闲」来判断这一轮做完了。后端要等收到助手程序的 agent_start 事件才把执行者改成工作中，
 * 而用户的那句话在这之前就已经写进会话文件、算进了消息数，所以刚发完话的一小段时间里这个条件已经成立。机器忙的时候
 * （整套测试并行跑时）这一小段时间足够长，调用方会在助手还没有开始的时候就往下走。
 */
export async function sendAndWaitTurn(port: number, taskId: string, sessionId: string, send: () => Promise<void>, ms = 60_000): Promise<void> {
  const events: { event: string; data: Record<string, any> }[] = [];
  let buffer = "";
  const req = request({ host: "127.0.0.1", port, path: `/api/v1/tasks/${taskId}/events` });
  // 后端先登记订阅者再写响应头，所以收到响应时已经订阅上了，之后的事件不会漏。
  const connected = new Promise<void>((ok, fail) => {
    req.on("response", (res) => {
      res.setEncoding("utf-8");
      res.on("data", (chunk: string) => {
        buffer += chunk;
        for (let cut = buffer.indexOf("\n\n"); cut >= 0; cut = buffer.indexOf("\n\n")) {
          const block = buffer.slice(0, cut);
          buffer = buffer.slice(cut + 2);
          const event = /^event: (.*)$/m.exec(block)?.[1];
          const data = /^data: (.*)$/m.exec(block)?.[1];
          if (event && data) events.push({ event, data: JSON.parse(data) });
        }
      });
      res.on("error", () => {});
      if (res.statusCode === 200) ok();
      else fail(new Error(`事件连接没有连上，状态码 ${res.statusCode}`));
    });
    req.on("error", fail);
  });
  req.end();
  try {
    await connected;
    await send();
    for (const end = Date.now() + ms; !events.some((e) => e.event === "work_ended" && e.data.session_id === sessionId);) {
      if (Date.now() > end) throw new Error(`等这一轮做完超时：${ms / 1000} 秒内没有收到这条会话的 work_ended 事件`);
      await new Promise((ok) => setTimeout(ok, 50));
    }
  } finally {
    req.destroy();
  }
}

/**
 * 查任务库里记下的每一次阶段移动（活动记录表的每一行，按先后）的语句，列由调用方点：stage 是移到的阶段（那项活动），
 * from_stage 取自记下开始的那条事件的内容，别的是表里的同名列。列名沿用早先阶段记录表的叫法。
 */
export function movesSql(columns: readonly string[]): string {
  const column = (name: string) => (name === "stage" ? "r.activity AS stage" : name === "from_stage" ? "json_extract(e.payload, '$.from') AS from_stage" : `r.${name}`);
  return `SELECT ${columns.map(column).join(", ")} FROM activity_record r LEFT JOIN event e ON e.seq = r.started_seq ORDER BY r.started_seq`;
}
