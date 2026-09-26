/**
 * 假模型端点：一个按脚本回固定内容、与 OpenAI 聊天接口兼容的本地 HTTP 服务，只用 node:http。
 *
 * 它给集成测试与双跑对照用：pi 以为自己在请求一个模型，其实每次拿到的回答都是事先写好的，
 * 于是门禁拒绝、用户直接写入这类机制可以被确定性地测，不受真模型的随机性影响。
 *
 * 它实现 `POST /v1/chat/completions`，流式（stream 为真，按 SSE 逐块发）与非流式都支持，
 * 能回一段文字、一个或几个工具调用、故意延迟若干秒再回，或者回一个错误状态码。
 * 每个请求体原样追加进一份 jsonl 请求记录，据此断言「模型看到了什么」。
 *
 * 每个使用者起自己的实例，端口由操作系统随机分配（绑 0 号端口），不与别人共用：两个实验共用一个假端点会互相覆盖脚本。
 *
 * 脚本是一个对象，也可以直接是一个列表（等于只有 sequence）：
 *
 *     { "rules": [{"when": {...条件...}, "reply": {...回答...}, "max_uses": 1}], "sequence": [{...}, {...}], "default": {...} }
 *
 * 每来一个请求，先按先后试 rules，第一条条件全部满足、且没有用完次数的规则给出回答；
 * 都不满足时从 sequence 里取下一条；sequence 也用完了就回 default（没写就回一句「好的。」）。
 * 请求记录的每一行与 Python 版（server/taskwright_server/fake_model）写出的逐字相同。
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import { dirname } from "node:path";
import { pyDumps, truthy } from "../src/py.ts";

type Dict = Record<string, any>;

/** 脚本用完之后的兜底回答。 */
export const DEFAULT_REPLY: Dict = { text: "好的。" };

/**
 * 自动补的理解：autoIntent 为真时，用户说话之后的第一个回答要是只有工具调用、没有文字，就在前面补上这一段。
 * 执行者每轮要在文字输出里写一份理解，保存修订、完成任务、回复在没有理解时拒绝；只写了工具调用的脚本补上这一段照旧能跑。
 */
export const AUTO_INTENT_TEXT = '```json\n{"acts": [{"function": "request", "confidence": "high", "summary": "照用户说的做"}]}\n```';

/** 假端点对外报的模型名。pi 那一侧的 models.json 里写的模型编号要与它一致，见 agent_config.ts。 */
export const MODEL_ID = "fake-model";

/** 一条消息的文字：content 可能是字符串，也可能是若干段的列表。 */
export function messageText(message: Dict): string {
  const content = message.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((p) => (p && typeof p === "object" && !Array.isArray(p) ? (Object.hasOwn(p, "text") ? p.text : "") : "")).join("");
  return "";
}

/**
 * 一条规则的条件是否全部满足。条件都是关于这个请求的事实，没写的条件不管。
 *   request_no     这是第几个请求，从 1 起。
 *   last_role      请求里最后一条消息的角色，例如 user、tool。
 *   last_contains  请求里最后一条消息的文字包含这段文字。
 *   any_contains   请求里任意一条消息的文字包含这段文字。
 */
export function matches(when: Dict, requestNo: number, body: Dict): boolean {
  const messages: Dict[] = truthy(body.messages) ? body.messages : [];
  const last = messages.length ? messages[messages.length - 1] : {};
  if (Object.hasOwn(when, "request_no") && when.request_no !== requestNo) return false;
  if (Object.hasOwn(when, "last_role") && last.role !== when.last_role) return false;
  if (Object.hasOwn(when, "last_contains") && !messageText(last).includes(when.last_contains)) return false;
  if (Object.hasOwn(when, "any_contains") && !messages.some((m) => messageText(m).includes(when.any_contains))) return false;
  return true;
}

const clone = <T>(value: T): T => structuredClone(value);


export interface FakeModelOptions {
  host?: string;
  autoIntent?: boolean;
}

/** 一个假端点实例。用法：const fake = await new FakeModel(script, logPath).start(); …; await fake.stop(); */
export class FakeModel {
  readonly host: string;
  readonly autoIntent: boolean;
  readonly logPath: string | null;
  requestCount = 0;
  private rules: Dict[] = [];
  private sequence: Dict[] = [];
  private fallback: Dict = DEFAULT_REPLY;
  private server: Server | null = null;

  constructor(script: unknown = [], logPath: string | null = null, options: FakeModelOptions = {}) {
    this.host = options.host ?? "127.0.0.1";
    this.autoIntent = options.autoIntent ?? false;
    this.logPath = logPath;
    this.setScript(truthy(script) ? script : []);
  }

  // ───────────── 脚本 ─────────────

  /** 换一份脚本，已经数过的请求次数不清零。 */
  setScript(script: unknown): void {
    const s: Dict = Array.isArray(script) ? { sequence: script } : (script as Dict);
    // 规则里的 reply_from（按请求现算回答的函数）只在代码里直接用时可写，原样保留，不复制。
    this.rules = (truthy(s.rules) ? (s.rules as Dict[]) : []).map((r) => ({ ...clone({ ...r, reply_from: undefined }), reply_from: r.reply_from, used: 0 }));
    this.sequence = clone(truthy(s.sequence) ? s.sequence : []);
    this.fallback = clone(truthy(s.default) ? s.default : DEFAULT_REPLY);
  }

  /** 给这个请求挑回答，返回 [回答, 按哪一条给的说明]。 */
  private pick(requestNo: number, body: Dict): [Dict, string] {
    for (const [index, rule] of this.rules.entries()) {
      const limit = rule.max_uses;
      if (limit !== undefined && limit !== null && rule.used >= limit) continue;
      if (matches(truthy(rule.when) ? rule.when : {}, requestNo, body)) {
        rule.used += 1;
        if (typeof rule.reply_from === "function") return [rule.reply_from(body), `rules 第 ${index + 1} 条（按请求现算）`];
        return [clone(rule.reply), `rules 第 ${index + 1} 条`];
      }
    }
    if (this.sequence.length) return [this.sequence.shift()!, "sequence 的下一条"];
    return [clone(this.fallback), "default"];
  }

  // ───────────── 启停 ─────────────

  /** 起服务。port 为 0 时由操作系统挑一个空闲端口。 */
  start(port = 0): Promise<this> {
    this.server = createServer((req, res) => void this.handle(req, res));
    return new Promise((ok, fail) => {
      this.server!.once("error", fail);
      this.server!.listen(port, this.host, () => ok(this));
    });
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (server === null) return;
    server.closeAllConnections();
    await new Promise((ok) => server.close(ok));
  }

  get port(): number {
    if (this.server === null) throw new Error("假端点还没有启动。");
    return (this.server.address() as { port: number }).port;
  }

  /** 给 pi 的 models.json 里 baseUrl 一项用的地址。 */
  get baseUrl(): string {
    return `http://${this.host}:${this.port}/v1`;
  }

  // ───────────── 请求记录 ─────────────

  /** 读回请求记录，每项是 {"序号", "时刻", "请求体", "回答", "按哪一条给的"}。 */
  requests(): Dict[] {
    if (this.logPath === null || !existsSync(this.logPath)) return [];
    return readFileSync(this.logPath, "utf-8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
  }

  private record(entry: Dict): void {
    if (this.logPath === null) return;
    let line = pyDumps(entry);
    // 时刻是保留三位小数的秒；正好是整数时照 Python 的浮点写法补「.0」。
    if (Number.isInteger(entry.时刻)) line = line.replace(`"时刻": ${entry.时刻},`, `"时刻": ${entry.时刻}.0,`);
    mkdirSync(dirname(this.logPath), { recursive: true });
    appendFileSync(this.logPath, line + "\n", "utf-8");
  }

  // ───────────── 回答 ─────────────

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const path = (req.url ?? "/").replace(/\/+$/, "");
    if (req.method === "GET") {
      if (path.endsWith("/models")) sendJson(res, 200, { object: "list", data: [{ id: MODEL_ID, object: "model" }] });
      else sendJson(res, 404, { error: { message: `假端点没有 ${req.url} 这个地址` } });
      return;
    }
    if (req.method !== "POST" || !path.endsWith("/chat/completions")) {
      sendJson(res, 404, { error: { message: `假端点没有 ${req.url} 这个地址` } });
      return;
    }
    await this.completion(res, Buffer.concat(chunks));
  }

  private async completion(res: ServerResponse, raw: Buffer): Promise<void> {
    let body: Dict;
    try {
      body = JSON.parse(raw.length ? raw.toString("utf-8") : "{}");
    } catch {
      body = { 无法解析的请求体: raw.toString("utf-8") };
    }
    this.requestCount += 1;
    const requestNo = this.requestCount;
    const [picked, why] = this.pick(requestNo, body);
    const reply = this.withIntent(picked, body);
    this.record({ 序号: requestNo, 时刻: Math.round(Date.now()) / 1000, 请求体: body, 回答: reply, 按哪一条给的: why });
    if (truthy(reply.delay)) await new Promise((ok) => setTimeout(ok, Number(reply.delay) * 1000));
    const status = Math.trunc(Number(Object.hasOwn(reply, "status") ? reply.status : 200));
    if (status !== 200) {
      // 错误应答后关闭连接：不关的话客户端会在下一次请求时复用这条旧连接，要先等它失败再重连，多出约 2 秒。
      sendJson(res, status, { error: { message: Object.hasOwn(reply, "error_body") ? reply.error_body : `假端点按脚本回 ${status}`, type: "fake_error" } }, true);
      return;
    }
    const calls = (truthy(reply.tool_calls) ? (reply.tool_calls as Dict[]) : []).map((call, i) => ({
      id: truthy(call.id) ? call.id : `call_fake_${requestNo}_${i}`, type: "function",
      function: { name: call.name, arguments: pyDumps(truthy(call.arguments) ? call.arguments : {}) },
    }));
    const text: string = truthy(reply.text) ? reply.text : "";
    const finish = calls.length ? "tool_calls" : "stop";
    if (truthy(body.stream)) {
      sendStream(res, requestNo, text, calls, finish);
    } else {
      const message: Dict = { role: "assistant", content: text || null };
      if (calls.length) message.tool_calls = calls;
      sendJson(res, 200, {
        id: `chatcmpl-fake-${requestNo}`, object: "chat.completion", created: Math.trunc(Date.now() / 1000), model: MODEL_ID,
        choices: [{ index: 0, message, finish_reason: finish }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
    }
  }

  /** autoIntent 为真、这个请求的最后一条消息是用户的角色、回答只有工具调用没有文字时，在前面补一段理解。 */
  private withIntent(reply: Dict, body: Dict): Dict {
    const messages: Dict[] = truthy(body.messages) ? body.messages : [];
    const last = messages.length ? messages[messages.length - 1] : {};
    // 兜底那句提醒之后也补：那一轮要是还没有理解，扩展就记下这一份；已经有了，扩展不再记，多写的一段无害。
    if (!this.autoIntent || last.role !== "user" || !truthy(reply.tool_calls) || truthy(reply.text)) return reply;
    return { ...reply, text: AUTO_INTENT_TEXT };
  }
}

function sendJson(res: ServerResponse, status: number, payload: Dict, close = false): void {
  const data = Buffer.from(pyDumps(payload), "utf-8");
  const headers: Dict = { "Content-Type": "application/json; charset=utf-8", "Content-Length": data.length };
  if (close) headers.Connection = "close";
  res.writeHead(status, headers);
  res.end(data);
}

function sendStream(res: ServerResponse, requestNo: number, text: string, calls: Dict[], finish: string): void {
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "close" });
  const base = { id: `chatcmpl-fake-${requestNo}`, object: "chat.completion.chunk", created: Math.trunc(Date.now() / 1000), model: MODEL_ID };
  const chunk = (delta: Dict, finishReason: string | null = null) => ({ ...base, choices: [{ index: 0, delta, finish_reason: finishReason }] });
  const pieces: Dict[] = [chunk({ role: "assistant", content: "" })];
  if (text) pieces.push(chunk({ content: text }));
  calls.forEach((call, i) => pieces.push(chunk({ tool_calls: [{ index: i, ...call }] })));
  pieces.push(chunk({}, finish));
  pieces.push({ ...base, choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
  for (const piece of pieces) res.write(`data: ${pyDumps(piece)}\n\n`);
  res.end("data: [DONE]\n\n");
}
