/**
 * 校验一段 Mermaid 文本：保存一张图之前先看它的语法对不对，不对就把第几行、哪里不对说给助手，让它改了再存。
 *
 * 图的种类五选一：用例图、类图、状态图、时序图、流程图。用例图不用 mermaid 自己的用例图写法，而用流程图的写法画
 * （参与者与用例写成圆角的节点，系统边界写成子图），所以校验时用例图与流程图都按流程图看，这两种之间分不出来。
 *
 * 怎样校验：文本交给 mermaid 解析（src/diagram_engine.mjs），只看语法、不产出图。解析放在另一条线程里做
 * （src/diagram_worker.ts），原因写在那个文件开头。那条线程第一次用到时才起，起来后一直留着；一次校验等过了时限
 * 就把它结束掉，下一次校验再起一条。校验一份一份地做，不同时发两份。
 *
 * 结果有七种不通过：empty 没有文本；too_long 文本超过上限；unknown_type 开头认不出是哪种图；kind_mismatch 写的不是说好的
 * 那一种；syntax 语法不对；timeout 到时限还没有算完；unavailable 校验没有做成（引擎加载不了、那条线程出了错）。
 * 最后一种是程序这边的毛病，不是文本的毛病，文字里说明白，免得助手去改一份本来没有错的文本。
 */

import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { fromRoot } from "./paths.ts";

export const DIAGRAM_KINDS = ["use_case", "class", "state", "sequence", "flowchart"] as const;
export type DiagramKind = (typeof DIAGRAM_KINDS)[number];
export const DIAGRAM_KIND_NAMES: Record<DiagramKind, string> = { use_case: "用例图", class: "类图", state: "状态图", sequence: "时序图", flowchart: "流程图" };

/** Mermaid 文本最多这么多字节（按 UTF-8 算）。 */
export const DIAGRAM_TEXT_LIMIT = 20 * 1024;
/** 一次校验最多等这么久；20 KB 的类图在开发机上约 1.4 秒。 */
export const DIAGRAM_TIMEOUT_MS = 2000;
/** 校验引擎第一次加载最多等这么久（要读进 mermaid，慢的机器上要几秒）。 */
export const DIAGRAM_LOAD_TIMEOUT_MS = 30_000;
/** 解析时的原话最多带回这么多个字。 */
const DETAIL_LIMIT = 600;

export type DiagramProblem = "empty" | "too_long" | "unknown_type" | "kind_mismatch" | "syntax" | "timeout" | "unavailable";
export type DiagramCheck = { ok: true } | { ok: false; reason: DiagramProblem; line: number | null; message: string };

/** mermaid 认出的图类型各算哪一种：流程图的写法同时算用例图与流程图。 */
const TYPE_KINDS: Record<string, DiagramKind[]> = {
  flowchart: ["flowchart", "use_case"], "flowchart-v2": ["flowchart", "use_case"], "flowchart-elk": ["flowchart", "use_case"],
  class: ["class"], classDiagram: ["class"],
  state: ["state"], stateDiagram: ["state"],
  sequence: ["sequence"],
};
/** 五种之外常见的图类型的中文名，说「写的是某某图」时用；不在这里的照 mermaid 的叫法写。 */
const OTHER_TYPE_NAMES: Record<string, string> = {
  er: "实体关系图", gantt: "甘特图", pie: "饼图", mindmap: "思维导图", journey: "用户旅程图", gitGraph: "分支图", timeline: "时间线图",
  requirement: "需求图", c4: "C4 图", quadrantChart: "象限图", xychart: "坐标图", sankey: "桑基图", block: "方块图", kanban: "看板图", architecture: "架构图",
};
const KIND_LIST = DIAGRAM_KINDS.map((kind) => DIAGRAM_KIND_NAMES[kind]).join("、");

/** 校验引擎的文件地址：安装包里是构建时打好的那一份，仓库里是源文件。 */
export function diagramEngineUrl(): string {
  const packed = fromRoot("backend/vendor/mermaid/diagram_engine.mjs");
  return existsSync(packed) ? pathToFileURL(packed).href : new URL("./diagram_engine.mjs", import.meta.url).href;
}

interface Answer { type: string | null; error: { message: string; line: number | null } | null; failed?: boolean }
type Outcome = { kind: "answer"; answer: Answer } | { kind: "timeout" } | { kind: "unavailable"; detail: string };

const problem = (reason: DiagramProblem, message: string, line: number | null = null): DiagramCheck => ({ ok: false, reason, line, message });

/** 解析时的原话里写的行号（「Parse error on line 4」「at line 10, column 8」）；没有写是 null。 */
function lineInMessage(message: string): number | null {
  const found = /\b(?:on|at) line (\d+)/i.exec(message);
  return found ? Number(found[1]) : null;
}

/** 语法不对时给助手看的一句：第几行附近，加解析时的原话。 */
function syntaxProblem(text: string, error: { message: string; line: number | null }): DiagramCheck {
  // mermaid 给的行号与原话里写的行号有时差一行（括号没有闭合时，一个指开头那一行，一个指发现不对的那一行），两个都写出来。
  const reported = [...new Set([error.line, lineInMessage(error.message)].filter((n): n is number => n !== null))].sort((a, b) => a - b);
  // 少了收尾的东西（子图没有 end、花括号没有闭合）要读到文本结束才发现，这时报的行号在最后一行之后：改指最后一行，并说明。
  const last = text.trimEnd().split("\n").length;
  const atEnd = reported.length > 0 && reported[0] > last;
  const lines = [...new Set(reported.map((n) => Math.min(n, last)))];
  const where = lines.length === 0 ? "有一处" : lines.length === 1 ? `第 ${lines[0]} 行附近` : `第 ${lines[0]} 到 ${lines[lines.length - 1]} 行附近`;
  const hint = atEnd ? "文本到这里就结束了，多半是前面有括号没有闭合，或者子图、分支少了收尾的 end。" : "";
  const detail = error.message.trim();
  return problem("syntax", `Mermaid 文本${where}写得不对，改了再存。${hint}解析时的原话：${detail.length > DETAIL_LIMIT ? `${detail.slice(0, DETAIL_LIMIT)}…` : detail}`, lines[0] ?? null);
}

/**
 * 一个校验器管一条线程。产品里只用下面的 validateDiagram（全程一个校验器）；测试里另建校验器，好换引擎的地址与时限。
 */
export class DiagramChecker {
  private readonly engine: string;
  private readonly timeoutMs: number;
  private readonly loadTimeoutMs: number;
  private worker: Worker | null = null;
  private ready: Promise<string | null> | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private serial = 0;

  constructor(options: { engine?: string; timeoutMs?: number; loadTimeoutMs?: number } = {}) {
    this.engine = options.engine ?? diagramEngineUrl();
    this.timeoutMs = options.timeoutMs ?? DIAGRAM_TIMEOUT_MS;
    this.loadTimeoutMs = options.loadTimeoutMs ?? DIAGRAM_LOAD_TIMEOUT_MS;
  }

  /** 校验一段文本。kind 是说好的种类，text 是 Mermaid 文本；timeoutMs 不给就用校验器的时限。 */
  async validate(kind: unknown, text: unknown, timeoutMs: number = this.timeoutMs): Promise<DiagramCheck> {
    if (typeof kind !== "string" || !(DIAGRAM_KINDS as readonly string[]).includes(kind)) {
      throw new Error(`图的种类要写 ${DIAGRAM_KINDS.join("、")} 里的一个，收到的是 ${JSON.stringify(kind)}。`);
    }
    if (typeof text !== "string" || text.trim() === "") return problem("empty", "Mermaid 文本是空的，没有可以校验的内容。");
    const size = Buffer.byteLength(text, "utf-8");
    if (size > DIAGRAM_TEXT_LIMIT) {
      return problem("too_long", `Mermaid 文本有 ${(size / 1024).toFixed(1)} KB，超过了 ${DIAGRAM_TEXT_LIMIT / 1024} KB 的上限。把图拆成几张，或者去掉次要的内容。`);
    }
    const wanted = DIAGRAM_KIND_NAMES[kind as DiagramKind];
    const run = this.queue.then(() => this.ask(text, timeoutMs));
    this.queue = run.catch(() => undefined);
    const outcome = await run;
    if (outcome.kind === "timeout") {
      return problem("timeout", `这段 Mermaid 文本校验了 ${timeoutMs / 1000} 秒还没有算完，没有存。把图画得小一些再试。`);
    }
    if (outcome.kind === "unavailable") {
      return problem("unavailable", `这一次没有办法校验 Mermaid 文本（${outcome.detail}）。这是程序这边的问题，不是文本写错了，请告诉用户。`);
    }
    const { type, error, failed } = outcome.answer;
    if (failed) return problem("unavailable", `这一次没有办法校验 Mermaid 文本（${error?.message ?? "校验时出了错"}）。这是程序这边的问题，不是文本写错了，请告诉用户。`);
    if (type === null) {
      return problem("unknown_type", `Mermaid 文本的开头没有写图的类型，或者写的不是${KIND_LIST}里的一种。${wanted}的第一行要先写明类型。`, 1);
    }
    const kinds = TYPE_KINDS[type];
    if (!kinds || !kinds.includes(kind as DiagramKind)) {
      const written = kinds ? DIAGRAM_KIND_NAMES[kinds[0]] : OTHER_TYPE_NAMES[type] ?? `另一种图（${type}）`;
      const hint = kind === "use_case" ? "用例图用流程图的写法画，第一行写 flowchart。" : "";
      return problem("kind_mismatch", `写的是${written}，不是你说的${wanted}。${hint}`, 1);
    }
    return error ? syntaxProblem(text, error) : { ok: true };
  }

  /** 结束那条线程（下一次校验会再起一条）。 */
  async stop(): Promise<void> {
    const worker = this.worker;
    this.worker = null;
    this.ready = null;
    if (worker) await worker.terminate();
  }

  /** 起那条线程并等引擎加载好。返回 null 是好了；返回文字是没有起来的原因。 */
  private start(): Promise<string | null> {
    if (this.ready) return this.ready;
    const entry = new URL(import.meta.url.endsWith(".ts") ? "./diagram_worker.ts" : "./diagram_worker.js", import.meta.url);
    const worker = new Worker(entry, { workerData: { engine: this.engine } });
    // 不让这条线程拖住任务服务退出。
    worker.unref();
    this.worker = worker;
    this.ready = new Promise<string | null>((resolve) => {
      const timer = setTimeout(() => resolve(`校验引擎 ${this.loadTimeoutMs / 1000} 秒还没有加载好`), this.loadTimeoutMs);
      const done = (reason: string | null) => {
        clearTimeout(timer);
        resolve(reason);
      };
      worker.once("message", (message: { ready: boolean; message?: string }) => done(message.ready ? null : `校验引擎加载不了：${message.message ?? "原因不明"}`));
      worker.once("error", (error) => done(`校验用的线程出了错：${error.message}`));
      worker.once("exit", () => done("校验用的线程自己结束了"));
    });
    return this.ready;
  }

  private async ask(text: string, timeoutMs: number): Promise<Outcome> {
    const notReady = await this.start();
    const worker = this.worker;
    if (notReady !== null || !worker) {
      await this.stop();
      return { kind: "unavailable", detail: notReady ?? "校验用的线程没有起来" };
    }
    const id = ++this.serial;
    const outcome = await new Promise<Outcome>((resolve) => {
      const timer = setTimeout(() => finish({ kind: "timeout" }), timeoutMs);
      const onMessage = (answer: Answer & { id: number }) => {
        if (answer.id === id) finish({ kind: "answer", answer });
      };
      const onError = (error: Error) => finish({ kind: "unavailable", detail: `校验用的线程出了错：${error.message}` });
      const onExit = () => finish({ kind: "unavailable", detail: "校验用的线程自己结束了" });
      const finish = (result: Outcome) => {
        clearTimeout(timer);
        worker.off("message", onMessage);
        worker.off("error", onError);
        worker.off("exit", onExit);
        resolve(result);
      };
      worker.on("message", onMessage);
      worker.once("error", onError);
      worker.once("exit", onExit);
      worker.postMessage({ id, text });
    });
    // 没有等到回答：那条线程可能还卡在解析里，结束掉，下一次再起一条。
    if (outcome.kind !== "answer") await this.stop();
    return outcome;
  }
}

let shared: DiagramChecker | null = null;

/** 校验一段 Mermaid 文本（任务服务全程用同一个校验器）。 */
export function validateDiagram(kind: unknown, text: unknown): Promise<DiagramCheck> {
  return (shared ??= new DiagramChecker()).validate(kind, text);
}
