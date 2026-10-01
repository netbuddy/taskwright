/**
 * 后端测试共用的夹具。写库一律经 agent 测试目录里的夹具脚本（子进程运行，内部调用真实的写入函数），
 * 后端的代码与测试都不导入写入函数。个别测试要在夹具库的副本上补几行（模拟旧库、补事件），
 * 用 sqlRun 在临时副本上直接执行 SQL；那只是测试夹具，不是产品代码的写入路径。
 */

import { type ChildProcess, type SpawnOptions, spawn, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
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

export function tempDir(prefix = "taskwright-backend-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
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

/** 用真实任务类型的起始文件建一个任务目录，按几批操作各保存一次修订。 */
export function makeTypedTask(root: string, taskType: string, materials: Record<string, string>, batches: unknown[][]): string {
  const ws = join(root, "task");
  cpSync(join(ROOT, "task-types", taskType), ws, { recursive: true });
  mkdirSync(join(ws, "inputs"), { recursive: true });
  for (const [name, text] of Object.entries(materials)) writeFileSync(join(ws, "inputs", name), text, "utf-8");
  node([join(FIXTURES, "build_task_db.mts"), ws, `docs/task-definitions/${taskType}.json`, JSON.stringify(batches)]);
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
