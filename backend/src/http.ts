/**
 * 路由与各接口（node:http，无框架）。所有路径以 /api/v1 开头；错误一律是 {"ok": false, "error": {code, message, data}}。
 * 启动时给了网页目录时，不以 /api/ 开头的 GET 请求改由 web.ts 出静态文件。
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:http";
import { createReadStream, createWriteStream, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { type ExportOptions, PACK_MAX_UPLOAD, PACK_SUFFIX, diagnosticPackName, PACK_UPLOAD_TOO_LARGE_TEXT, PackError, exportPack, importPack, importText, importingName } from "./data_pack.ts";
import { ApiError } from "./errors.ts";
import { launchModelOf, piAgentDir, resolveModel, segmentParamsOf } from "./launch.ts";
import * as library from "./library.ts";
import { type SessionFact, taskStatus, workItemView } from "./task_status.ts";
import { UPGRADED_VERSION_NOTE } from "../../agent/src/lib/schema.ts";
import * as render from "./render.ts";
import * as exportDocx from "./export_docx.ts";
import * as exportDocument from "./export_document_docx.ts";
import * as versionArchive from "./version_archive.ts";
import { DIAGRAM_KINDS, validateDiagram } from "./diagram_validate.ts";
import { FLOW_ANALYSIS, SCOPE_MAX_LENGTH, stageByName } from "../../agent/src/lib/stage.ts";
import { activityNameOf } from "../../agent/src/lib/activity_def_read.ts";
import { CATALOG_LATER } from "../../agent/src/lib/activity_catalog.ts";
import { isObject, or, truthy } from "./py.ts";
import * as conversation from "./conversation.ts";
import type { Subscriber } from "./hub.ts";
import { pyDumps } from "./py.ts";
import { appVersion, logDir } from "./paths.ts";
import * as debugPrompt from "./debug_prompt.ts";
import * as modelConfig from "./model_config.ts";
import * as modelTest from "./model_test.ts";
import { probeModel } from "./model_probe.ts";
import { type Service, UPLOAD_TYPES, maxUpload, taskTypes, tooLargeText, unsupportedTypeText, uploadTypesText, wordsLocator } from "./service.ts";
import { isWebPath, webFile } from "./web.ts";
import { KIND_NAMES, knowledgeMaxUpload, knowledgeTooLargeText } from "./knowledge.ts";
import { UPLOAD_CAP_MB, UPLOAD_DEFAULT_MB, readUploadLimits, settingsExcerpt, validUploadMb, writeUploadLimits } from "./product_settings.ts";

/** 材料原样取回时按扩展名给的内容类型；不在表里的给 application/octet-stream。 */
export const RAW_TYPES: Record<string, string> = {
  ".md": "text/markdown; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".pdf": "application/pdf",
};

type Params = Record<string, string>;
interface Request {
  method: string;
  path: string;
  query: Record<string, string>;
  headers: IncomingMessage["headers"];
  body: Buffer;
  params: Params;
  /** 请求来自哪个地址（套接字的对端地址）。 */
  remote?: string;
  /** 对方在回答发出之前断开连接时中止；耗时的处理函数拿它提前收手。不经套接字直接调 dispatch 时没有。 */
  signal?: AbortSignal;
}
interface Reply {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
  close?: boolean;
  /** 回答整个发出之后要做的事（退出接口用它在回答之后才收尾）。 */
  after?: () => void;
}
/** 长连接的回答（事件流）：拿到响应对象后自己往里写，连接断了才结束。 */
export interface Stream {
  stream: (res: ServerResponse) => Promise<void>;
}
type Handler = (service: Service, req: Request) => Reply | Stream | Promise<Reply | Stream>;

// ───────────── URL 的解码（与 Python 的 urllib.parse 相同） ─────────────

/** %XX 按 UTF-8 解码，不合法的字节换成替换字符；plus 为真时加号换成空格。 */
export function unquote(text: string, plus = false): string {
  const source = plus ? text.replaceAll("+", " ") : text;
  if (!source.includes("%")) return source;
  const out: string[] = [];
  let bytes: number[] = [];
  const flush = () => {
    if (bytes.length) out.push(new TextDecoder("utf-8").decode(Uint8Array.from(bytes)));
    bytes = [];
  };
  for (let i = 0; i < source.length; i++) {
    const hex = source.slice(i + 1, i + 3);
    if (source[i] === "%" && /^[0-9a-fA-F]{2}$/.test(hex)) {
      bytes.push(parseInt(hex, 16));
      i += 2;
    } else {
      flush();
      out.push(source[i]);
    }
  }
  flush();
  return out.join("");
}

/** 查询串 → 每个键取最后一个值；没有等号或值为空的项丢掉。 */
export function parseQuery(query: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of query.split("&")) {
    if (!pair) continue;
    const at = pair.indexOf("=");
    if (at < 0) continue;
    const value = pair.slice(at + 1);
    if (!value.length) continue;
    out[unquote(pair.slice(0, at), true)] = unquote(value, true);
  }
  return out;
}

// ───────────── 响应 ─────────────

export function json(status: number, body: unknown): Reply {
  return { status, headers: { "Content-Type": "application/json; charset=utf-8" }, body: Buffer.from(JSON.stringify(body), "utf-8") };
}

function bodyJson(req: Request): Record<string, any> {
  if (!req.body.length) return {};
  let value: unknown;
  try {
    value = JSON.parse(req.body.toString("utf-8") || "{}");
  } catch {
    throw new ApiError("bad_request", "请求体不是合法的 JSON。");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new ApiError("bad_request", "请求体应当是一个 JSON 对象。");
  return value as Record<string, any>;
}

// ───────────── multipart ─────────────

/** Content-Disposition 之类的头里的参数：name="…"（引号里的反斜杠转义还原）、name=token、name*=UTF-8''%XX。 */
export function headerParams(value: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /;\s*([^\s=;]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^;]*))/g;
  for (let m = re.exec(value); m; m = re.exec(value)) {
    const key = m[1].toLowerCase();
    const raw = m[2] !== undefined ? m[2].replace(/\\(.)/g, "$1") : m[3].trim();
    if (key.endsWith("*")) {
      const parts = /^([^']*)'[^']*'(.*)$/.exec(raw);
      out[key.slice(0, -1)] = parts ? unquote(parts[2]) : raw;
      out[key] = raw;
    } else if (!(key in out)) {
      out[key] = raw;
    }
  }
  return out;
}

/** 取出 multipart 请求里的第一个文件：[文件名, 内容]。 */
export function parseMultipart(contentType: string, body: Buffer): [string, Buffer] {
  const form = parseMultipartForm(contentType, body);
  if (form.file) return form.file;
  throw new ApiError("bad_request", "请求里没有文件。");
}

/** multipart 请求里的第一个文件（[文件名, 内容]，没有时为 null）与文字字段（没有文件名的部分，按 UTF-8 解码；同名字段取第一个）。 */
export function parseMultipartForm(contentType: string, body: Buffer): { file: [string, Buffer] | null; fields: Record<string, string> } {
  let file: [string, Buffer] | null = null;
  const fields: Record<string, string> = {};
  const boundary = headerParams(";" + contentType.split(";").slice(1).join(";")).boundary;
  if (contentType.split(";")[0].trim().toLowerCase().startsWith("multipart/") && boundary) {
    const delimiter = Buffer.from(`--${boundary}`, "latin1");
    let at = body.indexOf(delimiter);
    while (at >= 0) {
      let start = at + delimiter.length;
      if (body.slice(start, start + 2).toString("latin1") === "--") break;
      const lineEnd = body.indexOf("\r\n", start);
      if (lineEnd < 0) break;
      start = lineEnd + 2;
      const next = body.indexOf(Buffer.from(`\r\n--${boundary}`, "latin1"), start);
      const part = body.subarray(start, next >= 0 ? next : body.length);
      const headerEnd = part.indexOf("\r\n\r\n");
      const head = headerEnd >= 0 ? part.subarray(0, headerEnd).toString("utf-8") : part.toString("utf-8");
      const content = headerEnd >= 0 ? part.subarray(headerEnd + 4) : Buffer.alloc(0);
      const headers = new Map<string, string>();
      for (const line of head.split("\r\n")) {
        const colon = line.indexOf(":");
        if (colon > 0) headers.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim());
      }
      const disposition = headerParams(";" + (headers.get("content-disposition") ?? "").split(";").slice(1).join(";"));
      const typeParams = headerParams(";" + (headers.get("content-type") ?? "").split(";").slice(1).join(";"));
      const name = disposition.filename ?? typeParams.name;
      if (name) {
        file ??= [name, Buffer.from(content)];
      } else if (disposition.name !== undefined && !(disposition.name in fields)) {
        fields[disposition.name] = content.toString("utf-8");
      }
      if (next < 0) break;
      at = next + 2;
    }
  }
  return { file, fields };
}

// ───────────── 各接口 ─────────────

function sessionParam(req: Request, body: Record<string, any> = {}): string | null {
  return or(req.query.session, null) ?? or(body.session_id, null) ?? null;
}

/**
 * 一次直接操作是不是要先新建一条会话、再在新会话里做：启动一个工作项（start_activity）与换一条会话接着做一个工作项（continue_activity），
 * 而且写法都对。写法不对的不在这里拒绝，照常转交，由助手一侧答 bad_request；那样就不会先建出一条用不上的会话。
 * start_activity 早先的 session 一项已经停用，写了的也照常转交、由助手一侧拒绝。
 */
function needsNewSession(body: Record<string, any>): boolean {
  const fields = body.fields;
  if (!isObject(fields)) return false;
  if (body.kind === "start_activity") {
    const scope = fields.scope, flow = fields.flow;
    // flow 只在启动工作流时写（一段文字，不写按需求分析）；启动单项活动不写。activity 是哪一项由新建会话之前的核对去认。
    const flowOk = flow === undefined || flow === null || (fields.in_flow === true && typeof flow === "string" && flow.trim() !== "");
    return fields.session === undefined && typeof fields.activity === "string" && fields.activity.trim() !== "" && typeof fields.in_flow === "boolean" && flowOk
      && (scope === undefined || scope === null || (typeof scope === "string" && scope.trim().length <= SCOPE_MAX_LENGTH));
  }
  if (body.kind === "continue_activity") return Number.isInteger(fields.activity_record_id) && fields.activity_record_id >= 1;
  return false;
}

/**
 * 新建会话之前核对，不行就拒绝、不建会话。启动：活动目录里要有这项活动（按键或名字认，早先的阶段名也认），没有答 bad_request；
 * 只能由用户发起的那项（发布）答 rejected；声明为不能单独启动的活动（逆向解析）单项启动也答 rejected。启动单项活动：这项活动现在能不能启动（任务状况里活动目录的那一项），不能就答 rejected 并写明原因。
 * 启动流程不查前提，与助手一侧相同；目录里要有 flow 写的那条流程（不写按需求分析）、这项活动要是它的一站，不然答 bad_request；
 * 任务里已有流程的工作项时答 rejected，写明现有的那一个（一个任务同一时刻至多一个流程工作项）。
 * 接着做一个工作项：要有这个工作项。任务没有阶段、活动目录出不来时不在这里拒绝，交给助手一侧。
 */
function refuseBeforeNewSession(taskDir: string, body: Record<string, any>): void {
  const fields = body.fields as Record<string, any>;
  if (body.kind === "continue_activity") {
    const item = library.workItemRows(taskDir).find((one) => one.record_id === fields.activity_record_id);
    if (!item) throw new ApiError("not_found", `没有记录号是 ${fields.activity_record_id} 的工作项（可能已经删除）。`);
    return;
  }
  const catalog = taskStatus(taskDir)?.catalog ?? null;
  const text = String(fields.activity).trim();
  const entry = catalog?.activities.find((one) => one.key === text || one.name === text) ?? catalog?.activities.find((one) => one.key === stageByName(text));
  if (catalog !== null && !entry) throw new ApiError("bad_request", `任务类型里没有叫「${text}」的活动。`);
  if (entry && entry.mode === "user_only") {
    const fact = `「${entry.name}」${CATALOG_LATER}`;
    throw new ApiError("rejected", `${fact}。`, { reasons: [fact] });
  }
  // 声明为不能单独启动的活动（逆向解析）只在工作流里做：单项启动拒绝，不建会话。
  if (fields.in_flow === false && entry && entry.alone === false) {
    const fact = `「${entry.name}」只在工作流里做，不能单独启动`;
    throw new ApiError("rejected", `${fact}。`, { reasons: [fact] });
  }
  if (fields.in_flow !== false) {
    const flowKey = typeof fields.flow === "string" ? fields.flow.trim() : FLOW_ANALYSIS;
    const flow = catalog?.flows.find((one) => one.key === flowKey);
    if (catalog !== null && !flow) throw new ApiError("bad_request", `任务类型里没有叫「${flowKey}」的工作流。`);
    if (flow && entry && !flow.nodes.some((one) => one.key === entry.key)) throw new ApiError("bad_request", `「${entry.name}」不是工作流「${flow.name}」的一站。`);
    const flowItem = library.workItemRows(taskDir).find((one) => one.kind === "flow");
    if (flowItem) {
      const existing = { record_id: flowItem.record_id, name: flowItem.name, node: flowItem.activity };
      const fact = `任务里已有流程工作项「${flowItem.name}」（记录号 ${flowItem.record_id}，位于「${activityNameOf(library.taskDefinitions(taskDir), flowItem.activity)}」），` +
        "一个任务同一时刻只能有一个流程工作项；要接着做，请打开它的会话，或者换一条干净的会话接着";
      throw new ApiError("rejected", `${fact}。`, { reasons: [fact], existing });
    }
    // 必填的材料槽位还空着：不能启动这条流程，不建会话。
    if (flow?.missing_slot) {
      const fact = `还没有上传「${flow.missing_slot}」，不能启动「${flow.name}」`;
      throw new ApiError("rejected", `${fact}。`, { reasons: [fact] });
    }
    return;
  }
  if (!entry || entry.enabled) return;
  const fact = `现在还不能启动「${entry.name}」：${entry.state}`;
  throw new ApiError("rejected", `${fact}。`, { reasons: [fact] });
}

/**
 * 删除一个工作项的请求没有给会话时在哪条会话里做：这个工作项最近有动静的那条还在的会话（任务状况里的 latest_session）。
 * 记录号写得不对、没有这个工作项、它一条还在的会话都没有时返回 null，照常转交（由助手一侧拒绝，或者在助手现在开着的会话里做）。
 */
function deleteSession(taskDir: string, body: Record<string, any>, sessions: readonly SessionFact[]): string | null {
  const recordId = isObject(body.fields) ? body.fields.activity_record_id : undefined;
  const row = library.workItemRows(taskDir).find((one) => one.record_id === recordId);
  return row ? workItemView(row, sessions).latest_session?.session_id ?? null : null;
}

/** 用户打的字首字符是斜杠时，前面加「用户说：」，免得被 pi 当作扩展命令吞掉。 */
export const SLASH_PREFIX = "用户说：";
export function rewriteSlash(text: string): string {
  return text.startsWith("/") ? SLASH_PREFIX + text : text;
}

/** 用户附了材料时在话后面补一句路径；Word 材料与 PDF 材料另各说一句读哪份投影、出处怎么写。 */
export function withAttachments(text: string, paths: string[]): string {
  if (!paths.length) return text;
  const words = paths.filter((p) => p.toLowerCase().endsWith(".docx"));
  const pdfs = paths.filter((p) => p.toLowerCase().endsWith(".pdf"));
  const notes = [
    ...(words.length ? [`其中 Word 文件请读同名加 .md 的文字版（${words.map((p) => p + ".md").join("、")}），引用时出处写 Word 文件加段落号`] : []),
    ...(pdfs.length ? [`${words.length ? "" : "其中 "}PDF 文件请读同名加 .md 的文字版（${pdfs.map((p) => p + ".md").join("、")}），引用时出处写 PDF 文件加页与块，例如 ${pdfs[0]}#p3-2`] : []),
  ];
  return `${text}\n（我上传了材料：${paths.join("、")}${notes.length ? "；" + notes.join("；") : ""}）`;
}

/**
 * 卡片点击的标注。两种写法都认：annotation {reply_message_id, option_key, option_text}；
 * 前端的 card {reply_message_id, kind, choice}，choice 是选项的 key 或「不对」「采纳」之类的按钮字；
 * choice 是 typed 时不是点击：用户在这张卡片的文本框里打了一句话（text 就是他打的字），扩展照打的字处理，只标明写在哪张卡片里。
 * card 写法里没有选项的文字：按 reply_message_id 在会话条目里找到那条回复，从它「回复」工具参数的 act.options 里按键查回文字；
 * 查不到（「不对」「采纳」这类按钮，或那条回复不在条目里）就用 choice 本身。
 */
export function cardAnnotation(body: Record<string, any>, entries: Record<string, any>[] = []): Record<string, any> {
  if (isObject(body.annotation)) return body.annotation;
  const card: Record<string, any> = isObject(body.card) ? body.card : {};
  const choice = card.choice ?? null;
  const text = replyOptionText(entries, card.reply_message_id ?? null, choice);
  return { reply_message_id: card.reply_message_id ?? null, option_key: choice, option_text: text !== null ? text : choice, card_kind: card.kind ?? null };
}

/** 那条回复的卡片上，键为 key 的选项的文字；找不到返回 null。 */
export function replyOptionText(entries: Record<string, any>[], replyId: unknown, key: unknown): unknown {
  if (!truthy(replyId) || key === null || key === undefined) return null;
  for (const e of entries) {
    if (e.id !== replyId || e.type !== "message") continue;
    for (const part of or((e.message || {}).content, []) as unknown[]) {
      if (isObject(part) && part.type === "toolCall" && part.name === "reply") {
        const act = or(or(part.arguments, {}).act, {});
        for (const option of or(act.options, []) as unknown[]) {
          if (isObject(option) && option.key === key) return option.text ?? null;
        }
      }
    }
  }
  return null;
}

/** SSE 的一条事件：库事件带 id 行；补发与实时推送重叠的那几条只发一次。写了返回真。 */
function writeEvent(res: ServerResponse, sub: Subscriber, name: string, seq: number | null, data: unknown): boolean {
  if (seq !== null) {
    if (seq <= sub.lastSeq) return false;
    sub.lastSeq = seq;
  }
  res.write(`event: ${name}\n` + (seq !== null ? `id: ${seq}\n` : "") + "data: " + pyDumps(data) + "\n\n");
  return true;
}

/** 事件流的保活间隔（毫秒）。 */
export const KEEPALIVE_MS = 15_000;

/** 本机回环地址：退出接口只接受从这些地址来的请求（::ffff:127.0.0.1 是 IPv4 回环地址在 IPv6 套接字上的写法）。 */
export const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

/**
 * 服务信息：不需要任务。给打包后的启动程序认出端口上是不是自己、给部署与监控探活、给前端按能力显示按钮。
 * remote 是请求的来源地址：退出接口只接受本机回环地址来的请求，所以 capabilities.exit 只对这些来源为真，
 * 从别的电脑打开页面时不显示一个点了也会被拒绝的「退出服务」。不给来源时按非本机算。
 * capabilities.model_config 表示页面能不能改模型配置；现在从任何地方打开都能改，恒为 true（字段保留给以后加登录时用）。
 * capabilities.model_test 表示有测试模型的接口（语言模型与嵌入模型都经它），页面据此显示「测试」按钮。
 */
export function serviceInfo(service: Service, remote: string | null = null) {
  // 模型探测每次都现查（只读两个小文件）：用户放好配置文件后，刷新页面即可看到结果。
  // 原因句里的文件路径只在桌面形态写全（服务器形态远程也看得到，不带出服务器上的目录）。
  const model = probeModel(service.profile, process.env, { paths: service.mode === "desktop" });
  return {
    ok: true, app: "taskwright", version: appVersion(), mode: service.mode, pid: process.pid, port: service.port,
    // 调试模式开没开（启动参数 --debug）：页面据此显示设置里的「提示词目录」与调试用的面板。
    debug: service.debug,
    // 启动时发现有上一版留下的数据要先升级、而升级还没有做完：页面据此整屏显示数据升级页，别的接口这时一律答 upgrade_pending。
    upgrade_pending: service.upgrade?.blocking ?? false,
    capabilities: { exit: service.mode === "desktop" && LOOPBACK.has(remote ?? ""), model: model.available, model_config: true, model_test: true, knowledge: service.knowledge !== null },
    model: { name: model.name, reason: model.reason },
    // 上传上限与超过时的那句话：前端在发送之前按它拦下过大的文件（经开发服务器的代理上传过大文件时，代理可能回 502）。
    // extensions 是允许上传的扩展名，前端据此过滤可选的文件、在发送之前拦下类型不符的文件；types_text 是这些类型给人看的一串，
    // 前端写上传框的说明用；unsupported_type_text 是类型不符时的那句话。叫法只在后端有一份。
    upload: { max_bytes: maxUpload(), too_large_text: tooLargeText(), extensions: [...UPLOAD_TYPES], types_text: uploadTypesText(), unsupported_type_text: unsupportedTypeText() },
    // 在页面上导入数据包时的上限与超过时的那句话（更大的包用命令行导入）。
    pack_upload: { max_bytes: PACK_MAX_UPLOAD, too_large_text: PACK_UPLOAD_TOO_LARGE_TEXT },
    // 知识库文档的上传：类型与材料相同，上限另算；kinds 是文档种类的取值与中文叫法。没有知识库时不给。
    // 两种上限都按设置文件现读，设置页改了之后页面重新取一次服务信息就是新的。
    ...(service.knowledge !== null ? {
      knowledge_upload: {
        max_bytes: knowledgeMaxUpload(), too_large_text: knowledgeTooLargeText(), extensions: [...UPLOAD_TYPES], types_text: uploadTypesText(),
        unsupported_type_text: unsupportedTypeText(), kinds: Object.entries(KIND_NAMES).map(([kind, name]) => ({ kind, name })),
      },
    } : {}),
  };
}

/** 模型配置各接口的环境。 */
function modelContext(service: Service): modelConfig.Context {
  return { env: process.env, profile: service.profile };
}

/**
 * 导出一个数据包并作为下载发出去：先在系统临时目录里打成一个文件（这一步出错还能照常答一个错误），再带着长度发出，发完删掉。
 * 导出不改原数据，助手正在工作的任务也可以导（清单文件里记着）。
 */
async function packDownload(service: Service, options: Omit<ExportOptions, "to">, name: string): Promise<Stream> {
  const dir = mkdtempSync(join(tmpdir(), "taskwright-export-"));
  const file = join(dir, name);
  let bytes: number;
  try {
    bytes = (await exportPack(service.packLocations(), { segmentParams: segmentParamsOf(service.profile), ...options, to: file })).bytes;
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    if (error instanceof PackError) throw new ApiError(error.code === "not_found" ? "not_found" : "rejected", error.message);
    throw error;
  }
  return {
    stream: async (res) => {
      try {
        res.writeHead(200, { "Content-Type": "application/zip", "Content-Length": bytes, "Content-Disposition": `attachment; filename="${name}"` });
        await pipeline(createReadStream(file), res);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  };
}

const handlers: Record<string, Handler> = {
  // 删除一个任务（任务目录与它的会话归档）：助手正在工作时拒绝。请求从哪里来写进服务日志：来源地址与浏览器标识。
  delete_task: async (service, req) => {
    const t = service.task(req.params.task);
    const agent = typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"] : "";
    return json(200, await service.deleteTask(t, [req.remote ?? "未知地址", agent].filter(Boolean).join("，")));
  },
  // 把一个任务导出成数据包（任务目录与它的对话记录），回一个 zip 文件。查询参数 with_events=1 时另带事件归档（pi-events），
  // with_materials=1 时另带材料原件与派生文件（缺省只带材料清单）。
  // diagnostic=1 时导出成诊断包（固定带事件归档、不带材料原件，另带后端日志与设置摘录；with_events 与 with_materials 不看），文件名是 diag-<任务编号>-<时刻>。
  export_task: (service, req) => {
    const t = service.task(req.params.task);
    const working = () => t.executor.state === "working";
    if (req.query.diagnostic === "1") {
      const settings = settingsExcerpt(piAgentDir(process.env), process.env);
      const logsDir = logDir(service.packLocations().dataDir);
      const launchModel = launchModelOf(resolveModel(service.profile));
      return packDownload(service, { scope: "task", taskId: t.taskId, working, diagnostic: { settings, logsDir, launchModel } }, diagnosticPackName(t.taskId));
    }
    return packDownload(service, { scope: "task", taskId: t.taskId, working, withEvents: req.query.with_events === "1",
      withMaterials: req.query.with_materials === "1" }, `${t.taskId}${PACK_SUFFIX}`);
  },
  // 把一个知识库导出成数据包。查询参数 with_materials=1 时另带文档原件与派生文件（缺省只带文档清单）。
  export_library: (service, req) => {
    const row = service.requireKnowledge().library(req.params.lib);
    return packDownload(service, { scope: "library", libraryId: row.id, withMaterials: req.query.with_materials === "1" }, `${row.id}${PACK_SUFFIX}`);
  },
  service_info: (service, req) => json(200, serviceInfo(service, req.remote ?? null)),
  // 数据升级：看要升级什么、做到哪里了、做完后的报告。没有要做的升级（多数时候）时 upgrade 是 null。
  service_upgrade: (service) => json(200, { ok: true, upgrade: service.upgrade ? service.upgrade.view() : null }),
  // 开始数据升级：立刻返回，页面随后用上面的接口看进度。能打开页面的人就能开始，不限本机（升级之前有备份，升级不改任务的内容；
  // 与退出服务不同，那个接口只接受本机来的请求）。
  service_upgrade_start: (service) => {
    if (!service.upgrade) throw new ApiError("rejected", "现在没有要做的数据升级。");
    const started = service.upgrade.start();
    return json(200, { ok: true, started, upgrade: service.upgrade.view() });
  },
  model_config: (service, req) => json(200, modelConfig.view(modelContext(service))),
  // 调试模式的三个接口（debug_prompt.ts）；不是调试模式时都答 not_found。
  debug_prompt_dir: (service) => json(200, debugPrompt.promptDirView(service)),
  debug_prompt_dir_set: async (service, req) => json(200, await debugPrompt.setPromptDir(service, bodyJson(req))),
  // 上传上限（设置页的「上传」一栏）：任务材料与知识库文档单个文件的上限，MB，存在设置文件里，下一次上传就按新的算。
  upload_limits: () => json(200, uploadLimitsView()),
  upload_limits_set: async (_service, req) => {
    const body = bodyJson(req);
    for (const field of ["material_mb", "knowledge_mb"]) {
      if (!validUploadMb(body[field])) throw new ApiError("bad_request", `${field} 要写 1 到 ${UPLOAD_CAP_MB} 的整数。`, { field });
    }
    await writeUploadLimits({ material_mb: body.material_mb, knowledge_mb: body.knowledge_mb });
    return json(200, uploadLimitsView());
  },
  debug_system_prompt: (service, req) => json(200, debugPrompt.lastSystemPrompt(service, req.params.task)),
  debug_stage: (service, req) => json(200, debugPrompt.stageDebug(service, req.params.task)),
  // 任务状况：现在的阶段、各章的节数、图与条目的计数、这一段还差什么、开着的提议。程序算出来的，不经助手；没有阶段的任务 status 为 null。
  // 带了 session 时，activity、missing、proposal 三项说的是那条会话；每个工作项最近有动静的会话取自会话清单。
  task_status: (service, req) => {
    const t = service.task(req.params.task);
    return json(200, { ok: true, status: taskStatus(t.dir, sessionParam(req), t.executor.listSessions() as never) });
  },
  // 版本记录：各版的清单（与任务状况里的 versions 相同），与某一版发布时存档的文档（format=md 或 docx，不写是 md）。
  list_versions: (service, req) => {
    const t = service.task(req.params.task);
    return json(200, { ok: true, versions: library.versionRows(t.dir).map((row) => library.versionView(row, t.dir)) });
  },
  // 页面发布一个版本：body 写 { revision_no（页面当时看到的修订号）, note（发布说明，可空）, images（页面画好的图，同「下载 Word」） }。
  // 先定下版本号、把这一版的文档写进任务目录，再发界面操作 publish_version 核对与记下版本；没有记成就删掉写好的存档，照原话回答。
  publish_version: async (service, req) => {
    const t = service.task(req.params.task);
    const body = bodyJson(req);
    const revisionNo = body.revision_no;
    if (!Number.isInteger(revisionNo) || revisionNo < 0) throw new ApiError("bad_request", "revision_no 要写页面当时看到的修订号，一个不小于 0 的整数。");
    if (body.note !== undefined && body.note !== null && typeof body.note !== "string") throw new ApiError("bad_request", "note 要写一句话，或者不写。");
    const images = exportDocument.imagesOf(body);
    const versionNo = versionArchive.nextVersion(t.dir);
    const lib = library.libraryOf(t.dir);
    const names = new Map((service.knowledge?.libraries() ?? []).map((one) => [one.id, one.name]));
    const written = await versionArchive.writeArchive(t.dir, versionNo, revisionNo, images, await wordsLocator(t, lib), (id) => names.get(id) ?? null);
    let done;
    try {
      done = await t.executor.actionWith(sessionParam(req, body), { kind: "publish_version", targets: [], notify_executor: false,
        fields: { revision_no: revisionNo, version_no: versionNo, note: body.note ?? null, ...written } });
    } catch (error) {
      versionArchive.dropArchive(t.dir, versionNo);
      throw error;
    }
    return json(200, { ok: true, op_id: done.op_id, version_no: versionNo, revision_no: revisionNo,
      figure_count: written.figure_count, figure_pictures: written.figure_pictures });
  },
  // 助手发布版本时请任务服务写存档：body 写 { version_no, revision_no }。只写文件，不记版本；没有页面画的图，Word 里写 Mermaid 文本。
  archive_version: async (service, req) => {
    const t = service.task(req.params.task);
    const body = bodyJson(req);
    const versionNo = body.version_no;
    const revisionNo = body.revision_no;
    if (!Number.isInteger(versionNo) || versionNo < 1 || !Number.isInteger(revisionNo) || revisionNo < 0) {
      throw new ApiError("bad_request", "version_no 要写从 1 起的整数，revision_no 要写不小于 0 的整数。");
    }
    if (versionNo !== versionArchive.nextVersion(t.dir)) throw new ApiError("rejected", `下一版是第 ${versionArchive.nextVersion(t.dir)} 版，不是第 ${versionNo} 版。`);
    const lib = library.libraryOf(t.dir);
    const names = new Map((service.knowledge?.libraries() ?? []).map((one) => [one.id, one.name]));
    const written = await versionArchive.writeArchive(t.dir, versionNo, revisionNo, new Map(), await wordsLocator(t, lib), (id) => names.get(id) ?? null);
    return json(200, { ok: true, ...written });
  },
  version_document: (service, req) => {
    const t = service.task(req.params.task);
    const n = Number(req.params.version);
    const format = req.query.format || "md";
    if (format !== "md" && format !== "docx") throw new ApiError("bad_request", "format 要写 md 或 docx，不写是 md。");
    const row = library.versionRows(t.dir).find((one) => one.version_no === n);
    if (!row) throw new ApiError("not_found", `这个任务没有第 ${req.params.version} 版。`);
    const what = format === "md" ? "Markdown" : "Word";
    const rel = format === "md" ? row.markdown_path : row.docx_path;
    if (rel === null) {
      throw new ApiError("not_found", `第 ${n} 版没有 ${what} 存档${row.note === UPGRADED_VERSION_NOTE ? "：这一版是升级之前完成的，当时的文档没有存下来" : ""}。`);
    }
    const root = resolve(t.dir);
    const file = resolve(root, rel);
    if (!file.startsWith(root + sep) || !isFile(file)) throw new ApiError("not_found", `第 ${n} 版的 ${what} 存档不在任务目录里了。`);
    const lib = library.libraryOf(t.dir);
    const taskName = String(or(lib.data.task?.task_name, lib.definition["任务名"]) ?? t.taskId);
    const plain = `${t.taskId.replace(/[^A-Za-z0-9._-]+/g, "_")}-v${n}.${format}`;
    const encoded = encodeURIComponent(`${taskName}-第${n}版.${format}`).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
    return {
      status: 200,
      headers: { "Content-Type": format === "md" ? "text/markdown; charset=utf-8" : exportDocx.DOCX_TYPE, "Content-Disposition": `attachment; filename="${plain}"; filename*=UTF-8''${encoded}` },
      body: readFileSync(file),
    };
  },
  debug_persona_draft: async (service, req) => json(200, await debugPrompt.personaDraftOf(service, req.params.task)),
  model_provider_add: async (service, req) => json(200, await modelConfig.addProvider(modelContext(service), bodyJson(req))),
  model_provider_update: async (service, req) => json(200, await modelConfig.updateProvider(modelContext(service), req.params.provider, bodyJson(req))),
  model_provider_delete: async (service, req) => json(200, await modelConfig.deleteProvider(modelContext(service), req.params.provider)),
  model_provider_check: async (service, req) => json(200, await modelConfig.checkProvider(modelContext(service), req.params.provider)),
  model_provider_fetch: async (service, req) => json(200, await modelConfig.fetchModels(modelContext(service), req.params.provider)),
  model_provider_refresh: async (service, req) => json(200, await modelConfig.refreshCatalog(modelContext(service), req.params.provider)),
  model_provider_context: async (service, req) => json(200, await modelConfig.contextWindow(modelContext(service), req.params.provider, bodyJson(req))),
  model_selection: async (service, req) => json(200, await modelConfig.select(modelContext(service), bodyJson(req))),
  model_test: async (service, req) => json(200, await modelTest.testModel(modelContext(service), bodyJson(req))),
  service_exit: (service, req) => {
    // 只有桌面形态注册这个接口；服务器形态下与没有这个接口一样。它是过渡包（后端自己开浏览器、没有外壳）专用的。
    if (service.mode !== "desktop") throw new ApiError("not_found", `没有这个接口：${req.method} ${req.path}`);
    if (!LOOPBACK.has(req.remote ?? "")) throw new ApiError("forbidden", "退出服务只接受从本机发来的请求。");
    return { ...json(200, { ok: true }), after: () => service.exitHandler?.() };
  },
  list_tasks: (service) => json(200, { ok: true, tasks: service.listTasks() }),
  list_task_types: (service) => json(200, { ok: true, task_types: taskTypes(service.typesRoot) }),
  create_task: (service, req) => json(200, service.create(bodyJson(req))),
  get_task: (service, req) => json(200, { ok: true, ...service.taskPage(service.task(req.params.task)) }),
  // 会话清单：缺省不列归档的会话；带 ?archived=1 时也列，每条标明是不是归档的。
  list_sessions: (service, req) => json(200, { ok: true, sessions: service.sessionRows(service.task(req.params.task), req.query.archived === "1") }),
  // 新建会话。请求体里写了 activity_record_id 时，这条新会话接着做那个进行中的工作项（换一条干净的会话接着做）：先核对有这个工作项、
  // 它还在进行中，再新建会话并把它挂上去；回应里另带工作项的记录号。不写时新建的是自由讨论的会话，不属于任何工作项。
  new_session: async (service, req) => {
    const t = service.task(req.params.task);
    const body = bodyJson(req);
    if (body.activity_record_id === undefined || body.activity_record_id === null) return json(200, { ok: true, session_id: await t.executor.newSession() });
    const action = { kind: "continue_activity", task_id: t.taskId, targets: [], fields: { activity_record_id: body.activity_record_id }, notify_executor: false };
    if (!needsNewSession(action)) throw new ApiError("bad_request", "activity_record_id 是工作项的记录号，一个从 1 起的整数。");
    refuseBeforeNewSession(t.dir, action);
    const session = await t.executor.newSession();
    const done = await t.executor.actionWith(session, action);
    return json(200, { ok: true, session_id: session, activity_record_id: done.activity_record_id });
  },
  snapshot: async (service, req) => {
    const t = service.task(req.params.task);
    return json(200, { ok: true, ...(await service.snapshot(t, sessionParam(req))) });
  },
  conversation: async (service, req) => {
    const t = service.task(req.params.task);
    const session = sessionParam(req);
    if (!session) throw new ApiError("bad_request", "要带 session 参数。");
    const all = conversation.messages(await t.executor.entries(session), session, t.definition(), t.dir);
    const raw = req.query.limit || "100";
    if (!/^\s*[-+]?\d+\s*$/.test(raw)) throw new Error(`invalid literal for int() with base 10: '${raw}'`);
    return json(200, { ok: true, ...conversation.page(all, req.query.before ?? null, Number(raw)) });
  },
  messages: async (service, req) => {
    const t = service.task(req.params.task);
    const body = bodyJson(req);
    const text = String(or(body.text, "")).trim();
    if (!text) throw new ApiError("bad_request", "text 不能是空的。");
    const attachments = (or(body.attachments, []) as string[]);
    for (const rel of attachments) {
      if (!isFile(service.materialPath(t, rel))) throw new ApiError("bad_request", `附件 ${rel} 不在材料目录里。`);
    }
    const session = sessionParam(req, body);
    const clientId = body.client_id ?? null;
    let queued: boolean;
    if (body.origin === "card_choice") {
      const annotation = cardAnnotation(body, session ? await t.executor.entries(session) : []);
      // 卡片是在同一个工作项的另一条会话里发的（用户从「待决定」一行点了进入）：这条会话里找不到选项的文字，取这条会话的工作项开着的提议上写的。
      if (annotation.option_text === annotation.option_key) {
        const open = library.stageView(t.dir, session)?.proposal ?? null;
        if (open !== null && open.enter.key === annotation.option_key) annotation.option_text = open.enter.text;
      }
      // choice 是 typed：用户在卡片的文本框里打的字，不是点击；与底部输入框打的字一样，斜杠开头的前面加「用户说：」。
      queued = await t.executor.cardClick(session, annotation.option_key === conversation.CARD_TYPED_KEY ? rewriteSlash(text) : text, clientId, annotation);
    } else {
      queued = await t.executor.say(session, withAttachments(rewriteSlash(text), attachments), clientId, text);
    }
    return json(200, { ok: true, client_id: clientId, queued });
  },
  actions: async (service, req) => {
    const t = service.task(req.params.task);
    const body = bodyJson(req);
    let session = sessionParam(req, body);
    // 启动一个工作项、换一条会话接着做一个工作项：先核对行不行，行才新建会话，再在新会话里做；回应里带新会话的编号与工作项的记录号。
    let created: string | null = null;
    if (needsNewSession(body)) {
      refuseBeforeNewSession(t.dir, body);
      created = session = await t.executor.newSession();
    }
    // 删除一个工作项而没有给会话（例如从任务起点页删）：在这个工作项最近有动静的会话里做，那句说明随之留在那条（随即归档的）会话里。
    if (body.kind === "delete_work_item" && !session) session = deleteSession(t.dir, body, t.executor.listSessions() as never);
    // 发布版本要先写好这一版的文档存档，走 POST …/versions，不走这里。
    if (body.kind === "publish_version") throw new ApiError("bad_request", "发布版本请用 POST /api/v1/tasks/{task_id}/versions：要先存下这一版的文档。");
    const done = await t.executor.actionWith(session, body);
    return json(200, { ok: true, client_id: body.client_id ?? null, op_id: done.op_id, ...(created !== null ? { session_id: created } : {}),
      ...(done.activity_record_id !== null ? { activity_record_id: done.activity_record_id } : {}),
      ...(done.archived_sessions !== null ? { archived_sessions: done.archived_sessions } : {}) });
  },
  control: async (service, req) => {
    const t = service.task(req.params.task);
    const body = bodyJson(req);
    if (body.action !== "stop") throw new ApiError("bad_request", "action 现在只能是 stop。");
    return json(200, { ok: true, cleared: await t.executor.stop(sessionParam(req, body)) });
  },
  events: (service, req) => {
    const t = service.task(req.params.task);
    const raw = String(req.headers["last-event-id"] ?? "") || req.query.last_event_id || "";
    const last = raw && /^[0-9]+$/.test(raw) ? Number(raw) : null;
    const [sub, replay] = t.hub.subscribe(sessionParam(req), last);
    return {
      stream: async (res) => {
        let open = true;
        res.on("close", () => {
          open = false;
          t.hub.unsubscribe(sub);
        });
        try {
          res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache", "X-Accel-Buffering": "no" });
          res.write(": connected\n\n");
          for (const [name, seq, data] of replay) writeEvent(res, sub, name, seq, data);
          while (open && !t.hub.closed) {
            const item = await sub.get(KEEPALIVE_MS);
            if (!open) break;
            if (item === null && t.hub.closed) break;
            if (item === null) res.write(": keepalive\n\n");
            else writeEvent(res, sub, ...item);
          }
        } finally {
          t.hub.unsubscribe(sub);
          res.end();
        }
      },
    };
  },
  revisions: (service, req) => {
    const rows = library.itemRevisions(service.task(req.params.task).dir, req.params.item);
    if (rows === null) throw new ApiError("not_found", `没有条目 ${req.params.item}。`);
    return json(200, { ok: true, item_id: req.params.item, revisions: rows });
  },
  diagrams: (service, req) => json(200, { ok: true, diagrams: library.diagramList(service.task(req.params.task).dir) }),
  diagram: (service, req) => {
    const one = library.diagramDetail(service.task(req.params.task).dir, req.params.diagram);
    if (one === null) throw new ApiError("not_found", `没有图 ${req.params.diagram}。`);
    return json(200, { ok: true, diagram: one });
  },
  // 校验一段 Mermaid 文本的写法，不保存。助手的「保存图」工具保存之前来问（agent/src/lib/diagram_check.ts），页面改图时也可以问。
  // 文本写得不对不是请求出错：回 200，valid 为假，reason、line、message 照校验模块原样。只有种类写错算请求不对。
  validate_diagram: async (service, req) => {
    service.task(req.params.task);
    const body = bodyJson(req);
    if (!(DIAGRAM_KINDS as readonly unknown[]).includes(body.kind)) {
      throw new ApiError("rejected", `图的种类要写 ${DIAGRAM_KINDS.join("、")} 里的一个，收到的是 ${JSON.stringify(body.kind ?? null)}。`, { field: "kind" });
    }
    const check = await validateDiagram(body.kind, body.mermaid);
    return json(200, check.ok ? { ok: true, valid: true } : { ok: true, valid: false, reason: check.reason, line: check.line, message: check.message });
  },
  revision_log: async (service, req) => json(200, { ok: true, ...(await service.revisionLog(service.task(req.params.task))) }),
  material: (service, req) => {
    const t = service.task(req.params.task);
    const rel = req.query.path ?? "";
    const target = service.materialPath(t, rel);
    service.requireMaterialFile(t, rel, target);
    return json(200, { ok: true, path: rel, text: service.materialText(target, rel) });
  },
  material_raw: (service, req) => {
    const t = service.task(req.params.task);
    const rel = req.query.path ?? "";
    const target = service.materialPath(t, rel);
    service.requireMaterialFile(t, rel, target);
    return { status: 200, headers: { "Content-Type": RAW_TYPES[extname(target).toLowerCase()] ?? "application/octet-stream" }, body: readFileSync(target) };
  },
  upload: async (service, req) => {
    const t = service.task(req.params.task);
    const form = parseMultipartForm(String(req.headers["content-type"] ?? ""), req.body);
    if (!form.file) throw new ApiError("bad_request", "请求里没有文件。");
    const [name, data] = form.file;
    // 可选的文字字段 slot：放进哪个槽位（流程声明里收材料的槽位键）。PDF 材料要另起一次运行生成派生文件，等它做完才回答；别的类型当场就有结果。
    return json(200, await service.upload(t, name, data, sessionParam(req), null, form.fields.slot ?? null));
  },
  delete_material: (service, req) => {
    const t = service.task(req.params.task);
    const body = bodyJson(req);
    return json(200, service.deleteMaterial(t, body.path, sessionParam(req, body)));
  },
  // 替换一份材料：被替换的那份的路径在查询参数 path 里，新文件照上传的格式放在请求体里。
  replace_material: async (service, req) => {
    const t = service.task(req.params.task);
    const [name, data] = parseMultipart(String(req.headers["content-type"] ?? ""), req.body);
    return json(200, await service.replaceMaterial(t, req.query.path ?? "", name, data, sessionParam(req)));
  },
  knowledge: (service) => json(200, { ok: true, libraries: service.knowledgeOverview(), embedding: service.knowledgeEmbedding() }),
  embed_knowledge: (service, req) => json(200, service.embedKnowledge(bodyJson(req))),
  search_knowledge: async (service, req) => json(200, await service.searchKnowledge(bodyJson(req), req.signal)),
  create_library: (service, req) => json(200, { ok: true, library: service.requireKnowledge().create(bodyJson(req).name) }),
  rename_library: (service, req) => json(200, { ok: true, library: service.requireKnowledge().rename(req.params.lib, bodyJson(req).name) }),
  delete_library: (service, req) => json(200, service.removeLibrary(req.params.lib)),
  upload_document: async (service, req) => {
    service.requireKnowledge();
    const form = parseMultipartForm(String(req.headers["content-type"] ?? ""), req.body);
    if (!form.file) throw new ApiError("bad_request", "请求里没有文件。");
    const [name, data] = form.file;
    const row = await service.uploadDocument(req.params.lib, name, data, form.fields.kind);
    const { sha256: _, ...document } = row;
    return json(200, { ok: true, document });
  },
  delete_document: (service, req) => {
    service.removeDocument(req.params.lib, bodyJson(req).name);
    return json(200, { ok: true });
  },
  document: (service, req) => {
    const name = req.query.name ?? "";
    return json(200, { ok: true, name, text: service.requireKnowledge().text(req.params.lib, name) });
  },
  document_raw: (service, req) => {
    const target = service.requireKnowledge().filePath(req.params.lib, req.query.name ?? "");
    return { status: 200, headers: { "Content-Type": RAW_TYPES[extname(target).toLowerCase()] ?? "application/octet-stream" }, body: readFileSync(target) };
  },
  task_knowledge: (service, req) => {
    const t = service.task(req.params.task);
    service.requireKnowledge();
    // embedding 按这个任务选用的知识库算：选定的嵌入模型、是不是都换算好了、还差几份（按意思查找据此决定能不能用）。
    const libraries = service.taskPage(t).knowledge_libraries;
    const { model, ready, pending } = service.knowledgeEmbedding(libraries);
    return json(200, { ok: true, libraries, embedding: { model, ready, pending } });
  },
  set_task_knowledge: (service, req) => json(200, service.setTaskKnowledge(service.task(req.params.task), bodyJson(req))),
  documents: async (service, req) => {
    const t = service.task(req.params.task);
    const body = bodyJson(req);
    const format = or(body.format, "markdown");
    if (format !== "markdown" && format !== "docx") throw new ApiError("bad_request", "format 要写 markdown 或 docx，不写是 markdown。");
    const lib = library.libraryOf(t.dir);
    // 知识库来源的出处在文档里写知识库的名字：名字取自现在的知识库清单，已经不在的写编号。
    const names = new Map((service.knowledge?.libraries() ?? []).map((one) => [one.id, one.name]));
    if (format === "docx" && body.whole === true) {
      // 整份文档的 Word 文件：与预览、Markdown 同一份内容（同一个模板、同一次修订、同一批选中的条目），照同一批块写；
      // 图由页面转成 PNG 随请求交来（images），没有交来的写它的 Mermaid 文本。
      if (req.params.mode !== "download") throw new ApiError("bad_request", "Word 文件只能下载，不能预览。");
      const [revisionNo, items] = render.documentRequest(body);
      const images = exportDocument.imagesOf(body);
      const text = render.render(t.dir, lib, revisionNo, items, await wordsLocator(t, lib), (id) => names.get(id) ?? null);
      const taskName = String(or(lib.data.task?.task_name, lib.definition["任务名"]) ?? t.taskId);
      const fileName = exportDocument.documentFileName(taskName, revisionNo || lib.latestRevision());
      const data = await exportDocument.documentDocx(text, images, taskName);
      return { status: 200, headers: { "Content-Type": exportDocx.DOCX_TYPE, "Content-Disposition": exportDocx.docxDisposition(fileName, t.taskId, "document") }, body: data };
    }
    if (format === "docx") {
      // 选中的条目导出成 Word 文件：只能下载，导出的是每个条目最新的修订。
      if (req.params.mode !== "download") throw new ApiError("bad_request", "Word 文件只能下载，不能预览。");
      const [chosen, withSources] = exportDocx.docxRequest(body);
      const file = await exportDocx.exportItemsDocx(lib, chosen, withSources, await wordsLocator(t, lib), (id) => names.get(id) ?? null);
      return { status: 200, headers: { "Content-Type": exportDocx.DOCX_TYPE, "Content-Disposition": exportDocx.docxDisposition(file.fileName, t.taskId) }, body: file.data };
    }
    const [revisionNo, items] = render.documentRequest(body);
    const text = render.render(t.dir, lib, revisionNo, items, await wordsLocator(t, lib), (id) => names.get(id) ?? null);
    if (req.params.mode === "preview") return json(200, { ok: true, text });
    return {
      status: 200,
      headers: { "Content-Type": "text/markdown; charset=utf-8", "Content-Disposition": `attachment; filename="${t.taskId}.md"` },
      body: Buffer.from(text, "utf-8"),
    };
  },
};

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

const T = "(?<task>[^/]+)";
const L = "(?<lib>[^/]+)";
export const ROUTES: [string, RegExp, string][] = ([
  ["GET", "/api/v1/service", "service_info"],
  ["POST", "/api/v1/service/exit", "service_exit"],
  ["GET", "/api/v1/service/upgrade", "service_upgrade"],
  ["POST", "/api/v1/service/upgrade", "service_upgrade_start"],
  ["GET", "/api/v1/model-config", "model_config"],
  ["POST", "/api/v1/model-config/providers", "model_provider_add"],
  ["POST", "/api/v1/model-config/providers/(?<provider>[^/]+)", "model_provider_update"],
  ["POST", "/api/v1/model-config/providers/(?<provider>[^/]+)/delete", "model_provider_delete"],
  ["POST", "/api/v1/model-config/providers/(?<provider>[^/]+)/check", "model_provider_check"],
  ["POST", "/api/v1/model-config/providers/(?<provider>[^/]+)/fetch-models", "model_provider_fetch"],
  ["POST", "/api/v1/model-config/providers/(?<provider>[^/]+)/refresh-catalog", "model_provider_refresh"],
  ["POST", "/api/v1/model-config/providers/(?<provider>[^/]+)/context-window", "model_provider_context"],
  ["POST", "/api/v1/model-config/selection", "model_selection"],
  ["POST", "/api/v1/model-config/test", "model_test"],
  ["GET", "/api/v1/debug/prompt-dir", "debug_prompt_dir"],
  ["POST", "/api/v1/debug/prompt-dir", "debug_prompt_dir_set"],
  ["GET", "/api/v1/settings/uploads", "upload_limits"],
  ["POST", "/api/v1/settings/uploads", "upload_limits_set"],
  ["GET", "/api/v1/tasks", "list_tasks"],
  ["GET", "/api/v1/task-types", "list_task_types"],
  ["POST", "/api/v1/tasks", "create_task"],
  ["GET", `/api/v1/tasks/${T}`, "get_task"],
  ["GET", `/api/v1/tasks/${T}/export`, "export_task"],
  ["POST", `/api/v1/tasks/${T}/delete`, "delete_task"],
  ["GET", `/api/v1/tasks/${T}/sessions`, "list_sessions"],
  ["POST", `/api/v1/tasks/${T}/sessions`, "new_session"],
  ["GET", `/api/v1/tasks/${T}/events`, "events"],
  ["GET", `/api/v1/tasks/${T}/snapshot`, "snapshot"],
  ["GET", `/api/v1/tasks/${T}/items/(?<item>[^/]+)/revisions`, "revisions"],
  ["GET", `/api/v1/tasks/${T}/revisions`, "revision_log"],
  ["GET", `/api/v1/tasks/${T}/diagrams`, "diagrams"],
  ["POST", `/api/v1/tasks/${T}/diagrams/validate`, "validate_diagram"],
  ["GET", `/api/v1/tasks/${T}/diagrams/(?<diagram>[^/]+)`, "diagram"],
  ["GET", `/api/v1/tasks/${T}/materials/content`, "material"],
  ["GET", `/api/v1/tasks/${T}/materials/raw`, "material_raw"],
  ["POST", `/api/v1/tasks/${T}/materials`, "upload"],
  ["POST", `/api/v1/tasks/${T}/materials/delete`, "delete_material"],
  ["POST", `/api/v1/tasks/${T}/materials/replace`, "replace_material"],
  ["GET", `/api/v1/tasks/${T}/knowledge`, "task_knowledge"],
  ["POST", `/api/v1/tasks/${T}/knowledge`, "set_task_knowledge"],
  ["GET", "/api/v1/knowledge", "knowledge"],
  ["POST", "/api/v1/knowledge/embed", "embed_knowledge"],
  ["POST", "/api/v1/knowledge/search", "search_knowledge"],
  ["POST", "/api/v1/knowledge/libraries", "create_library"],
  ["POST", `/api/v1/knowledge/libraries/${L}`, "rename_library"],
  ["POST", `/api/v1/knowledge/libraries/${L}/delete`, "delete_library"],
  ["GET", `/api/v1/knowledge/libraries/${L}/export`, "export_library"],
  ["POST", `/api/v1/knowledge/libraries/${L}/documents`, "upload_document"],
  ["POST", `/api/v1/knowledge/libraries/${L}/documents/delete`, "delete_document"],
  ["GET", `/api/v1/knowledge/libraries/${L}/documents/content`, "document"],
  ["GET", `/api/v1/knowledge/libraries/${L}/documents/raw`, "document_raw"],
  ["GET", `/api/v1/tasks/${T}/status`, "task_status"],
  ["GET", `/api/v1/tasks/${T}/versions`, "list_versions"],
  ["POST", `/api/v1/tasks/${T}/versions`, "publish_version"],
  ["POST", `/api/v1/tasks/${T}/versions/archive`, "archive_version"],
  ["GET", `/api/v1/tasks/${T}/versions/(?<version>[0-9]+)/document`, "version_document"],
  ["GET", `/api/v1/tasks/${T}/debug/system-prompt`, "debug_system_prompt"],
  ["GET", `/api/v1/tasks/${T}/debug/stage`, "debug_stage"],
  ["GET", `/api/v1/tasks/${T}/debug/persona-draft`, "debug_persona_draft"],
  ["GET", `/api/v1/tasks/${T}/conversation`, "conversation"],
  ["POST", `/api/v1/tasks/${T}/messages`, "messages"],
  ["POST", `/api/v1/tasks/${T}/actions`, "actions"],
  ["POST", `/api/v1/tasks/${T}/control`, "control"],
  ["POST", `/api/v1/tasks/${T}/documents/(?<mode>preview|download)`, "documents"],
] as const).map(([m, p, n]) => [m, new RegExp(`^${p}$`, "s"), n]);

/** 路由分派：找到方法与路径都对得上的第一个接口，交给它；找不到是 not_found；接口抛的 ApiError 按错误形状回答。 */
/** 数据升级做完之前仍然可用的接口：服务信息、看升级与开始升级、退出服务。页面的静态文件不经这里，照常给。 */
const OPEN_DURING_UPGRADE = new Set(["service_info", "service_upgrade", "service_upgrade_start", "service_exit"]);
export const UPGRADE_PENDING_TEXT = "数据升级还没有做完，做完之前别的功能暂时不能用。";

export async function dispatch(service: Service, req: Omit<Request, "params">): Promise<Reply | Stream> {
  try {
    for (const [method, pattern, name] of ROUTES) {
      const match = pattern.exec(req.path);
      if (method !== req.method || !match) continue;
      // 数据升级做完之前只放行这几个接口：别的都会去读任务或知识库，那些数据可能还是上一版的格式。
      if (service.upgrade?.blocking && !OPEN_DURING_UPGRADE.has(name)) throw new ApiError("upgrade_pending", UPGRADE_PENDING_TEXT);
      return await handlers[name](service, { ...req, params: { ...(match.groups ?? {}) } });
    }
    throw new ApiError("not_found", `没有这个接口：${req.method} ${req.path}`);
  } catch (error) {
    if (error instanceof ApiError) return json(error.status, error.body());
    console.error(error);
    return json(500, { ok: false, error: { code: "internal", message: "后端出错了。", data: { detail: String((error as Error)?.message ?? error) } } });
  }
}

const UNSUPPORTED = (method: string) => Buffer.from(`<!DOCTYPE HTML>
<html lang="en">
    <head>
        <meta charset="utf-8">
        <title>Error response</title>
    </head>
    <body>
        <h1>Error response</h1>
        <p>Error code: 501</p>
        <p>Message: Unsupported method ('${method}').</p>
        <p>Error code explanation: 501 - Server does not support this operation.</p>
    </body>
</html>
`, "utf-8");

function send(res: ServerResponse, reply: Reply, head = false): void {
  const headers: Record<string, string | number> = { ...reply.headers, "Content-Length": reply.body.length };
  if (reply.close) headers.Connection = "close";
  res.writeHead(reply.status, headers);
  res.end(head ? undefined : reply.body);
}

/** 上传上限接口的回答：现在的两个上限、能设到多大与没有设过时的值，都是 MB。 */
function uploadLimitsView() {
  return { ok: true, ...readUploadLimits(), cap_mb: UPLOAD_CAP_MB, defaults: { material_mb: UPLOAD_DEFAULT_MB.material, knowledge_mb: UPLOAD_DEFAULT_MB.knowledge } };
}

/** multipart 的包装（分隔行与各部分的头）最多算多少字节：上传请求体的上限是文件的上限加上它。 */
const MULTIPART_WRAPPING = 64 * 1024;

/** 收文件的三个接口（上传与替换材料、上传知识库文档）各自的上限，与超过时先认的那一样（任务或知识库，不在时照常报 not_found）。 */
interface UploadTarget {
  limit: number;
  text: string;
  owner: () => unknown;
}

/**
 * 收文件的请求体：边收边写进临时目录里的一个文件，收到的超过「文件的上限加包装」就停下；请求头里写的长度已经超过时一字不收。
 * 这两种都先认任务或知识库，再以 too_large 拒绝并关掉连接。收完从临时文件读出来交回，内存里最多是一个上限大小的请求体；
 * 临时目录随即删掉。上限按设置文件现读（设置页可改），文件本身的大小由处理函数再按同一个上限查一次。拒绝了或者出了错时交回 null。
 */
async function receiveUpload(incoming: IncomingMessage, res: ServerResponse, length: number, target: UploadTarget): Promise<Buffer | null> {
  const tooLarge = (): Reply => {
    try {
      target.owner();
      return json(413, new ApiError("too_large", target.text).body());
    } catch (error) {
      return error instanceof ApiError ? json(error.status, error.body()) : json(500, { ok: false, error: { code: "internal", message: "后端出错了。", data: { detail: String(error) } } });
    }
  };
  const max = target.limit + MULTIPART_WRAPPING;
  if (length > max) {
    send(res, { ...tooLarge(), close: true });
    incoming.resume();
    return null;
  }
  const dir = mkdtempSync(join(tmpdir(), "taskwright-upload-"));
  const file = join(dir, "body");
  try {
    const out = createWriteStream(file);
    let received = 0;
    const over = await new Promise<boolean>((done, fail) => {
      incoming.on("data", (chunk: Buffer) => {
        received += chunk.length;
        if (received > max) {
          // 超过上限：后面的不再写，照常读完丢掉。
          incoming.removeAllListeners("data");
          incoming.resume();
          out.destroy();
          done(true);
        } else if (!out.write(chunk)) {
          incoming.pause();
          out.once("drain", () => incoming.resume());
        }
      });
      incoming.on("end", () => out.end(() => done(false)));
      incoming.on("error", fail);
      out.on("error", fail);
    });
    if (over) {
      send(res, { ...tooLarge(), close: true });
      return null;
    }
    return readFileSync(file);
  } catch (error) {
    console.error(error);
    if (!res.destroyed && !res.headersSent) send(res, json(500, { ok: false, error: { code: "internal", message: "后端出错了。", data: { detail: String((error as Error)?.message ?? error) } } }));
    else res.destroy();
    return null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** 导入数据包的两个接口与各自只收哪种范围的包。它们的请求体不经下面「整个读进内存」的那一套，见 receivePack。 */
const PACK_IMPORTS: Record<string, "task" | "library"> = { "/api/v1/tasks/import": "task", "/api/v1/knowledge/import": "library" };

/**
 * 导入数据包：POST /api/v1/tasks/import（范围是一个任务的包）与 POST /api/v1/knowledge/import（范围是一个知识库的包）。
 * 请求体就是 zip 文件的字节（Content-Type: application/zip），不用表单的包装。数据包可以有几百 MB，所以边收边写进任务根目录
 * （知识库是知识库根目录）下的一个暂存目录里，不进内存；请求头里的长度超过上限就不收，没有写长度而实际收到的超过上限就停下，
 * 都以 too_large 拒绝并关掉连接。查询参数 renumber=1 是「改编号导入」。收完交给 data_pack.ts 的 importPack，做完让服务扫描一遍
 * 接手新任务。整个包被拒绝时答 rejected（422），data.report 里是报告；否则答 200 与报告（报告里可以有个别没有导入成的项）。
 * 数据升级还没有做完时与别的接口一样答 upgrade_pending，不收请求体。
 */
async function receivePack(service: Service, incoming: IncomingMessage, res: ServerResponse, only: "task" | "library", query: Record<string, string>, length: number,
  limit: number): Promise<void> {
  const refuse = (error: ApiError) => {
    send(res, { ...json(error.status, error.body()), close: true });
    incoming.resume();
  };
  if (service.upgrade?.blocking) return refuse(new ApiError("upgrade_pending", UPGRADE_PENDING_TEXT));
  let root: string;
  try {
    root = only === "task" ? service.tasksDir : service.requireKnowledge().root;
  } catch (error) {
    return refuse(error as ApiError);
  }
  if (length > limit) return refuse(new ApiError("too_large", PACK_UPLOAD_TOO_LARGE_TEXT));
  const dir = join(root, importingName());
  const file = join(dir, "upload.zip");
  try {
    mkdirSync(dir, { recursive: true });
    const out = createWriteStream(file);
    let received = 0;
    const over = await new Promise<boolean>((done, fail) => {
      incoming.on("data", (chunk: Buffer) => {
        received += chunk.length;
        if (received > limit) {
          // 超过上限：后面的不再写，照常读完丢掉。
          incoming.removeAllListeners("data");
          incoming.resume();
          out.destroy();
          done(true);
        } else if (!out.write(chunk)) {
          incoming.pause();
          out.once("drain", () => incoming.resume());
        }
      });
      incoming.on("end", () => out.end(() => done(false)));
      incoming.on("error", fail);
      out.on("error", fail);
    });
    if (over) return send(res, { ...json(413, new ApiError("too_large", PACK_UPLOAD_TOO_LARGE_TEXT).body()), close: true });
    const report = await importPack(service.packLocations(), { file, label: "上传的数据包", only, onConflict: query.renumber === "1" ? "renumber" : "skip", registry: service.registry });
    // 新任务由扫描接手（占用标记、任务登记都在那里做）。
    service.scan();
    const body = { ...report, text: importText(report) };
    if (!res.destroyed) send(res, report.fatal ? json(422, new ApiError("rejected", report.fatal, { report: body }).body()) : json(200, { ok: true, report: body }));
  } catch (error) {
    console.error(error);
    if (!res.destroyed && !res.headersSent) send(res, json(500, { ok: false, error: { code: "internal", message: "后端出错了。", data: { detail: String((error as Error)?.message ?? error) } } }));
    else res.destroy();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export interface ServerOptions {
  /** 网页静态文件所在的目录；null 时不出页面，所有路径都归接口（与没有这个选项时相同）。 */
  webDir?: string | null;
  /** 导入数据包的接口收多大的请求体（字节）；不给时是 PACK_MAX_UPLOAD。只有测试另给。 */
  packMaxUpload?: number;
}

export function makeServer(service: Service, options: ServerOptions = {}) {
  const webDir = options.webDir ?? null;
  return createServer((incoming, res) => {
    const method = incoming.method ?? "GET";
    if (method !== "GET" && method !== "POST") {
      send(res, { status: 501, headers: { "Content-Type": "text/html;charset=utf-8" }, body: UNSUPPORTED(method), close: true }, method === "HEAD");
      return;
    }
    const raw = incoming.url ?? "/";
    const q = raw.indexOf("?");
    const rawPath = (q >= 0 ? raw.slice(0, q) : raw).split("#")[0];
    const query = parseQuery(q >= 0 ? raw.slice(q + 1).split("#")[0] : "");
    const path = unquote(rawPath).replace(/\/+$/, "") || "/";
    if (webDir !== null && method === "GET" && isWebPath(path)) {
      send(res, webFile(webDir, path));
      incoming.resume();
      return;
    }
    const length = Number(incoming.headers["content-length"] ?? 0) || 0;
    if (method === "POST" && Object.hasOwn(PACK_IMPORTS, path)) {
      void receivePack(service, incoming, res, PACK_IMPORTS[path], query, length, options.packMaxUpload ?? PACK_MAX_UPLOAD);
      return;
    }
    const answer = async (body: Buffer) => {
      // 对方在回答发完之前断开：把这件事交给处理函数（查找知识库据此不再往下算）。
      const gone = new AbortController();
      res.once("close", () => {
        if (!res.writableFinished) gone.abort();
      });
      const reply = await dispatch(service, { method, path, query, headers: incoming.headers, body, remote: incoming.socket.remoteAddress ?? "", signal: gone.signal });
      if ("stream" in reply) {
        await reply.stream(res).catch(() => res.destroy());
        return;
      }
      if (reply.after) res.once("finish", reply.after);
      if (!res.destroyed) send(res, reply);
    };
    // 收文件的三个接口：请求体边收边写临时文件，超过上限就停下拒绝（receiveUpload）。
    const upload = /^\/api\/v1\/tasks\/([^/]+)\/materials(?:\/replace)?$/s.exec(path);
    const knowledgeUpload = /^\/api\/v1\/knowledge\/libraries\/([^/]+)\/documents$/s.exec(path);
    if (method === "POST" && (upload || knowledgeUpload)) {
      const target: UploadTarget = upload
        ? { limit: maxUpload(), text: tooLargeText(), owner: () => service.task(upload[1]) }
        : { limit: knowledgeMaxUpload(), text: knowledgeTooLargeText(), owner: () => service.requireKnowledge().library(knowledgeUpload![1]) };
      void receiveUpload(incoming, res, length, target).then((body) => (body ? answer(body) : undefined));
      return;
    }
    const chunks: Buffer[] = [];
    incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
    incoming.on("end", () => void answer(Buffer.concat(chunks).subarray(0, length)));
    incoming.on("error", () => res.destroy());
  });
}
