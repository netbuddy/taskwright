/**
 * 任务服务：接手 --tasks 目录下的每个任务，拼出各读取接口的数据，建任务，收材料。它不写库（建任务经 agent 的 createTask 除外）。
 *
 * 接手任务时在任务目录里写一份占用标记（service.lock，见 occupancy.ts），退出时删掉；正被别的活着的服务占用的任务不接手：
 * 列表里写明被谁占用，打开它的请求一律以 task_occupied 拒绝。修订统一之前建的任务（旧格式）不接手，列表里标明不支持。
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { DB_NAME } from "../../agent/src/lib/db.ts";
import { DEFAULT_MATERIALS_DIR, type ParsedDefinition, type Row, parseDefinition } from "../../agent/src/lib/task_read.ts";
import * as clock from "./clock.ts";
import { FALLBACK_TEXT, USER_EDIT, baseMessages, branch, textOf } from "./conversation.ts";
import { ApiError } from "./errors.ts";
import { readTextFile, readTextFileLenient } from "./files.ts";
import * as library from "./library.ts";
import * as occupancy from "./occupancy.ts";
import { ProjectionError, isProjection, projectionPath, projectionText, writeProjection } from "./projection.ts";
import { or, pyStr, truthy } from "./py.ts";
import { Sessions } from "./sessions.ts";
import { worksFromEntries } from "./work_summary.ts";
import { CreateTaskError, DEFAULT_TYPE, availableTemplates, createTaskDir } from "./workspace.ts";
import { TASK_TYPES_DIR } from "./paths.ts";

export const MAX_UPLOAD = 5 * 1024 * 1024;
export const UPLOAD_TYPES = [".md", ".txt", ".docx"];

/** 任务类型：task-types/ 下的每个目录，显示名取它的任务定义里的「任务名」；没有新格式任务定义的模板不列。 */
export function taskTypes() {
  const out = [];
  for (const name of availableTemplates()) {
    let label: unknown;
    try {
      label = JSON.parse(readTextFileLenient(join(TASK_TYPES_DIR, name, "docs", "task-definitions", `${name}.json`)))["任务名"];
    } catch {
      continue;
    }
    if (typeof label === "string" && label) out.push({ task_type: name, name: label });
  }
  return out;
}

export function newTaskId(): string {
  const d = new Date();
  const day = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
  return `TASK-${day}-${randomUUID().replaceAll("-", "").slice(0, 4).toUpperCase()}`;
}

/** 一个任务目录连同它的会话。 */
export class Task {
  readonly taskId: string;
  readonly dir: string;
  readonly sessions: Sessions;

  constructor(taskId: string, dir: string, runsDir: string) {
    this.taskId = taskId;
    this.dir = dir;
    this.sessions = new Sessions(runsDir, taskId);
  }

  row(): Row | null {
    const db = library.openRo(this.dir);
    if (db === null) return null;
    try {
      const row = db.prepare("SELECT * FROM task LIMIT 1").get() as Row | undefined;
      return row ? { ...row } : null;
    } finally {
      db.close();
    }
  }

  definition(): ParsedDefinition | Record<string, never> {
    const row = this.row();
    return row ? parseDefinition(row.definition_text) : {};
  }

  requireOpen(): void {
    const row = this.row();
    if (row === null) throw new ApiError("no_task", "这个任务目录里没有任务记录。");
    if (row.status !== "进行中") throw new ApiError("task_closed", `任务已经${pyStr(row.status)}，只能查看。`, { status: row.status });
  }
}

/** 接手任务时写占用标记的函数：缺省是 occupancy.claim；只读对照时换成不写文件的版本。 */
export type Claim = (taskDir: string, port: number | null) => occupancy.Lock | null;

export interface ServiceOptions {
  port?: number | null;
  claim?: Claim;
  release?: (taskDir: string) => void;
  /** 不存在时是否建出任务目录（缺省建）。 */
  createTasksDir?: boolean;
}

/** 按码位排好的目录项。 */
function sortedEntries(dir: string): string[] {
  return readdirSync(dir).sort(library.byCodePoint);
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** 路径解开符号链接后的绝对路径；不存在的尾部照写（与 Python 的 Path.resolve() 相同）。 */
export function resolvePath(path: string): string {
  const full = resolve(path);
  const tail: string[] = [];
  let head = full;
  for (;;) {
    try {
      const real = realpathSync(head);
      return tail.length ? join(real, ...tail.reverse()) : real;
    } catch {
      const parent = resolve(head, "..");
      if (parent === head) return full;
      tail.push(basename(head));
      head = parent;
    }
  }
}

export class Service {
  readonly tasksDir: string;
  readonly runsDir: string;
  readonly profile: unknown;
  readonly port: number | null;
  readonly tasks = new Map<string, Task>();
  /** 正被别的服务占用、本服务没有接手的任务：任务编号 → {lock, dir}。 */
  readonly occupied = new Map<string, { lock: occupancy.Lock; dir: string }>();
  readonly skipped = new Set<string>();
  private readonly claim: Claim;
  private readonly releaseLock: (taskDir: string) => void;

  constructor(tasksDir: string, runsDir: string, profile: unknown, options: ServiceOptions = {}) {
    this.tasksDir = tasksDir;
    this.runsDir = runsDir;
    this.profile = profile;
    this.port = options.port ?? null;
    this.claim = options.claim ?? occupancy.claim;
    this.releaseLock = options.release ?? occupancy.release;
    if (options.createTasksDir !== false) mkdirSync(this.tasksDir, { recursive: true });
  }

  scan(): void {
    for (const name of sortedEntries(this.tasksDir)) {
      const d = join(this.tasksDir, name);
      if (!isFile(join(d, DB_NAME))) continue;
      const db = library.openRo(d);
      let taskId: string | null = null;
      try {
        if (db !== null && library.isPreRevision(db)) {
          // 修订统一之前建的任务：本版本不支持，不接手（库表改动不做迁移）。
          if (!this.skipped.has(name)) {
            this.skipped.add(name);
            console.log(`跳过任务目录 ${name}：${library.OLD_FORMAT_TEXT}`);
          }
        } else if (db !== null) {
          const row = db.prepare("SELECT task_id FROM task LIMIT 1").get() as Row | undefined;
          taskId = row ? row.task_id : null;
        }
      } catch {
        taskId = null;
      } finally {
        db?.close();
      }
      if (taskId && !this.tasks.has(taskId)) {
        const taken = this.claim(d, this.port);
        if (taken !== null) {
          if (!this.occupied.has(taskId)) {
            console.log(`任务 ${taskId}（目录 ${name}）正被端口 ${pyStr(taken.port)} 的服务（主机 ${pyStr(taken.host)}，进程 ${pyStr(taken.pid)}）占用，本服务不接手它。`);
          }
          this.occupied.set(taskId, { lock: taken, dir: d });
          continue;
        }
        this.occupied.delete(taskId);
        this.tasks.set(taskId, new Task(taskId, d, this.runsDir));
      }
    }
  }

  task(taskId: string): Task {
    if (!this.tasks.has(taskId)) this.scan();
    const taken = this.occupied.get(taskId);
    if (taken) {
      const lock = taken.lock;
      throw new ApiError("task_occupied", occupancy.occupiedText(lock), { port: lock.port ?? null, pid: lock.pid ?? null, host: lock.host ?? null });
    }
    const task = this.tasks.get(taskId);
    if (!task) throw new ApiError("not_found", `没有任务 ${taskId}。`);
    return task;
  }

  close(): void {
    for (const t of this.tasks.values()) this.releaseLock(t.dir);
  }

  // ───────────── 任务与会话 ─────────────

  listTasks() {
    this.scan();
    const out: Record<string, unknown>[] = [];
    for (const t of this.tasks.values()) {
      const [, view] = library.taskSnapshot(t.dir);
      if (view === null) continue;
      const sessions = t.sessions.list();
      const actives = [...sessions.filter((s) => truthy(s.last_active_at)).map((s) => s.last_active_at), view.started_at].filter(truthy) as string[];
      if (!actives.length) throw new Error("max() arg is an empty sequence");
      const comp = view.completion;
      out.push({
        task_id: view.task_id, task_name: view.task_name, task_type: view.task_type, domain_tag: view.domain_tag, status: view.status,
        item_count: view.items.length,
        completion_met: comp ? comp.conditions.filter((c: any) => c.met).length : null,
        completion_total: comp ? comp.conditions.length : null,
        completion_unmet: comp ? comp.unmet_count : null,
        last_active_at: actives.reduce((a, b) => (library.byCodePoint(b, a) > 0 ? b : a)),
        session_count: sessions.length, supported: true,
      });
    }
    // 正被别的服务占用的任务：照样列出来，写明被哪个服务占用，打不开。
    for (const [taskId, info] of [...this.occupied].sort((a, b) => library.byCodePoint(a[0], b[0]))) {
      const lock = info.lock;
      let name: unknown = taskId;
      const db = library.openRo(info.dir);
      try {
        const got = db ? (db.prepare("SELECT task_name FROM task LIMIT 1").get() as Row | undefined) : undefined;
        name = got && truthy(got.task_name) ? got.task_name : taskId;
      } catch {
        // 读不出名字就用任务编号
      } finally {
        db?.close();
      }
      out.push({
        task_id: taskId, task_name: name, task_type: null, domain_tag: null, status: "占用中",
        item_count: null, completion_met: null, completion_total: null, completion_unmet: null,
        last_active_at: null, session_count: null, supported: false,
        occupied: { port: lock.port ?? null, pid: lock.pid ?? null, host: lock.host ?? null },
        note: occupancy.occupiedText(lock),
      });
    }
    // 修订统一之前建的任务：本版本打不开，照样列出来并标明不支持，免得用户以为任务丢了。
    for (const name of [...this.skipped].sort(library.byCodePoint)) {
      const folder = join(this.tasksDir, name);
      let modified: string | null = null;
      if (existsSync(folder)) modified = clock.fromEpochNs(statSync(folder, { bigint: true }).mtimeNs);
      out.push({
        task_id: name, task_name: name, task_type: null, domain_tag: null, status: "旧格式",
        item_count: null, completion_met: null, completion_total: null, completion_unmet: null,
        last_active_at: modified, session_count: null, supported: false, note: library.OLD_FORMAT_TEXT,
      });
    }
    return out;
  }

  create(body: Record<string, any>) {
    const taskType = or(body.task_type, DEFAULT_TYPE) as string;
    const available = availableTemplates();
    if (!available.includes(taskType)) {
      throw new ApiError("bad_request", `没有「${pyStr(taskType)}」这种任务类型。`, { available });
    }
    const name = String(or(body.task_name, "")).trim() || null;
    const tag = String(or(body.domain_tag, "")).trim() || null;
    const taskId = newTaskId();
    let result;
    try {
      result = createTaskDir(join(this.tasksDir, taskId), taskType, name, tag, taskId);
    } catch (error) {
      if (error instanceof CreateTaskError) throw new ApiError("rejected", "任务没有创建成功。", { reasons: [error.message] });
      throw error;
    }
    this.scan();
    return { ok: true, task_id: result.task_id };
  }

  taskPage(t: Task) {
    const [, view] = library.taskSnapshot(t.dir);
    if (view === null) throw new ApiError("no_task", "这个任务目录里没有任务记录。");
    return { ...view, materials: library.materials(t.dir, t.definition()), sessions: t.sessions.list() };
  }

  // ───────────── 修订日志 ─────────────

  /**
   * 修订日志：库里的每次修订，补上会话记录里的两样——执行者的修订属于哪次工作（按保存修订那次工具调用的调用编号在会话里找）
   * 与触发这次工作的那句话；用户直接操作的修订写操作名。只是把库与会话记录里已有的事实拼在一起，不做判断。
   */
  revisionLog(t: Task) {
    const rows = library.revisionLog(t.dir);
    if (rows === null) throw new ApiError("no_task", "这个任务目录里没有任务记录。");
    const definition = t.definition();
    const works = new Map<string, any>();      // 调用编号 → 所在的那次工作
    const spoken = new Map<string, any>();     // 用户的话的会话条目编号 → 那条对话记录
    const actions = new Map<string, any>();    // 操作编号 → 界面操作的记录
    const sessionIds = [...new Set(rows.map((r) => r.session_id).filter(truthy))].sort(library.byCodePoint);
    for (const sessionId of sessionIds) {
      let entries;
      try {
        entries = t.sessions.entries(sessionId);
      } catch {
        continue; // 会话记录读不出来：只是少了触发它的事，日志照给
      }
      const path = branch(entries);
      for (const work of worksFromEntries(path, definition, FALLBACK_TEXT, textOf)) {
        for (const callId of work.call_ids) works.set(callId, work);
      }
      for (const m of baseMessages(entries, sessionId)) {
        if (m.type === "user_message" && truthy(m.message_id)) spoken.set(m.message_id, m);
      }
      for (const e of path) {
        const details = or(e.details, {}) as Record<string, any>;
        if (e.type === "custom_message" && e.customType === USER_EDIT && truthy(details.op_id)) actions.set(details.op_id, details);
      }
    }
    const out = rows.map((r) => {
      const work = r.by === "executor" ? works.get(r.call_id) ?? null : null;
      const said = work ? spoken.get(work.user_message_id) ?? null : null;
      let trigger;
      if (r.by === "user") {
        const kind = (actions.get(r.call_id) ?? {}).kind ?? null;
        trigger = { kind: "user_action", action: kind, text: userActionText(kind, r) };
      } else if (said !== null) {
        trigger = { kind: or(said.origin, "typed"), text: or(said.text, ""), message_id: said.message_id };
      } else {
        trigger = { kind: "none", text: "" };
      }
      return {
        revision_no: r.revision_no, at: r.at, by: r.by, session_id: r.session_id,
        work_id: work ? work.work_id : null, op_id: r.by === "user" ? r.call_id : null,
        undo_of_revision: r.undo_of_revision, trigger, operations: r.operations, intent: r.intent ?? null,
      };
    });
    return { latest_revision: rows.length ? Math.max(...rows.map((r) => r.revision_no)) : 0, revisions: out };
  }

  // ───────────── 材料 ─────────────

  materialPath(t: Task, rel: string): string {
    const folder = or((t.definition() as Record<string, any>)["材料目录"], DEFAULT_MATERIALS_DIR) as string;
    const base = resolvePath(join(t.dir, folder));
    const target = resolvePath(resolve(t.dir, rel));
    if (!rel || !target.startsWith(base + sep)) throw new ApiError("bad_request", `路径 ${rel} 不在材料目录 ${folder} 里。`);
    return target;
  }

  upload(t: Task, filename: string, data: Buffer, session: string | null = null) {
    if (!filename || filename.includes("/") || filename.includes("\\") || filename === "." || filename === "..") {
      throw new ApiError("bad_request", "文件名里不能带路径分隔符。");
    }
    if (!UPLOAD_TYPES.some((ext) => filename.toLowerCase().endsWith(ext))) throw new ApiError("unsupported_type", "只接受 .md、.txt 与 .docx（Word）三种文件。");
    if (isProjection(filename)) throw new ApiError("bad_request", "以 .docx.txt 结尾的文件名留给由 Word 材料生成的文本用，请改个名字再上传。");
    const isDocx = filename.toLowerCase().endsWith(".docx");
    if (isDocx) {
      try {
        projectionText(data, filename);
      } catch (error) {
        if (error instanceof ProjectionError) throw new ApiError("unsupported_type", `${error.message}，请用 Word 另存为 .docx 后再上传。`);
        throw error;
      }
    }
    if (data.length > MAX_UPLOAD) throw new ApiError("too_large", "单个文件不能超过 5 MB。");
    const folderRel = or((t.definition() as Record<string, any>)["材料目录"], DEFAULT_MATERIALS_DIR) as string;
    const folder = join(t.dir, folderRel);
    mkdirSync(folder, { recursive: true });
    const dot = filename.lastIndexOf(".");
    const stem = dot >= 0 ? filename.slice(0, dot) : "";
    const ext = dot >= 0 ? filename.slice(dot + 1) : filename;
    let target = join(folder, filename);
    let n = 1;
    while (existsSync(target)) {
      n += 1;
      target = join(folder, `${stem}-${n}.${ext}`);
    }
    writeFileSync(target, data);
    const path = `${folderRel}${basename(target)}`;
    // Word 材料另生成一份文本投影，执行者读它，保存修订时核对摘录也对着它；它不单独算一份材料。
    if (isDocx) writeProjection(target, path);
    return { ok: true, path };
  }

  /** 材料原文：.docx 给投影（投影文件不在时现算），其余按 UTF-8 读（不合法的字节换成替换字符）。 */
  materialText(target: string, rel: string): string {
    if (target.toLowerCase().endsWith(".docx")) {
      const projection = projectionPath(target);
      return isFile(projection) ? readTextFile(projection) : projectionText(readFileSync(target), rel);
    }
    return readTextFileLenient(target);
  }
}

/** 用户直接操作产生的修订，写成「你……」一句操作名（修订日志卡片的副标题）。种类读不到时按修订里的操作写。 */
export function userActionText(kind: string | null, revision: Record<string, any>): string {
  const ops = revision.operations as Record<string, any>[];
  const ids = ops.map((op) => op.item_id).join("、");
  if (kind === "undo" || truthy(revision.undo_of_revision)) return `你撤销了修订 ${pyStr(revision.undo_of_revision)}`;
  if (kind === "delete_item" || (kind === null && ops.length && ops.every((op) => op.op === "delete"))) return `你删除了 ${ids}`;
  if (kind === "keep_pending") return `你把 ${ids} 标为先不管`;
  if (kind === "edit_fields" || (kind === null && ops.length && ops.every((op) => op.op === "update"))) {
    const fields = ops.flatMap((op) => op.fields_changed as string[]).map((f) => `「${f}」`).join("");
    return fields ? `你改了 ${ids} 的${fields}` : `你改了 ${ids}`;
  }
  return "你在界面上直接修改";
}

/**
 * 生成文档时把「用户的话」的出处「会话编号#消息编号」换成读者看得懂的说法：会话「名称」里用户的第 N 句话。
 * 按会话记录现算，每个会话只读一次；会话记录找不到或消息不在当前分支上时返回 null，由渲染写通用说法。
 */
export function wordsLocator(t: Task) {
  const cache = new Map<string, [unknown, Map<string, number>]>();
  return (locator: string): string | null => {
    const at = locator.indexOf("#");
    const sessionId = at >= 0 ? locator.slice(0, at) : locator;
    const messageId = at >= 0 ? locator.slice(at + 1) : "";
    if (!sessionId || !messageId) return null;
    if (!cache.has(sessionId)) {
      try {
        const msgs = baseMessages(t.sessions.entries(sessionId), sessionId);
        const names = new Map(t.sessions.list().map((row) => [row.session_id, row.name]));
        const users = msgs.filter((m) => m.type === "user_message").map((m) => m.message_id);
        cache.set(sessionId, [names.get(sessionId) ?? null, new Map(users.map((mid, n) => [mid, n + 1]))]);
      } catch {
        cache.set(sessionId, [null, new Map()]);
      }
    }
    const [name, order] = cache.get(sessionId)!;
    const n = order.get(messageId);
    if (n === undefined) return null;
    return truthy(name) ? `会话「${pyStr(name)}」里用户的第 ${n} 句话` : `对话里用户的第 ${n} 句话`;
  };
}
