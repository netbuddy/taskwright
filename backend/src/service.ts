/**
 * 任务服务：接手 --tasks 目录下的每个任务，拼出各读取接口的数据，建任务，收材料。它不写库（建任务经 agent 的 createTask 除外）。
 *
 * 接手任务时在任务目录里写一份占用标记（service.lock，见 occupancy.ts），退出时删掉；正被别的活着的服务占用的任务不接手：
 * 列表里写明被谁占用，打开它的请求一律以 task_occupied 拒绝。数据格式早于本程序能升级的最早格式的任务（旧格式）不接手，列表里标明不支持。
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, rmdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { DB_NAME } from "../../agent/src/lib/db.ts";
import { MIN_TASK_DB_VERSION, TASK_DB_VERSION, newerDataText, olderDataText, taskWrittenBy } from "../../agent/src/lib/schema.ts";
import { MEDIA_SUFFIX } from "../../agent/src/lib/docx_markdown.ts";
import { DEFAULT_MATERIAL_ROLE, type MaterialRole, insertMaterial, materialSlot, retireMaterial } from "../../agent/src/lib/material_db.ts";
import { DEFAULT_MATERIALS_DIR, type ParsedDefinition, type Row, parseDefinition } from "../../agent/src/lib/task_read.ts";
import * as clock from "./clock.ts";
import { FALLBACK_TEXT, USER_EDIT, baseMessages, branch, messages as conversationMessages, page as conversationPage, textOf } from "./conversation.ts";
import { ApiError } from "./errors.ts";
import { readTextFile, readTextFileLenient } from "./files.ts";
import * as library from "./library.ts";
import { workItemView } from "./task_status.ts";
import * as occupancy from "./occupancy.ts";
import { PDF_NO_TEXT, PdfUploadError, runPdfProjection } from "./pdf_upload.ts";
import { PDF_PROJECTION_SUFFIX, removePdfProjection } from "./pdf_projection.ts";
import { PDF_DERIVED_SUFFIXES, ProjectionError, isReserved, pdfFacts, projectionPath, projectionText, removeProjection, reservedNameText, writeProjection } from "./projection.ts";
import { or, pyStr, truthy } from "./py.ts";
import { Executor } from "./executor.ts";
import { Hub } from "./hub.ts";
import { DEBUG_MODE, PI_SETTINGS_MODEL, type Profile, pdfLimitsOf, segmentParamsOf } from "./launch.ts";
import { worksFromEntries } from "./work_summary.ts";
import { CreateTaskError, DEFAULT_TYPE, availableTemplates, createTaskDir } from "./workspace.ts";
import { listTaskTypes, recordSeedRevisions, revisionNumbers, seedTaskTypes, taskTypesRoot, typeInfo } from "./task_types.ts";
import { TASK_TYPES_DIR, appVersion } from "./paths.ts";
import { readTaskJson, writeTaskJson } from "./task_json.ts";
import type { PendingUpgrade } from "./data_upgrade.ts";
import type { ServiceDb } from "./service_db.ts";
import { KnowledgeStore, SELECTION_FILE, initialSelection, selectedLibraries, writeSelection } from "./knowledge.ts";
import { KnowledgeEmbedder } from "./knowledge_embedder.ts";
import { MB, readUploadLimits } from "./product_settings.ts";
import { searchKnowledge, searchRequest } from "./knowledge_search.ts";

/** 任务材料单个文件的上限（字节）：按设置文件现读，设置页可改（product_settings.ts 的 readUploadLimits）。 */
export const maxUpload = (): number => readUploadLimits().material_mb * MB;

/** 上传的内容与本任务已有的某份材料完全相同时的那句话（错误码 duplicate_content）。 */
export const duplicateContentText = (name: string) => `这份文件与已有的材料《${name}》内容完全相同，没有重复保存。`;
/** 上传的文件名与本任务已有的某份材料相同、内容不同时的那句话（错误码 name_taken）。 */
export const nameTakenText = (name: string) => `这个任务里已经有一份叫《${name}》的材料，内容与这份不同。请给文件换一个名字再上传。`;

/**
 * 上传的文件名与已有材料的文件名算不算同名：两边都去掉首尾空白、统一成 Unicode 规范化的 NFC 形式（macOS 会把带声调的字母
 * 拆成两个码位）、再折叠大小写之后逐字比较。所以只差大小写、只差编码方式、只差首尾空白都算同名；只差全角半角（例如全角括号与
 * 半角括号）不算同名。这条规则只用于判断是否同名，保存时的文件名不变。不论怎样判断，写文件时都用排他创建，文件系统认为已经有
 * 这个文件时同样按同名拒绝，不会覆盖已有的材料。
 */
export function sameMaterialName(uploaded: string, existing: string): boolean {
  return nameKey(uploaded) === nameKey(existing);
}

/**
 * 比较文件名用的形式。大小写折叠用 toUpperCase 再 toLowerCase：两者按 Unicode 的缺省大小写映射，与区域设置无关（不像
 * toLocaleLowerCase 在土耳其语等区域设置下结果不同）；先转大写再转小写，希腊字母词尾的 ς 与 σ、德文的 ß 与 SS 也能对上。
 * 大小写映射可能产生未组合的形式，所以折叠之后再做一次 NFC。全角字母折叠后仍是全角，不会与半角混同。
 */
function nameKey(name: string): string {
  return name.trim().normalize("NFC").toUpperCase().toLowerCase().normalize("NFC");
}

const sha256 = (data: Buffer) => createHash("sha256").update(data).digest("hex");
/** 上传的文件超过上限时给用户看的那句话。服务信息接口把上限与这句话一起给前端，前端在发送之前就能拦下。 */
export const tooLargeText = (): string => `单个文件不能超过 ${readUploadLimits().material_mb} MB。`;
/** 删除一份已经进入对话的材料时的拒绝说明。 */
export const ENTERED_CONVERSATION_TEXT = "这份材料已经进入了对话，不能删除。";
/** 替换一份已经进入对话的材料时的拒绝说明。 */
export const ENTERED_CONVERSATION_REPLACE_TEXT = "这份材料已经进入了对话，不能替换；请上传一份新材料，并告诉助手以新的为准。";
/** 替换时新文件与被替换的那份内容完全相同时的那句话（错误码 duplicate_content）。 */
export const SAME_AS_REPLACED_TEXT = "新文件与这份材料内容完全相同，没有替换。";
/** 替换材料时暂放旧文件的目录（在任务目录下，与材料目录在同一个盘上；新文件存好了就删掉，没存成就把旧文件移回去）。 */
export const REPLACING_DIR = ".replacing";
export const UPLOAD_TYPES = [".md", ".txt", ".docx", ".pdf"];
/** 上传 PDF 时放它与派生文件的临时目录（在任务目录下，与材料目录在同一个盘上，生成好了才移进材料目录）。 */
export const UPLOADING_DIR = ".uploading";
/**
 * 上传的这份文件是来替换一份材料的（replaceMaterial 给）：path 是被换掉的那份的路径；takeAway 把它连同由它生成的文件移出材料目录，
 * 返回一个把它们原样移回去的函数。takeAway 由上传在新文件已经可以存的那一刻调（PDF 是解析好之后），调它与存新文件之间没有等待。
 */
export interface Replacing { path: string; takeAway: () => () => void }

/** 扩展名给人看的叫法：表里有的写叫法，没有的直接写扩展名本身。前端不另存一份，叫法经服务信息的 upload.types_text 给出。 */
const UPLOAD_TYPE_NAMES: Record<string, string> = { ".docx": "Word 的 .docx", ".pdf": "PDF" };

/** 允许上传的类型写成给人看的一串，例如「.md、.txt、Word 的 .docx 与 PDF」：多项之间用「、」，最后一项前用「与」。由 UPLOAD_TYPES 拼出。 */
export function uploadTypesText(): string {
  const names = UPLOAD_TYPES.map((ext) => UPLOAD_TYPE_NAMES[ext] ?? ext);
  return names.length === 1 ? names[0] : `${names.slice(0, -1).join("、")} 与 ${names[names.length - 1]}`;
}

/** 上传的文件类型不在 UPLOAD_TYPES 里时给用户看的那句话，例如「只接受 .md、.txt、Word 的 .docx 与 PDF 文件。」。服务信息把它给前端，前端在发送之前就能拦下。 */
export function unsupportedTypeText(): string {
  return `只接受 ${uploadTypesText()} 文件。`;
}

/**
 * 任务类型：root 下的每个目录（缺省是产品自带的 task-types/；任务服务列的是用户数据目录下的那一份，见 Service.taskTypes），
 * 显示名取它的任务定义里的「任务名」；没有新格式任务定义的模板不列。
 */
export function taskTypes(root: string = TASK_TYPES_DIR) {
  return listTaskTypes(root);
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

  constructor(taskId: string, dir: string, runsDir: string, profile: Profile, knowledgeRoot: string | null = null) {
    this.taskId = taskId;
    this.dir = dir;
    this.hub = new Hub(dir, () => this.executor.running());
    this.executor = new Executor(taskId, dir, runsDir, profile, this.hub, knowledgeRoot);
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
  /** 知识库根目录；不给时这个服务没有知识库（服务信息里 capabilities.knowledge 为假，知识库的接口一律 not_found）。 */
  knowledgeDir?: string | null;
  /** 已经打开的服务级库（service_db.ts）；不给时这个服务没有任务登记表（直接建服务对象的测试）。服务收尾时关掉它。 */
  registry?: ServiceDb | null;
  /** 数据目录（服务级库、日志与各种报告所在的目录）；不给时取任务根目录的上一级。 */
  dataDir?: string | null;
  /**
   * 调试模式（命令行的 --debug），缺省关，不写进任何设置文件。开着时：服务信息里 debug 为真；起助手的程序时多给一个环境变量，
   * 助手一侧的扩展见到它才读「提示词目录」、才把整份系统提示报回来（launch.ts 的 DEBUG_MODE）；调试用的几个接口才可用。
   */
  debug?: boolean;
}

/**
 * 这种任务类型的说明现在是第几版（任务定义里的「版本」）；定义读不出来或者没有写版本时是 null。root 缺省是产品自带的 task-types/；
 * 任务服务看的是用户数据目录下的那一份。
 */
export function taskTypeVersion(taskType: string, root: string = TASK_TYPES_DIR): number | null {
  return typeInfo(root, taskType)?.version ?? null;
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
  /** 数据目录：数据包导入的报告写在它的 logs/ 下，导出时从它读任务登记。 */
  readonly dataDir: string;
  /** 建任务时从这里复制任务类型：数据目录下的 task-types/（见 task_types.ts）。 */
  readonly typesRoot: string;
  readonly profile: Profile;
  /** 实际监听的端口：启动层在监听成功之后填上（命令行给的端口被占时会换到后面的端口）。 */
  port: number | null;
  readonly mode: Mode;
  /** 调试模式开没开（见 ServiceOptions.debug）。 */
  readonly debug: boolean;
  /** 退出接口收到请求、回答发出之后调它：由启动层给，做与收到 SIGTERM 相同的收尾。 */
  exitHandler: (() => void) | null = null;
  readonly tasks = new Map<string, Task>();
  /** 正被别的服务占用、本服务没有接手的任务：任务编号 → {lock, dir}。 */
  readonly occupied = new Map<string, { lock: occupancy.Lock; dir: string }>();
  /**
   * 数据格式与这个程序对不上、所以没有接手的任务，按目录名记：上一版建的、数据还没有升级（「需要升级」），升级过但没有做成
   * （「需要处理」），或者是更新的版本写的（「需要更新的程序」）。列表里照样列出并写明原因，打不开。每次扫描重算。
   */
  readonly unavailable = new Map<string, { status: string; note: string }>();
  /** 知识库；启动时没给根目录就是 null。 */
  readonly knowledge: KnowledgeStore | null;
  registry: ServiceDb | null;
  /**
   * 启动时发现要先做数据升级（桌面形态）时在这里：升级做完之前这个服务不扫描、不接手任何任务，别的接口也不给用。
   * 没有要升级的，或者不是经 startService 起的，是 null。
   */
  upgrade: PendingUpgrade | null = null;
  /** 知识库文档的后台换算；没有知识库时是 null。 */
  readonly embedder: KnowledgeEmbedder | null;
  private readonly claim: Claim;
  private readonly releaseLock: (taskDir: string) => void;

  constructor(tasksDir: string, runsDir: string, profile: Profile, options: ServiceOptions = {}) {
    // 两个目录一律转成绝对路径（相对路径按进程的当前工作目录解析）。pi 的工作目录是任务目录，交给它的会话文件路径
    // 要是相对的，它会按任务目录去解析，找不到文件就悄悄新开一条会话；本服务内部从这里起只用绝对路径。
    this.tasksDir = resolve(tasksDir);
    this.runsDir = resolve(runsDir);
    this.dataDir = options.dataDir ? resolve(options.dataDir) : dirname(this.tasksDir);
    // 桌面形态：模型可以由 pi 的设置文件指定（见 launch.ts 的 PI_SETTINGS_MODEL）。标记只加在内存里的这份启动配置上。
    this.debug = options.debug === true;
    // 两个运行时标记都不用加时，就用传进来的那一份启动配置本身，不复制。
    const marks = { ...(options.mode === "desktop" ? { [PI_SETTINGS_MODEL]: true } : {}), ...(this.debug ? { [DEBUG_MODE]: true } : {}) };
    this.profile = Object.keys(marks).length > 0 ? { ...profile, ...marks } : profile;
    this.port = options.port ?? null;
    this.mode = options.mode ?? "server";
    this.claim = options.claim ?? occupancy.claim;
    this.releaseLock = options.release ?? occupancy.release;
    this.registry = options.registry ?? null;
    if (options.createTasksDir !== false) mkdirSync(this.tasksDir, { recursive: true });
    // 任务类型落在数据目录下的 task-types/：第一次启动（或者产品带来了新的任务类型）时从产品自带的那一份播种，已有的不动（见 task_types.ts）。
    this.typesRoot = taskTypesRoot(this.dataDir);
    if (options.createTasksDir !== false) seedTaskTypes(this.dataDir, appVersion());
    if (this.registry && options.createTasksDir !== false) recordSeedRevisions(this.dataDir, this.registry);
    // 知识库根目录同样转成绝对路径；第一次启动、还没有知识库的清单时建出通用知识库。
    this.knowledge = options.knowledgeDir ? new KnowledgeStore(resolve(options.knowledgeDir)) : null;
    if (this.knowledge && options.createTasksDir !== false) this.knowledge.ensure();
    // 读模型配置用的环境与模型配置的接口相同（http.ts 的 modelContext）；Word 文档的分段参数与上传时用的相同。
    this.embedder = this.knowledge
      ? new KnowledgeEmbedder(this.knowledge, () => ({ env: process.env, profile: this.profile }), () => segmentParamsOf(this.profile))
      : null;
  }

  /** 数据格式与这个程序对不上的任务：为什么不接手（状态与给用户看的一句话）；对得上时是 null。 */
  private formatProblem(name: string, dir: string): { status: string; note: string } | null {
    const version = library.taskDbVersion(dir);
    if (version === null || version === TASK_DB_VERSION) return null;
    if (version > TASK_DB_VERSION) return { status: "需要更新的程序", note: newerDataText(taskWrittenBy(dir)) };
    // 格式早于本程序能升级的最早格式：列出来，打不开，也不去升级。
    if (version < MIN_TASK_DB_VERSION) return { status: "旧格式", note: olderDataText(version) };
    const failed = this.registry?.taskByDir(name) ?? null;
    if (failed?.upgrade_error) return { status: "需要处理", note: `这个任务的数据升级没有做成：${failed.upgrade_error}` };
    const how = this.mode === "desktop" ? "重新启动程序后升级。" : "请停下服务后运行 taskwright data upgrade。";
    return { status: "需要升级", note: `这个任务是上一版建的，数据还没有升级。${how}` };
  }

  /** 把一个接手了的任务记进登记表（没有服务级库时不记）。名字与建立时刻取自任务库，任务类型取任务定义文件的名字。 */
  private register(name: string, row: Row): void {
    if (!this.registry) return;
    const definition = typeof row.definition_path === "string" ? basename(row.definition_path).replace(/\.json$/i, "") : null;
    this.registry.putTask({
      task_id: row.task_id, name: truthy(row.task_name) ? row.task_name : null, owner: readTaskJson(join(this.tasksDir, name))?.owner ?? "local",
      status: null, task_type: definition || null, created_at: row.started_at ?? null, dir: name,
    });
  }

  /** 数据包的导出与导入要的几个位置（data_pack.ts 的 PackLocations）。 */
  packLocations(): { dataDir: string; tasksDir: string; runsDir: string; knowledgeDir: string | null } {
    return { dataDir: this.dataDir, tasksDir: this.tasksDir, runsDir: this.runsDir, knowledgeDir: this.knowledge?.root ?? null };
  }

  /** 数据升级做完之后把打开着的服务级库接上（升级之前没有打开它）。 */
  attachRegistry(registry: ServiceDb): void {
    this.registry = registry;
    // 播种时还没有服务级库的（数据要先升级），任务类型的修订 1 只存了目录：这时补记它的经过。
    recordSeedRevisions(this.dataDir, registry);
  }

  scan(): void {
    // 数据升级做完之前不碰任何任务。
    if (this.upgrade?.blocking) return;
    this.unavailable.clear();
    for (const name of sortedEntries(this.tasksDir)) {
      const d = join(this.tasksDir, name);
      if (!isFile(join(d, DB_NAME))) continue;
      const db = library.openRo(d);
      let taskId: string | null = null;
      let row: Row | undefined;
      try {
        if (db !== null) {
          row = db.prepare("SELECT task_id, task_name, definition_path, started_at FROM task LIMIT 1").get() as Row | undefined;
          taskId = row ? row.task_id : null;
        }
      } catch {
        taskId = null;
      } finally {
        db?.close();
      }
      // 数据格式对不上的不接手（已经接手的任务是对得上的，不再看）。
      if (taskId && !this.tasks.has(taskId)) {
        const problem = this.formatProblem(name, d);
        if (problem) {
          this.unavailable.set(name, problem);
          continue;
        }
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
        this.tasks.set(taskId, new Task(taskId, d, this.runsDir, this.profile, this.knowledge?.root ?? null));
        this.register(name, row!);
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
    if (!task) {
      const problem = this.unavailable.get(taskId);
      if (problem) throw new ApiError("task_unavailable", problem.note, { status: problem.status });
      throw new ApiError("not_found", `没有任务 ${taskId}。`);
    }
    return task;
  }

  /**
   * 收尾：先向各任务开着的事件流发 service_exiting（页面据此显示服务已退出、不再重连），再各任务停轮询、关 pi（「已退出」推到
   * 还开着的事件流上）、删占用标记；最后让各条事件流写完后正常结束。页内退出与各种退出信号都经这里，所以都会发这条通知。
   */
  async close(): Promise<void> {
    // 知识库文档的后台换算先停：手上的请求放下，正在算的那一份作废（下次启动时它是「未换算」）。
    await this.embedder?.close();
    for (const t of this.tasks.values()) t.hub.emit("service_exiting", { mode: this.mode, at: clock.now() });
    for (const t of this.tasks.values()) {
      console.log(`任务 ${t.taskId} 的事件分发统计：${JSON.stringify(t.hub.stats)}`);
      t.hub.stopPolling();
      await t.executor.close();
      this.releaseLock(t.dir);
    }
    for (const t of this.tasks.values()) t.hub.close();
    this.registry?.close();
  }

  // ───────────── 任务与会话 ─────────────

  listTasks() {
    this.scan();
    const out: Record<string, unknown>[] = [];
    for (const t of this.tasks.values()) {
      const [, view] = library.taskSnapshot(t.dir);
      if (view === null) continue;
      const sessions = t.executor.listSessions();
      // 最近活动：会话里最近一条消息、最近一次启动或结束工作项、建任务，取最晚的那个时刻。
      const actives = [...sessions.filter((s) => truthy(s.last_active_at)).map((s) => s.last_active_at), library.latestWorkItemAt(t.dir), view.started_at]
        .filter(truthy) as string[];
      if (!actives.length) throw new Error("max() arg is an empty sequence");
      const comp = view.completion;
      const versions = library.versionRows(t.dir);
      const latest = versions.at(-1) ?? null;
      // 进展：流程工作项在第几站（一个任务至多一个）、工作项个数、未了结的阻断下游的问题有几条（写条目那一段的灯列出的条目）。
      const defs = library.taskDefinitions(t.dir);
      const items = library.workItemRows(t.dir).map((row) => workItemView(row, null, defs));
      const flowItem = items.find((one) => one.kind === "flow") ?? null;
      const blocking = (view.stage?.lamps?.writing ?? []).find((one: { key: string }) => one.key === "no_blocking_questions");
      out.push({
        task_id: view.task_id, task_name: view.task_name, task_type: view.task_type, domain_tag: view.domain_tag, unavailable: null,
        item_count: view.items.length,
        completion_met: comp ? comp.conditions.filter((c: any) => c.met).length : null,
        completion_total: comp ? comp.conditions.length : null,
        completion_unmet: comp ? comp.unmet_count : null,
        flow: flowItem && flowItem.node ? { name: flowItem.name, node: flowItem.node, node_name: flowItem.activity_name, ordinal: flowItem.ordinal } : null,
        work_item_count: items.length,
        blocking_count: blocking && blocking.ok === false ? blocking.items.length : 0,
        version_count: versions.length,
        latest_published_at: latest ? clock.fromLocalText(latest.published_at) : null,
        last_active_at: actives.reduce((a, b) => (Date.parse(b) > Date.parse(a) ? b : a)),
        session_count: sessions.length, supported: true,
      });
    }
    // 打得开的任务按最近活动排，最近的在前；打不开的几种排在后面。
    out.sort((a, b) => Date.parse(String(b.last_active_at)) - Date.parse(String(a.last_active_at)));
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
        task_id: taskId, task_name: name, task_type: null, domain_tag: null, unavailable: "占用中",
        item_count: null, completion_met: null, completion_total: null, completion_unmet: null, flow: null, work_item_count: null, blocking_count: null,
        version_count: null, latest_published_at: null,
        last_active_at: null, session_count: null, supported: false,
        occupied: { port: lock.port ?? null, pid: lock.pid ?? null, host: lock.host ?? null },
        note: occupancy.occupiedText(lock),
      });
    }
    // 数据格式与这个程序对不上的任务（需要升级、需要处理、需要更新的程序）：照样列出来，写明原因，打不开。
    for (const [name, problem] of [...this.unavailable].sort((a, b) => library.byCodePoint(a[0], b[0]))) {
      const folder = join(this.tasksDir, name);
      let title: unknown = name;
      const db = library.openRo(folder);
      try {
        const got = db ? (db.prepare("SELECT task_name FROM task LIMIT 1").get() as Row | undefined) : undefined;
        title = got && truthy(got.task_name) ? got.task_name : name;
      } catch {
        // 读不出名字就用目录名
      } finally {
        db?.close();
      }
      out.push({
        task_id: name, task_name: title, task_type: null, domain_tag: null, unavailable: problem.status,
        item_count: null, completion_met: null, completion_total: null, completion_unmet: null, flow: null, work_item_count: null, blocking_count: null,
        version_count: null, latest_published_at: null,
        last_active_at: existsSync(folder) ? clock.fromEpochNs(statSync(folder, { bigint: true }).mtimeNs) : null,
        session_count: null, supported: false, note: problem.note,
      });
    }
    return out;
  }

  /**
   * 删除一个任务：真删除，不设回收站（任务目录自包含，导出的数据包就是备份）。助手正在工作（有没有做完的运行）时拒绝，请用户先停止助手。
   * 否则停掉这个任务的事件轮询、关掉它的助手、关掉开着的事件流、删占用标记，再删任务目录与它的会话归档目录（runs 下以任务编号命名的目录），
   * 从服务里与登记表里去掉；最后在服务日志里记一行：时刻、任务编号、任务名、请求来自哪里（client）。任务库里不留记录（库已经删了）。
   * 不要求先导出。
   */
  async deleteTask(t: Task, client: string) {
    if (t.executor.state === "working") {
      throw new ApiError("session_busy", "助手正在工作，请先停止助手，再删除这个任务。", { active_session: t.executor.activeSession, reason: "working" });
    }
    const row = t.row();
    const name = row && truthy(row.task_name) ? String(row.task_name) : String(t.definition()["任务名"] ?? t.taskId);
    t.hub.stopPolling();
    await t.executor.close();
    t.hub.close();
    this.releaseLock(t.dir);
    rmSync(t.dir, { recursive: true, force: true });
    rmSync(join(this.runsDir, t.taskId), { recursive: true, force: true });
    this.tasks.delete(t.taskId);
    this.registry?.removeTask(t.taskId);
    console.log(`删除任务：时刻 ${clock.now()}，任务 ${t.taskId}「${name}」，来自 ${client}。`);
    return { ok: true, task_id: t.taskId };
  }

  create(body: Record<string, any>) {
    const taskType = or(body.task_type, DEFAULT_TYPE) as string;
    // 用户目录里还没有的（例如只读地建了服务对象之后）先播种。
    if (seedTaskTypes(this.dataDir, appVersion()).length && this.registry) recordSeedRevisions(this.dataDir, this.registry);
    const available = availableTemplates(this.typesRoot);
    if (!available.includes(taskType)) {
      throw new ApiError("bad_request", `没有「${pyStr(taskType)}」这种任务类型。`, { available });
    }
    const name = String(or(body.task_name, "")).trim() || null;
    const tag = String(or(body.domain_tag, "")).trim() || null;
    const taskId = newTaskId();
    let result;
    try {
      result = createTaskDir(join(this.tasksDir, taskId), taskType, name, tag, taskId, null, this.typesRoot);
    } catch (error) {
      if (error instanceof CreateTaskError) throw new ApiError("rejected", "任务没有创建成功。", { reasons: [error.message] });
      throw error;
    }
    // 新任务只选用通用知识库。
    writeFileSync(join(result.任务目录, SELECTION_FILE), JSON.stringify(initialSelection(), null, 2) + "\n", "utf-8");
    // 记下这个任务是哪个产品版本建的、任务类型说明是第几版（见 task_json.ts）。登记表在下面的扫描接手它时写。
    writeTaskJson(result.任务目录, {
      created_by_version: appVersion(), task_type: taskType, task_type_version: taskTypeVersion(taskType, this.typesRoot),
      task_type_revision: revisionNumbers(this.dataDir, taskType).at(-1) ?? null, owner: "local",
      created_at: clock.now(), upgraded_by_version: null, upgraded_at: null,
    });
    this.scan();
    return { ok: true, task_id: result.task_id };
  }

  taskPage(t: Task) {
    const [, view] = library.taskSnapshot(t.dir);
    if (view === null) throw new ApiError("no_task", "这个任务目录里没有任务记录。");
    const sessions = this.sessionRows(t);
    // deletable：现在调删除接口会不会被这份材料本身的情况挡住（派生文件、已经进入对话）；助手正在工作是一时的，不算在内。
    const lastActivity = t.executor.sessions.lastActivityMs(false);
    const materials = library.materials(t.dir, t.definition()).map((m) => ({
      ...m, deletable: m.derived_from === null && !this.enteredConversation(join(t.dir, m.path), lastActivity),
    }));
    // 任务类型说明的版本：这个任务建的时候复制进来的是第几版（task.json 记着），用户目录里的这种任务类型现在是第几版。
    // 说明不随升级更新，页面在两个数不同时写一句。上一版建的任务没有记，copied 是 null。
    const meta = readTaskJson(t.dir);
    const taskTypeVersions = { copied: meta?.task_type_version ?? null, current: meta?.task_type ? taskTypeVersion(meta.task_type, this.typesRoot) : null };
    return { ...view, materials, sessions, knowledge_libraries: selectedLibraries(t.dir), task_type_versions: taskTypeVersions };
  }

  /**
   * 会话清单，每条另带 revision_count（这条会话产生了几次修订：修订表按会话编号计数，没有时为 0）与 work_item
   * （这条会话属于的工作项：记录号、种类、名字、现在做的那项活动；自由讨论的会话、归档的会话为 null）。
   * 归档的会话（它们的工作项被删除了）缺省不列；withArchived 为真时也列，每条另带 archived（是不是归档的）、archived_at（归档的时刻）
   * 与 archived_record_id（它曾属于的那个已经删除的工作项的记录号），没有归档的这两项为 null。
   */
  sessionRows(t: Task, withArchived = false) {
    const counts = library.revisionCountsBySession(t.dir);
    const items = library.workItemRows(t.dir);
    const archived = library.archivedSessionInfo(t.dir);
    return t.executor.listSessions().filter((row) => withArchived || !archived.has(row.session_id)).map((row) => {
      const item = items.find((one) => one.session_ids.includes(row.session_id)) ?? null;
      return { ...row, revision_count: counts.get(row.session_id) ?? 0,
        work_item: item === null ? null : { record_id: item.record_id, kind: item.kind, name: item.name, activity: item.activity, flow: item.flow },
        ...(withArchived ? { archived: archived.has(row.session_id), archived_at: archived.get(row.session_id)?.archived_at ?? null,
          archived_record_id: archived.get(row.session_id)?.record_id ?? null } : {}) };
    });
  }

  /**
   * 一份材料有没有进入对话：它上传之后，任务里任何一条会话有过活动。上传时刻取文件的修改时刻（上传时排他创建，之后后端不再改写它），
   * 与全部会话里最晚的一次活动按毫秒比，相等算进入了。进入对话的材料不许删除：助手可能已经读过、引用过它。
   * lastActivityMs 为 null（还没有任何会话活动）时一律没有进入。
   */
  private enteredConversation(file: string, lastActivityMs: number | null): boolean {
    if (lastActivityMs === null) return false;
    try {
      return lastActivityMs >= Math.floor(statSync(file).mtimeMs);
    } catch {
      return false; // 文件已经不在了，谈不上进入
    }
  }

  /** 整份数据：带 session 时先打开那条会话（pi 不在就按需启动或续接），再读库与对话记录。 */
  async snapshot(t: Task, session: string | null) {
    if (session) {
      try {
        await t.executor.openSession(session);
      } catch (error) {
        // 没有接上这条会话，或者助手没有启动起来：快照照常给（对话记录从会话文件读，条目从任务库读，都不依赖 pi），
        // 执行者状态里写明没有接上，或者没有启动起来的原因，页面据此整页只读。每次打开都照常再试着启动一次，问题修好之后刷新就能恢复。
        // 打开会话时报 executor_unavailable 的只有启动失败这一处；再核对一次执行者状态，别的原因（正在启动、另一条会话在工作等）照旧报错。
        const startFailed = error instanceof ApiError && error.code === "executor_unavailable" && t.executor.view().state === "failed_to_start";
        if (!(error instanceof ApiError && error.code === "session_resume_failed") && !startFailed) throw error;
      }
    }
    // 整份数据里的阶段是这条会话的：看它属于的工作项。
    const [seq, view, review] = library.taskSnapshot(t.dir, t.executor.reviewSince(), session);
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
      review_in_progress: review,
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

  /** 上传之前不看已有材料的那几样检查：文件名、类型、留用的名字、大小。返回材料目录相对任务目录的路径与它的全路径（不在就建）。 */
  private checkUpload(t: Task, filename: string, data: Buffer): { folderRel: string; folder: string } {
    if (!filename || filename.includes("/") || filename.includes("\\") || filename === "." || filename === "..") {
      throw new ApiError("bad_request", "文件名里不能带路径分隔符。");
    }
    if (!UPLOAD_TYPES.some((ext) => filename.toLowerCase().endsWith(ext))) throw new ApiError("unsupported_type", unsupportedTypeText());
    if (isReserved(filename)) throw new ApiError("bad_request", reservedNameText("材料"));
    if (data.length > maxUpload()) throw new ApiError("too_large", tooLargeText());
    const folderRel = or((t.definition() as Record<string, any>)["材料目录"], DEFAULT_MATERIALS_DIR) as string;
    const folder = join(t.dir, folderRel);
    mkdirSync(folder, { recursive: true });
    return { folderRel, folder };
  }

  /**
   * 与已有的材料重内容或者重名就拒绝。只与用户放进来的材料比（投影、分段清单这些派生文件不算，判断沿用材料清单的 derived_from）。
   * 先比内容，再比文件名：名字和内容都相同时报内容相同。摘要值（原始字节的 SHA-256）每次现算，不保存。
   * except 是不参加比较的那一份的路径：替换材料时，被换掉的那份还在材料目录里的时候用。
   */
  private refuseDuplicate(t: Task, filename: string, data: Buffer, except: string | null = null): void {
    const own = library.materials(t.dir, t.definition()).filter((m) => m.derived_from === null && m.path !== except);
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
  }

  /**
   * 上传一份材料。PDF 材料要另起一次运行生成派生文件，所以这一种是异步的（uploadPdf）；别的类型当场做完。
   * replacing 只在替换材料时给（见 Replacing）：新文件可以存的时候先把被换掉的那份移走，存好之后连同两条事件一起报出去；
   * 移走之后新文件没有存成，就把它原样移回去。
   * slot 是放进哪个槽位（流程声明里收材料的槽位键）：给了时角色取那个槽位的，找不到这个槽位就拒绝，什么都不写；
   * 没给时槽位空、角色「证据」。替换材料时不看它，新文件沿用被换掉的那份的槽位与角色。
   */
  upload(t: Task, filename: string, data: Buffer, session: string | null = null, replacing: Replacing | null = null, slot: string | null = null): { ok: true; path: string } | Promise<{ ok: true; path: string }> {
    const placement = this.placementOf(t, replacing ? null : slot);
    const { folderRel, folder } = this.checkUpload(t, filename, data);
    if (filename.toLowerCase().endsWith(".pdf")) return this.uploadPdf(t, filename, data, session, folderRel, folder, replacing, placement);
    const isDocx = filename.toLowerCase().endsWith(".docx");
    // 从这里到写完文件都是同步的：同一个服务里两个上传请求不会在比较与写入之间交错；不同的服务不会同时接手一个任务（占用标记）。
    const putBack = replacing ? replacing.takeAway() : null;
    try {
      this.refuseDuplicate(t, filename, data);
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
      this.announceAdded(t, session, path, target, replacing, placement);
      return { ok: true, path };
    } catch (error) {
      putBack?.();
      throw error;
    }
  }

  /** 上传时给的槽位键 → 记进材料表的槽位与角色。没给（或是空的）时是不经槽位的「证据」；任务的流程声明里没有这个收材料的槽位时拒绝。 */
  private placementOf(t: Task, slot: string | null): MaterialRole {
    if (slot === null || slot === "") return { slot: null, role: DEFAULT_MATERIAL_ROLE };
    const skillPath = String((t.definition() as Record<string, any>)["执行方法"] ?? "");
    const found = skillPath ? materialSlot(t.dir, skillPath, slot) : null;
    if (found === null) throw new ApiError("bad_request", `没有叫「${slot}」的材料槽位。`);
    return { slot: found.key, role: found.role! };
  }

  /**
   * 材料清单只在整份数据里读一次；上传之后推一条过程类事件 material_added，工作视图与任务页据此更新清单。
   * 材料属于任务，session_id 只说明是从哪条会话上传的（可空），订阅了别的会话的页面也收得到。PDF 材料另带 pdf 一项。
   * 替换材料时先说旧的那份没有了（replaced_by 是换上来的这份），再说新的这份（replaces 是被换掉的那份）：两份同名时页面也是先去掉再加上。
   * 发之前先在任务库的材料表里记下这份材料的槽位与角色（替换时连同旧的那份写上删除的时刻），事件里也带这两项。
   */
  private announceAdded(t: Task, session: string | null, path: string, target: string, replacing: Replacing | null, placement: MaterialRole): void {
    const st = statSync(target, { bigint: true });
    const facts = target.toLowerCase().endsWith(".pdf") ? pdfFacts(target) : null;
    const { slot, role } = insertMaterial(t.dir, path, placement, replacing?.path ?? null);
    if (replacing) t.hub.emit("material_removed", { session_id: session, at: clock.now(), path: replacing.path, replaced_by: path });
    t.hub.emit("material_added", {
      session_id: session, at: clock.now(), path, bytes: Number(st.size), modified_at: clock.fromEpochNs(st.mtimeNs), slot, role, ...(facts ? { pdf: facts } : {}),
      ...(replacing ? { replaces: replacing.path } : {}),
    });
  }

  /**
   * 上传一份 PDF 材料。三步，保证材料目录里要么 PDF 与它的三个派生文件都在、要么一个都没有：
   * 1. 先照规矩比较重内容、重名；
   * 2. 把 PDF 写进任务目录下的临时目录，在那里另起一次运行生成投影、分段清单与位置表（见 pdf_upload.ts）；整份没有可读的文字就拒绝；
   * 3. 等的这段时间里可能有别的上传进来，所以再比较一次，然后把四个文件一起移进材料目录（第 3 步是同步的，不会与别的上传交错）。
   * 哪一步不成都把临时目录删掉，材料目录里不留东西，也不发 material_added。
   * replacing 的意思与 upload 的相同。被换掉的那份在第 1、2 步里一直留在材料目录里（比较时不算它），到第 3 步才移走，紧接着移进新的四个文件；
   * 所以等解析的这段时间里它照旧在材料清单里、照旧可以查看，解析不成时材料目录从头到尾没有动过。
   */
  private async uploadPdf(t: Task, filename: string, data: Buffer, session: string | null, folderRel: string, folder: string, replacing: Replacing | null, placement: MaterialRole): Promise<{ ok: true; path: string }> {
    this.refuseDuplicate(t, filename, data, replacing?.path ?? null);
    const path = `${folderRel}${filename}`;
    const holding = join(t.dir, UPLOADING_DIR);
    const staging = join(holding, randomUUID());
    mkdirSync(staging, { recursive: true });
    const staged = join(staging, filename);
    try {
      writeFileSync(staged, data);
      let parsed;
      try {
        parsed = await runPdfProjection(staged, path, segmentParamsOf(this.profile), pdfLimitsOf(this.profile));
      } catch (error) {
        if (!(error instanceof PdfUploadError)) throw error;
        throw new ApiError("unsupported_type", error.message);
      }
      if (parsed.units === 0) throw new ApiError("unsupported_type", PDF_NO_TEXT);
      const target = join(folder, filename);
      const putBack = replacing ? replacing.takeAway() : null;
      try {
        this.refuseDuplicate(t, filename, data);
        const names = [...PDF_DERIVED_SUFFIXES.map((suffix) => filename + suffix), filename];
        // 文件系统认为同名的文件已经在了（例如只差大小写）：不覆盖，按同名拒绝。
        if (names.some((name) => existsSync(join(folder, name)))) throw new ApiError("name_taken", nameTakenText(filename), { path });
        const moved: string[] = [];
        try {
          for (const name of names) {
            renameSync(join(staging, name), join(folder, name));
            moved.push(name);
          }
        } catch (error) {
          for (const name of moved) rmSync(join(folder, name), { force: true });
          throw error;
        }
      } catch (error) {
        putBack?.();
        throw error;
      }
      this.announceAdded(t, session, path, target, replacing, placement);
      return { ok: true, path };
    } finally {
      rmSync(staging, { recursive: true, force: true });
      try {
        rmdirSync(holding); // 没有别的上传还在用它时才删得掉
      } catch {
        // 还有别的上传在用，或者已经不在了
      }
    }
  }

  /**
   * 删除与替换共用的前提：只接受用户放进来的材料（派生文件的路径不接受），路径必须落在材料目录里；已经进入对话的材料不动
   * （见 enteredConversation），所以被条目引用过的材料既删不掉也换不掉；助手正在工作时不动。verb 是「删除」或「替换」，写进说明里。
   */
  private requireUntouched(t: Task, rel: unknown, verb: "删除" | "替换", enteredText: string): { path: string; target: string } {
    const path = typeof rel === "string" ? rel : "";
    const target = this.materialPath(t, path);
    const row = library.materials(t.dir, t.definition()).find((m) => m.path === path);
    if (row && row.derived_from !== null) throw new ApiError("bad_request", `这是由别的材料生成的文件，不能单独${verb}。`);
    if (!row || !isFile(target)) throw new ApiError("not_found", `没有材料 ${path}。`);
    if (this.enteredConversation(target, t.executor.sessions.lastActivityMs())) {
      throw new ApiError("rejected", enteredText, { path, reasons: [enteredText] });
    }
    if (t.executor.state === "working") {
      throw new ApiError("session_busy", `助手正在工作，结束后才能${verb}材料。`, { active_session: t.executor.activeSession, reason: "working" });
    }
    return { path, target };
  }

  /** 删除一份材料：本体连同 Word 材料的投影、分段清单、位置表与图片目录一起删，PDF 材料连同它的投影、分段清单与位置表一起删。前提见 requireUntouched。 */
  deleteMaterial(t: Task, rel: unknown, session: string | null = null) {
    const { path, target } = this.requireUntouched(t, rel, "删除", ENTERED_CONVERSATION_TEXT);
    unlinkSync(target);
    if (target.toLowerCase().endsWith(".docx")) {
      removeProjection(target);
      try {
        unlinkSync(target + ".txt"); // 0.2 的纯文本投影
      } catch {
        // 本来就没有
      }
    }
    if (target.toLowerCase().endsWith(".pdf")) removePdfProjection(target);
    retireMaterial(t.dir, path);
    t.hub.emit("material_removed", { session_id: session, at: clock.now(), path });
    return { ok: true, path };
  }

  /**
   * 用另一个文件替换一份还没有进入对话的材料（前提与删除相同，见 requireUntouched）。新文件照上传的规矩收（类型、大小、留用的名字、
   * 与别的材料重内容或重名、Word 材料与 PDF 材料生成派生文件），名字与类型可以和旧的不同；新文件与旧文件内容完全相同时不换。
   *
   * 做法：照常上传新文件，另交给上传一个「把旧材料移走」的函数（见 Replacing）。上传在新文件已经可以存的那一刻才调它：
   * 把旧文件连同由它生成的文件移到任务目录下的暂放目录，紧接着存新文件，中间没有等待，别的请求插不进来；新文件没有存成就原样移回去
   * （修改时刻不变），上传的错误原样报出去。新文件是 PDF 时要先等另起的那次运行把它解析好（见 uploadPdf），等的这段时间里旧材料
   * 一直留在材料目录里；因为等过，移走之前把前提再查一遍（这段时间里它可能进入了对话、被删掉、被换掉，或者任务结束了）。
   * 哪些文件是由旧材料生成的，取自材料清单的 derived_from，另加 Word 材料的图片目录（材料清单不列子目录）。
   * 新文件的修改时刻是替换的这一刻，所以它照旧算没有进入对话，直到有会话活动。
   */
  async replaceMaterial(t: Task, rel: unknown, filename: string, data: Buffer, session: string | null = null) {
    const { path, target } = this.requireUntouched(t, rel, "替换", ENTERED_CONVERSATION_REPLACE_TEXT);
    if (sha256(readFileSync(target)) === sha256(data)) throw new ApiError("duplicate_content", SAME_AS_REPLACED_TEXT, { path });
    const folder = dirname(target);
    const holding = join(t.dir, REPLACING_DIR);
    const aside = join(holding, randomUUID());
    const moved: string[] = [];
    const putBack = () => {
      // 移回去本身出了错时 moved 里还剩着没移回的名字，暂放目录因此留着不删，旧文件还在里面。
      while (moved.length) {
        const name = moved[moved.length - 1];
        renameSync(join(aside, name), join(folder, name));
        moved.pop();
      }
    };
    const takeAway = () => {
      this.requireUntouched(t, path, "替换", ENTERED_CONVERSATION_REPLACE_TEXT);
      const names = [basename(target), ...library.materials(t.dir, t.definition()).filter((m) => m.derived_from === path).map((m) => basename(m.path))];
      if (existsSync(target + MEDIA_SUFFIX)) names.push(basename(target) + MEDIA_SUFFIX);
      mkdirSync(aside, { recursive: true });
      try {
        for (const name of names) {
          renameSync(join(folder, name), join(aside, name));
          moved.push(name);
        }
      } catch (error) {
        putBack();
        throw error;
      }
      return putBack;
    };
    let stored = false;
    try {
      const added = await this.upload(t, filename, data, session, { path, takeAway });
      stored = true;
      return { ok: true, path: added.path, replaced: path };
    } finally {
      // 存好了：暂放的旧文件不要了。没存成而旧文件都移回去了（或者根本没移走过）：只剩空目录，或者目录还没建。
      if (stored || moved.length === 0) rmSync(aside, { recursive: true, force: true });
      try {
        rmdirSync(holding); // 没有别的替换还在用它、里面也没有留下东西时才删得掉
      } catch {
        // 还有别的替换在用，或者已经不在了
      }
    }
  }

  // ───────────── 知识库 ─────────────

  requireKnowledge(): KnowledgeStore {
    if (this.knowledge === null) throw new ApiError("not_found", "这个服务没有配置知识库。");
    return this.knowledge;
  }

  /** 本服务接手了的任务：选用了多少个库按它们数；被别的服务占用的任务不数。 */
  private openTasks(): Task[] {
    this.scan();
    return [...this.tasks.values()].filter((t) => t.row() !== null);
  }

  /**
   * 全部库与每个库的文档清单；used_by_tasks 是本服务接手的任务里选用了它的个数。每份文档带换算状态（embedding），
   * 每个库带「换算好了几份、一共几份」。
   */
  knowledgeOverview() {
    const store = this.requireKnowledge();
    const embedder = this.embedder!;
    const model = embedder.model();
    const selections = this.openTasks().map((t) => selectedLibraries(t.dir));
    return store.libraries().map((lib) => {
      const documents = store.documents(lib.id).map((row) => ({
        name: row.name, kind: row.kind, bytes: row.bytes, uploaded_at: row.uploaded_at, embedding: embedder.documentState(lib.id, row, model),
      }));
      return {
        ...lib,
        used_by_tasks: selections.filter((ids) => ids.includes(lib.id)).length,
        embedding: { done: documents.filter((one) => one.embedding.status === "done").length, total: documents.length },
        documents,
      };
    });
  }

  /** 这些知识库合起来的换算情况（不给是全部知识库）：选定的嵌入模型、是不是都换算好了、还差几份、停下的原因。 */
  knowledgeEmbedding(libraries?: string[]) {
    this.requireKnowledge();
    return this.embedder!.overview(libraries);
  }

  /**
   * 查找知识库：按意思与按字面两路并行，按意思那一路做不了时退到只按字面（knowledge_search.ts）。
   * signal 在调用的一方断开连接时中止。
   */
  searchKnowledge(body: Record<string, any>, signal?: AbortSignal) {
    const store = this.requireKnowledge();
    return searchKnowledge(store, this.embedder!, { env: process.env, profile: this.profile }, searchRequest(body), { signal, params: segmentParamsOf(this.profile) });
  }

  /** 上传一份文档；选了嵌入模型时随即把它排进后台换算，没有选时它是「未换算」。 */
  async uploadDocument(id: string, filename: string, data: Buffer, kind: unknown) {
    // PDF 文档要另起一次运行生成派生文件，等它做完；别的类型当场就有结果。
    const row = await this.requireKnowledge().upload(id, filename, data, kind, segmentParamsOf(this.profile), pdfLimitsOf(this.profile));
    const embedder = this.embedder!;
    if (embedder.model() !== null) embedder.enqueue({ library: id, name: row.name });
    return row;
  }

  /** 删除一份文档：正在换算或者排着队的先放下，再连同它的数字串一起删。 */
  removeDocument(id: string, name: unknown): void {
    const store = this.requireKnowledge();
    if (typeof name === "string") this.embedder!.forget(id, name);
    store.removeDocument(id, name);
  }

  /**
   * 开始换算：body 里不给范围是全部知识库，给 library 是那一个库，再给 name 是那一份文档。返回这一次新排进去几份与换算情况。
   * 没有选嵌入模型时 rejected。
   */
  embedKnowledge(body: Record<string, any>) {
    this.requireKnowledge();
    const { library, name } = body;
    if (library !== undefined && typeof library !== "string") throw new ApiError("bad_request", "library 应当是知识库编号。");
    if (name !== undefined && (typeof name !== "string" || library === undefined)) throw new ApiError("bad_request", "name 应当是文档名，并且要同时给 library。");
    const queued = this.embedder!.enqueue({ library, name });
    return { ok: true, queued, embedding: this.embedder!.overview() };
  }

  /**
   * 删除库：文档一并删除；本服务接手的任务里选用了它的，改为不再选用，并在任务的 knowledge.json 里记一句（不发事件）。
   * 被别的服务占用的任务不改。
   */
  removeLibrary(id: string) {
    const store = this.requireKnowledge();
    if (store.has(id)) this.embedder!.forget(id);
    const row = store.remove(id);
    this.scan();
    for (const t of this.tasks.values()) {
      const ids = selectedLibraries(t.dir);
      if (ids.includes(id)) writeSelection(t.dir, ids.filter((one) => one !== id), `知识库「${row.name}」已经删除，这个任务不再选用它。`);
    }
    return { ok: true, id };
  }

  /** 改任务选用的库：不存在的库以 rejected 拒绝；可以一个都不选。 */
  setTaskKnowledge(t: Task, body: Record<string, any>) {
    const store = this.requireKnowledge();
    const given = body.libraries;
    if (!Array.isArray(given) || !given.every((one) => typeof one === "string")) throw new ApiError("bad_request", "libraries 应当是知识库编号的列表。");
    const unknown = given.filter((one) => !store.has(one));
    if (unknown.length) throw new ApiError("rejected", `没有这个知识库：${unknown.join("、")}。`, { unknown });
    const ids = [...new Set(given)];
    writeSelection(t.dir, ids);
    return { ok: true, libraries: ids };
  }

  /**
   * 材料原文：.docx 给投影（先找 .md 再找旧的 .txt；都不在时现算一份，不写文件），.pdf 给上传时生成的投影，
   * 其余按 UTF-8 读（不合法的字节换成替换字符）。
   */
  materialText(target: string, rel: string): string {
    if (target.toLowerCase().endsWith(".pdf")) {
      const projection = target + PDF_PROJECTION_SUFFIX;
      if (!isFile(projection)) throw new ApiError("not_found", `没有由 ${rel} 生成的文字版。`);
      return readTextFile(projection);
    }
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
