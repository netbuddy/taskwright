/**
 * 脱敏诊断包（data_pack.ts 的 diagnostic.redact）：把助手读到的材料文本、知识库检索命中与来源的逐字摘录换成占位，别的原样。
 * 只用来排查流程类问题（守卫拒绝、卡片、超时、工具调用的先后、理解的写法、步的走向），查不了内容类问题。
 *
 * 归档里的事件流（pi-events 的 service-*.jsonl）与会话文件（pi-sessions 下的 .jsonl）逐行读、逐行写：一行是一个 JSON，
 * 只有要改的行才重新写出，别的行原样，行数与时刻都不变。改的有三样：
 * - 工具结果：read 读材料目录或知识库目录下的文件（含文字版、分段清单、位置表）、grep 搜到材料目录、search_knowledge 的结果。
 *   结果在 tool_execution_end（result.content 与 result.structuredContent）、role 为 toolResult 的消息（message_start、message_end、
 *   turn_end 的 toolResults、agent_end 的 messages，会话文件里的消息）里，原放文字的地方改写成占位 JSON（placeholder）。
 *   路径与行范围取自同一个调用编号的调用参数：调用总在结果之前，逐行读时记住。
 * - 保存修订与保存图（save_revision、save_diagram）参数里的来源摘录（excerpt）：换成 maskExcerpt 的写法，与任务库副本相同。
 * - 这两种调用流式写出参数时的碎片（message_update 里的 toolcall_delta）：delta 置空字符串，完整参数在 toolcall_end 里（已经换过）。
 * 别的工具的结果、助手的思考与回复、用户的话都不动。
 */

import { createHash } from "node:crypto";
import { once } from "node:events";
import { createReadStream, createWriteStream } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

/** 脱敏后的标记。 */
export const REDACTED_MARK = "[已脱敏]";

const sha16 = (text: string) => createHash("sha256").update(text, "utf-8").digest("hex").slice(0, 16);

/** 来源摘录脱敏后的写法：「[已脱敏] 摘要值 <SHA-256 前 16 位> 长度 <原字符数>」。任务库副本与事件流里同一个写法。 */
export function maskExcerpt(excerpt: string): string {
  return `${REDACTED_MARK} 摘要值 ${sha16(excerpt)} 长度 ${[...excerpt].length}`;
}

/** 参数里带来源摘录、要脱敏的调用。 */
const SAVING_TOOLS = new Set(["save_revision", "save_diagram"]);

/** 脱敏看哪些位置：任务目录（会话里记的工作目录可能不同，一并给）、材料目录名（相对任务目录，例如 inputs）、知识库根目录。 */
export interface RedactScope {
  taskDirs: string[];
  materialDirs: string[];
  knowledgeDir: string | null;
}

/** 知识库文件的写法（出处或路径里）：knowledge/<库编号>/。 */
const KNOWLEDGE_PATH = /(^|[\\/])knowledge[\\/](general|lib-[0-9a-f]+)[\\/]/;

const within = (base: string, target: string) => {
  const rel = relative(base, target);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

/** 这个路径参数指的地方：落在材料目录或知识库里（inside），或者是包含材料目录的上级目录（covers，grep 从那里搜会搜到材料）。 */
function placeOf(scope: RedactScope, given: unknown): { inside: boolean; covers: boolean } {
  const path = typeof given === "string" && given ? given.replace(/^@/, "") : ".";
  if (KNOWLEDGE_PATH.test(path)) return { inside: true, covers: false };
  let inside = false;
  let covers = false;
  for (const dir of scope.taskDirs) {
    const target = isAbsolute(path) ? resolve(path) : resolve(dir, path);
    for (const material of scope.materialDirs) {
      const root = resolve(dir, material);
      if (within(root, target)) inside = true;
      else if (within(target, root)) covers = true;
    }
  }
  if (scope.knowledgeDir && within(resolve(scope.knowledgeDir), isAbsolute(path) ? resolve(path) : resolve(scope.taskDirs[0] ?? ".", path))) inside = true;
  return { inside, covers };
}

/** 这次调用的结果要不要脱敏。 */
function shouldRedact(scope: RedactScope, tool: string, args: Record<string, unknown> | undefined): boolean {
  if (tool === "search_knowledge") return true;
  if (tool === "read") return placeOf(scope, args?.path).inside;
  if (tool === "grep") {
    const at = placeOf(scope, args?.path);
    return at.inside || at.covers;
  }
  return false;
}

/** 占位 JSON：工具、路径（search_knowledge 写选的库）、行范围（read 给了才有）、原文的字节数与 SHA-256 前 16 位。 */
export function placeholder(tool: string, args: Record<string, unknown> | undefined, original: string): string {
  const body: Record<string, unknown> = { redacted: true, tool };
  if (tool === "search_knowledge") body.path = Array.isArray(args?.libraries) ? args!.libraries : null;
  else body.path = typeof args?.path === "string" ? args.path : null;
  if (tool === "read" && (typeof args?.offset === "number" || typeof args?.limit === "number")) {
    const from = typeof args?.offset === "number" ? args.offset : 1;
    body.lines = [from, typeof args?.limit === "number" ? from + args.limit - 1 : null];
  }
  body.bytes = Buffer.byteLength(original, "utf-8");
  body.sha256_16 = sha16(original);
  return JSON.stringify(body);
}

type Json = Record<string, any>;
const isObject = (value: unknown): value is Json => value !== null && typeof value === "object" && !Array.isArray(value);
const textOf = (content: unknown): string => (Array.isArray(content)
  ? content.filter((one) => isObject(one) && one.type === "text" && typeof one.text === "string").map((one) => one.text as string).join("\n")
  : typeof content === "string" ? content : "");

/** 把参数里所有来源的摘录换掉（save_revision 的 operations[].sources[]、save_diagram 的 sources[]，往下找名为 excerpt 的字符串）。 */
function maskExcerpts(value: unknown): boolean {
  let changed = false;
  if (Array.isArray(value)) {
    for (const one of value) changed = maskExcerpts(one) || changed;
  } else if (isObject(value)) {
    for (const [key, one] of Object.entries(value)) {
      if (key === "excerpt" && typeof one === "string" && one && !one.startsWith(REDACTED_MARK)) {
        value[key] = maskExcerpt(one);
        changed = true;
      } else changed = maskExcerpts(one) || changed;
    }
  }
  return changed;
}

/**
 * 一份归档文件的脱敏器：按行喂进去，返回写进包里的那一行。同一份文件里的调用参数要记住（结果在调用之后），所以一份文件一个。
 */
export class LineRedactor {
  private readonly calls = new Map<string, { name: string; args: Json | undefined }>();
  private readonly streaming = new Map<number, string>();
  private readonly scope: RedactScope;
  constructor(scope: RedactScope) {
    this.scope = scope;
  }

  line(text: string): string {
    // 与工具调用无关的行（绝大多数是思考与回复的流式片段）不解析，原样。
    if (!/toolResult|tool_execution|toolCall|toolcall_|excerpt/.test(text)) return text;
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      return text;
    }
    return this.visit(value) ? JSON.stringify(value) : text;
  }

  private visit(value: unknown): boolean {
    if (Array.isArray(value)) {
      let changed = false;
      for (const one of value) changed = this.visit(one) || changed;
      return changed;
    }
    if (!isObject(value)) return false;
    let changed = false;
    // 流式写出参数：记下这一格是哪个工具；保存修订与保存图的碎片置空。
    if (value.type === "toolcall_start" && typeof value.contentIndex === "number") this.streaming.set(value.contentIndex, String(value.toolName ?? ""));
    if (value.type === "toolcall_delta" && typeof value.contentIndex === "number" && SAVING_TOOLS.has(this.streaming.get(value.contentIndex) ?? "")
      && typeof value.delta === "string" && value.delta !== "") {
      value.delta = "";
      changed = true;
    }
    // 调用：记下参数；保存修订与保存图的参数换掉摘录。
    if (value.type === "toolCall" && typeof value.id === "string" && typeof value.name === "string") {
      this.calls.set(value.id, { name: value.name, args: isObject(value.arguments) ? value.arguments : undefined });
      if (SAVING_TOOLS.has(value.name)) changed = maskExcerpts(value.arguments) || changed;
    }
    if (value.type === "tool_execution_start" && typeof value.toolCallId === "string" && typeof value.toolName === "string") {
      this.calls.set(value.toolCallId, { name: value.toolName, args: isObject(value.args) ? value.args : undefined });
      if (SAVING_TOOLS.has(value.toolName)) changed = maskExcerpts(value.args) || changed;
    }
    // 结果：tool_execution_end（与 update）的 result，与 role 为 toolResult 的消息。
    if ((value.type === "tool_execution_end" || value.type === "tool_execution_update") && typeof value.toolName === "string" && isObject(value.result)) {
      changed = this.result(value.toolName, value.toolCallId, value.result, true) || changed;
    }
    if (value.role === "toolResult" && typeof value.toolName === "string") {
      changed = this.result(value.toolName, value.toolCallId, value, false) || changed;
    }
    for (const [key, one] of Object.entries(value)) {
      if (key === "content" && value.role === "toolResult") continue;
      if (key === "result" && (value.type === "tool_execution_end" || value.type === "tool_execution_update")) continue;
      changed = this.visit(one) || changed;
    }
    return changed;
  }

  /** 把一份结果（holder.content，以及 structured 时的 holder.structuredContent）换成占位；已经是占位、不该换时不动。 */
  private result(tool: string, callId: unknown, holder: Json, structured: boolean): boolean {
    const call = typeof callId === "string" ? this.calls.get(callId) : undefined;
    if (!shouldRedact(this.scope, tool, call?.args)) return false;
    const original = textOf(holder.content);
    if (original.startsWith('{"redacted":true')) return false;
    const marker = placeholder(tool, call?.args, original);
    holder.content = [{ type: "text", text: marker }];
    if (structured && "structuredContent" in holder) holder.structuredContent = marker;
    return true;
  }
}

/**
 * 一份归档文件逐行脱敏，写到 to：边读边写，不把整份文件读进内存；空行与最后有没有换行照原样。
 */
export async function redactFile(from: string, to: string, scope: RedactScope): Promise<void> {
  const redactor = new LineRedactor(scope);
  const out = createWriteStream(to, { encoding: "utf-8" });
  let pending = "";
  for await (const chunk of createReadStream(from, { encoding: "utf-8" })) {
    pending += chunk;
    let at = pending.indexOf("\n");
    while (at >= 0) {
      const one = pending.slice(0, at);
      if (!out.write((one ? redactor.line(one) : one) + "\n")) await once(out, "drain");
      pending = pending.slice(at + 1);
      at = pending.indexOf("\n");
    }
  }
  if (pending) out.write(redactor.line(pending));
  out.end();
  await once(out, "finish");
}

/** 会话文件第一行记的工作目录（type 为 session 的 cwd）；读不出是 null。 */
export function sessionCwd(firstLine: string): string | null {
  try {
    const value = JSON.parse(firstLine);
    return isObject(value) && value.type === "session" && typeof value.cwd === "string" ? value.cwd : null;
  } catch {
    return null;
  }
}

