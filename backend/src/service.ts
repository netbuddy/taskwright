/**
 * 任务服务：接手 --tasks 目录下的每个任务，拼出各读取接口的数据，建任务，收材料。它不写库（建任务经 agent 的 createTask 除外）。
 *
 * 接手任务时在任务目录里写一份占用标记（service.lock，见 occupancy.ts），退出时删掉；正被别的活着的服务占用的任务不接手：
 * 列表里写明被谁占用，打开它的请求一律以 task_occupied 拒绝。修订统一之前建的任务（旧格式）不接手，列表里标明不支持。
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, join, resolve, sep } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { DB_NAME } from "../../agent/src/lib/db.ts";
import { DEFAULT_MATERIALS_DIR, type ParsedDefinition, type Row, parseDefinition } from "../../agent/src/lib/task_read.ts";
import * as clock from "./clock.ts";
import { FALLBACK_TEXT, USER_EDIT, baseMessages, branch, messages as conversationMessages, page as conversationPage, textOf } from "./conversation.ts";
import { ApiError } from "./errors.ts";
import { readTextFile, readTextFileLenient } from "./files.ts";
import * as library from "./library.ts";
import * as occupancy from "./occupancy.ts";
import { ProjectionError, isReserved, projectionPath, projectionText, removeProjection, writeProjection } from "./projection.ts";
import { or, pyStr, truthy } from "./py.ts";
import { Executor } from "./executor.ts";
import { Hub } from "./hub.ts";
import { PI_SETTINGS_MODEL, type Profile, segmentParamsOf } from "./launch.ts";
import { worksFromEntries } from "./work_summary.ts";
import { CreateTaskError, DEFAULT_TYPE, availableTemplates, createTaskDir } from "./workspace.ts";
import { TASK_TYPES_DIR } from "./paths.ts";

export const MAX_UPLOAD = 5 * 1024 * 1024;

/** 上传的内容与本任务已有的某份材料完全相同时的那句话（错误码 duplicate_content）。 */
export const duplicateContentText = (name: string) => `这份文件与已有的材料《${name}》内容完全相同，没有重复保存。`;
/** 上传的文件名与本任务已有的某份材料相同、内容不同时的那句话（错误码 name_taken）。 */
export const nameTakenText = (name: string) => `这个任务里已经有一份叫《${name}》的材料，内容与这份不同。请给文件换一个名字再上传。`;

/**
 * 上传的文件名与已有材料的文件名算不算同名。现在按整理之后逐字相同判断（后端存文件时不改文件名，只拒绝带路径分隔符的名字）。
 * 大小写、全角半角、首尾空白、同一个字的不同编码算不算同名，定下之后只改这一个函数。不论怎样判断，写文件时都用排他创建，
 * 文件系统认为已经有这个文件（例如不区分大小写的文件系统上只差大小写）时同样按同名拒绝，不会覆盖已有的材料。
 */
export function sameMaterialName(uploaded: string, existing: string): boolean {
  return uploaded === existing;
}

const sha256 = (data: Buffer) => createHash("sha256").update(data).digest("hex");
/** 上传的文件超过上限时给用户看的那句话。服务信息接口把上限与这句话一起给前端，前端在发送之前就能拦下。 */
export const TOO_LARGE_TEXT = `单个文件不能超过 ${MAX_UPLOAD / 1024 / 1024} MB。`;
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
/** 一个任务目录连同它的事件分发与执行者看护。 */
export class Task {
  readonly taskId: string;
  readonly dir: string;
  readonly hub: Hub;
  readonly executor: Executor;

  constructor(taskId: string, dir: string, runsDir: string, profile: Profile) {
    this.taskId = taskId;
    this.dir = dir;
    this.hub = new Hub(dir, () => this.executor.running());
    this.executor = new Executor(taskId, dir, runsDir, profile, this.hub);
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
export type Claim = (taskDir: string, port: number | null, mode: string | null) => occupancy.Lock | null;

/** 运行形态：desktop 是单机桌面用（缺省只绑本机回环地址、有退出接口），server 是服务器用（缺省绑全部网卡、没有退出接口）。 */
export const MODES = ["desktop", "server"] as const;
export type Mode = (typeof MODES)[number];

export interface ServiceOptions {
  port?: number | null;
  mode?: Mode;
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
  readonly profile: Profile;
  /** 实际监听的端口：启动层在监听成功之后填上（命令行给的端口被占时会换到后面的端口）。 */
  port: number | null;
  readonly mode: Mode;
  /** 退出接口收到请求、回答发出之后调它：由启动层给，做与收到 SIGTERM 相同的收尾。 */
  exitHandler: (() => void) | null = null;
  readonly tasks = new Map<string, Task>();
  /** 正被别的服务占用、本服务没有接手的任务：任务编号 → {lock, dir}。 */
  readonly occupied = new Map<string, { lock: occupancy.Lock; dir: string }>();
  readonly skipped = new Set<string>();
  private readonly claim: Claim;
  private readonly releaseLock: (taskDir: string) => void;

  constructor(tasksDir: string, runsDir: string, profile: Profile, options: ServiceOptions = {}) {
    // 两个目录一律转成绝对路径（相对路径按进程的当前工作目录解析）。pi 的工作目录是任务目录，交给它的会话文件路径
    // 要是相对的，它会按任务目录去解析，找不到文件就悄悄新开一条会话；本服务内部从这里起只用绝对路径。
    this.tasksDir = resolve(tasksDir);
    this.runsDir = resolve(runsDir);
    // 桌面形态：模型可以由 pi 设置文件指定（见 launch.ts 的 PI_SETTINGS_MODEL）。标记只加在内存里的这份启动配置上。
    this.profile = options.mode === "desktop" ? { ...profile, [PI_SETTINGS_MODEL]: true } : profile;
    this.port = options.port ?? null;
    this.mode = options.mode ?? "server";
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
        const taken = this.claim(d, this.port, this.mode);
        if (taken !== null) {
          if (!this.occupied.has(taskId)) {
            // 标记里没写的项不写。
            const where = truthy(taken.port) ? `端口 ${pyStr(taken.port)} 的服务` : "另一个服务";
            const about = [truthy(taken.host) ? `主机 ${pyStr(taken.host)}` : "", truthy(taken.pid) ? `进程 ${pyStr(taken.pid)}` : ""].filter(Boolean);
            console.log(`任务 ${taskId}（目录 ${name}）正被${where}${about.length ? `（${about.join("，")}）` : ""}占用，本服务不接手它。`);
          }
          this.occupied.set(taskId, { lock: taken, dir: d });
          continue;
        }
        this.occupied.delete(taskId);
        this.tasks.set(taskId, new Task(taskId, d, this.runsDir, this.profile));
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

  /**
   * 收尾：先向各任务开着的事件流发 service_exiting（页面据此显示服务已退出、不再重连），再各任务停轮询、关 pi（「已退出」推到
   * 还开着的事件流上）、删占用标记；最后让各条事件流写完后正常结束。页内退出与各种退出信号都经这里，所以都会发这条通知。
   */
  async close(): Promise<void> {
    for (const t of this.tasks.values()) t.hub.emit("service_exiting", { mode: this.mode, at: clock.now() });
    for (const t of this.tasks.values()) {
      console.log(`任务 ${t.taskId} 的事件分发统计：${JSON.stringify(t.hub.stats)}`);
      t.hub.stopPolling();
      await t.executor.close();
      this.releaseLock(t.dir);
    }
    for (const t of this.tasks.values()) t.hub.close();
  }

  // ───────────── 任务与会话 ─────────────

  listTasks() {
    this.scan();
    const out: Record<string, unknown>[] = [];
    for (const t of this.tasks.values()) {
      const [, view] = library.taskSnapshot(t.dir);
      if (view === null) continue;
      const sessions = t.executor.listSessions();
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
    return { ...view, materials: library.materials(t.dir, t.definition()), sessions: t.executor.listSessions() };
  }

  /** 整份数据：带 session 时先打开那条会话（pi 不在就按需启动或续接），再读库与对话记录。 */
  async snapshot(t: Task, session: string | null) {
    if (session) {
      try {
        await t.executor.openSession(session);
      } catch (error) {
        // 没有接上这条会话：快照照常给（对话记录从会话文件读，条目从任务库读，都不依赖 pi），执行者状态里写明没有接上。
        if (!(error instanceof ApiError && error.code === "session_resume_failed")) throw error;
      }
    }
    const [seq, view] = library.taskSnapshot(t.dir);
    let info: Record<string, any> | null = null;
    let conv = null;
    let work = null;
    if (session) {
      info = t.executor.listSessions().find((s) => s.session_id === session) ?? null;
      work = t.executor.currentWork(session);
      let msgs = conversationMessages(await t.executor.entries(session), session, t.definition(), t.dir);
      // 正在进行的这次工作还没有结束：它的过程由 current_work 的步骤行显示，从会话文件算出的半截摘要不放进对话。
      if (work !== null) msgs = msgs.filter((m) => !(m.type === "work_summary" && m.work_id === work!.work_id));
      conv = conversationPage(msgs);
    }
    return {
      seq, generated_at: clock.now(), executor: t.executor.view(),
      session: info ? { session_id: info.session_id, name: info.name, started_at: info.started_at, last_active_at: info.last_active_at } : null,
      task: view, materials: library.materials(t.dir, t.definition()), conversation: conv, current_work: work,
    };
  }

  // ───────────── 修订日志 ─────────────

  /**
   * 修订日志：库里的每次修订，补上会话记录里的两样——执行者的修订属于哪次工作（按保存修订那次工具调用的调用编号在会话里找）
   * 与触发这次工作的那句话；用户直接操作的修订写操作名。只是把库与会话记录里已有的事实拼在一起，不做判断。
   */
  async revisionLog(t: Task) {
    const rows = library.revisionLog(t.dir);
    if (rows === null) throw new ApiError("no_task", "这个任务目录里没有任务记录。");
    const definition = t.definition();
    const works = new Map<string, any>();      // 调用编号 → 所在的那次工作
    const spoken = new Map<string, any>();     // 用户的话的会话条目编号 → 那条对话记录
    const actions = new Map<string, any>();    // 操作编号 → 界面操作的记录
    const sessionIds = [...new Set(rows.map((r) => r.session_id).filter(truthy))].sort(library.byCodePoint);
    const facts = library.callFacts(t.dir);
    for (const sessionId of sessionIds) {
      let entries;
      try {
        entries = await t.executor.entries(sessionId);
      } catch {
        continue; // 会话记录读不出来：只是少了触发它的事，日志照给
      }
      const path = branch(entries);
      for (const work of worksFromEntries(path, definition, FALLBACK_TEXT, textOf, facts)) {
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
    if (isReserved(filename)) throw new ApiError("bad_request", "以 .docx.md 或 .docx.txt 结尾的文件名留给由 Word 材料生成的投影用，请改个名字再上传。");
    const isDocx = filename.toLowerCase().endsWith(".docx");
    if (data.length > MAX_UPLOAD) throw new ApiError("too_large", TOO_LARGE_TEXT);
    const folderRel = or((t.definition() as Record<string, any>)["材料目录"], DEFAULT_MATERIALS_DIR) as string;
    const folder = join(t.dir, folderRel);
    mkdirSync(folder, { recursive: true });
    // 只与用户放进来的材料比（投影、分段清单这些派生文件不算，判断沿用材料清单的 derived_from）。先比内容，再比文件名：
    // 名字和内容都相同时报内容相同。摘要值（原始字节的 SHA-256）每次现算，不保存。
    // 从这里到写完文件都是同步的：同一个服务里两个上传请求不会在比较与写入之间交错；不同的服务不会同时接手一个任务（占用标记）。
    const own = library.materials(t.dir, t.definition()).filter((m) => m.derived_from === null);
    const digest = sha256(data);
    for (const m of own) {
      if (m.bytes !== data.length) continue; // 大小不同，内容必然不同，不必读
      let existing: Buffer;
      try {
        existing = readFileSync(join(t.dir, m.path));
      } catch {
        continue; // 刚被删掉的文件不算
      }
      if (sha256(existing) === digest) {
        throw new ApiError("duplicate_content", duplicateContentText(basename(m.path)), { path: m.path });
      }
    }
    const same = own.find((m) => sameMaterialName(filename, basename(m.path)));
    if (same) throw new ApiError("name_taken", nameTakenText(basename(same.path)), { path: same.path });
    const target = join(folder, filename);
    try {
      // 排他创建：文件已经存在（文件系统认为同名）就不写，按同名拒绝，不覆盖。
      writeFileSync(target, data, { flag: "wx" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      throw new ApiError("name_taken", nameTakenText(filename), { path: `${folderRel}${filename}` });
    }
    const path = `${folderRel}${basename(target)}`;
    if (isDocx) {
      // Word 材料另生成一份 Markdown 投影（图片抽到旁边的目录），执行者读它，保存修订时核对摘录也对着它；
      // 它不单独发 material_added。生成不了（不是合法的 .docx）时连同这份文件一起删掉。
      try {
        writeProjection(target, path, segmentParamsOf(this.profile));
      } catch (error) {
        if (!(error instanceof ProjectionError)) throw error;
        try {
          unlinkSync(target);
        } catch {
          // 已经不在了
        }
        removeProjection(target);
        throw new ApiError("unsupported_type", `${error.message}，请用 Word 另存为 .docx 后再上传。`);
      }
    }
    // 材料清单只在整份数据里读一次；上传之后推一条过程类事件，工作视图与任务页据此更新清单。
    // 材料属于任务，session_id 只说明是从哪条会话上传的（可空），订阅了别的会话的页面也收得到。
    const st = statSync(target, { bigint: true });
    t.hub.emit("material_added", { session_id: session, at: clock.now(), path, bytes: Number(st.size), modified_at: clock.fromEpochNs(st.mtimeNs) });
    return { ok: true, path };
  }

  /** 材料原文：.docx 给投影（先找 .md 再找旧的 .txt；都不在时现算一份，不写文件），其余按 UTF-8 读（不合法的字节换成替换字符）。 */
  materialText(target: string, rel: string): string {
    if (target.toLowerCase().endsWith(".docx")) {
      const projection = projectionPath(target);
      try {
        return isFile(projection) ? readTextFile(projection) : projectionText(target, rel);
      } catch (error) {
        if (error instanceof ProjectionError || error instanceof TypeError) throw new ApiError("unsupported_type", `${(error as Error).message}。`);
        throw error;
      }
    }
    return readTextFileLenient(target);
  }
}

/** 用户直接操作产生的修订，写成「你……」一句操作名（修订日志卡片的副标题）。种类读不到时按修订里的操作写。 */
export function userActionText(kind: string | null, revision: Record<string, any>): string {
  const ops = revision.operations as Record<string, any>[];
  const ids = ops.map((op) => op.item_id).join("、");
  if (kind === "undo" || truthy(revision.undo_of_revision)) {
    // 撤销总会记下被撤销的修订号；库数据异常、缺这一项时不写空值。
    return truthy(revision.undo_of_revision) ? `你撤销了修订 ${pyStr(revision.undo_of_revision)}` : "你撤销了一次修订";
  }
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
 * 先把文档可能用到的会话记录读好（pi 在跑且接着那条会话时经 RPC 读，否则读会话文件），渲染时同步查；
 * 会话记录找不到或消息不在当前分支上时返回 null，由渲染写通用说法。
 */
export async function wordsLocator(t: Task, lib: library.Library | null = null) {
  const cache = new Map<string, [unknown, Map<string, number>]>();
  const wanted = new Set<string>();
  for (const rows of (lib?.data.sources ?? new Map()).values()) {
    for (const one of rows) {
      if (one["种类"] !== "用户的话" || typeof one["出处"] !== "string") continue;
      const at = one["出处"].indexOf("#");
      if (at > 0) wanted.add(one["出处"].slice(0, at));
    }
  }
  for (const sessionId of wanted) {
    try {
      const msgs = baseMessages(await t.executor.entries(sessionId), sessionId);
      const names = new Map(t.executor.listSessions().map((row) => [row.session_id, row.name]));
      const users = msgs.filter((m) => m.type === "user_message").map((m) => m.message_id);
      cache.set(sessionId, [names.get(sessionId) ?? null, new Map(users.map((mid, n) => [mid, n + 1]))]);
    } catch {
      cache.set(sessionId, [null, new Map()]); // 会话记录读不出来：不影响生成文档，只是出处写通用说法
    }
  }
  return (locator: string): string | null => {
    const at = locator.indexOf("#");
    const sessionId = at >= 0 ? locator.slice(0, at) : locator;
    const messageId = at >= 0 ? locator.slice(at + 1) : "";
    if (!sessionId || !messageId || !cache.has(sessionId)) return null;
    const [name, order] = cache.get(sessionId)!;
    const n = order.get(messageId);
    if (n === undefined) return null;
    return truthy(name) ? `会话「${pyStr(name)}」里用户的第 ${n} 句话` : `对话里用户的第 ${n} 句话`;
  };
}
