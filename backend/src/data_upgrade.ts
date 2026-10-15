/**
 * 数据升级：把一个数据目录里上一版留下的数据升到这个程序的格式。服务启动时与命令行（taskwright data upgrade）走的是这同一段代码。
 *
 * 分三步：
 * 1. 看（planUpgrade）：只读地看服务级库与每个任务库的格式版本，得出要升级什么。什么都不改。
 * 2. 备份：把要改的文件复制到数据目录下 backups/<年月日-时分秒>-<旧产品版本>/。有一样复制不成就不升级。
 * 3. 升级（runUpgrade）：服务级库没有就建、旧就升；任务一个一个升，走的是助手写库时用的同一张步骤表
 *    （agent/src/lib/schema.ts 的 UPGRADE_STEPS，经 upgradeTaskDatabase）。一个任务没有做成不挡别的：记下原因接着做下一个。
 * 做完写一份报告到数据目录的 logs/ 下，页面与命令行显示的是同一份内容。
 *
 * 本文件不直接碰数据库：读任务库的版本与备份经 library.ts，服务级库经 service_db.ts，改任务库经助手一侧的 upgradeTaskDatabase。
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { DB_NAME } from "../../agent/src/lib/db.ts";
// upgradeTaskDatabase 是后端里除建任务之外唯一会改任务库的调用，只在这里（数据升级）用。
import { MIN_TASK_DB_VERSION, TASKS_ROOT_ENV, TASK_DB_VERSION, newerDataText, taskWrittenBy, upgradeTaskDatabase } from "../../agent/src/lib/schema.ts";
import * as clock from "./clock.ts";
import * as library from "./library.ts";
import * as occupancy from "./occupancy.ts";
import { expandUser } from "./launch.ts";
import { ENV_DATA_DIR, appVersion, dataDirectory, userDataDir } from "./paths.ts";
import { settingsFile } from "./product_settings.ts";
import { DATA_FORMAT, NewerDataDirectory, SERVICE_DB_NAME, ServiceDb, backupServiceDb, peekDataDirectory } from "./service_db.ts";
import { readTaskJson, taskJsonPath, writeTaskJson } from "./task_json.ts";

/** 数据目录里与升级有关的三个位置。 */
export interface DataLocations {
  dataDir: string;
  tasksDir: string;
  /** 知识库根目录；没有知识库时是 null。 */
  knowledgeDir: string | null;
}

/**
 * 由命令行给的几个目录定出各自的位置（服务启动与命令行升级用同一个定法）。任务目录、归档目录、知识库目录没有另给时：
 * 明说了数据目录（--data 或环境变量 TASKWRIGHT_DATA_DIR）就在它下面，否则照旧在用户数据目录下。数据目录自己怎样定见
 * paths.ts 的 dataDirectory。
 */
export function locate(given: { data?: string; tasks?: string; runs?: string; knowledge?: string }, env: NodeJS.ProcessEnv = process.env):
  DataLocations & { knowledgeDir: string; runsDir: string } {
  const base = given.data ? expandUser(given.data) : env[ENV_DATA_DIR] || userDataDir();
  const tasksDir = expandUser(given.tasks ?? join(base, "tasks"));
  return {
    dataDir: dataDirectory(given.data ? expandUser(given.data) : null, given.tasks ? tasksDir : null, env), tasksDir,
    runsDir: expandUser(given.runs ?? join(base, "runs")), knowledgeDir: expandUser(given.knowledge ?? join(base, "knowledge")),
  };
}

/**
 * 升级这份数据要运行的完整命令。任务目录、知识库目录不在数据目录下的缺省位置时（启动服务时另给了 --tasks、--knowledge），
 * 把各自的参数带上：只带 --data 的话，命令会去数据目录下面找任务，找不到就空跑一次。带空白的路径加引号。
 */
export function upgradeCommandLine(where: DataLocations): string {
  const quoted = (path: string): string => (/\s/.test(path) ? `"${path}"` : path);
  const parts = ["taskwright data upgrade", "--data", quoted(where.dataDir)];
  if (resolve(where.tasksDir) !== resolve(join(where.dataDir, "tasks"))) parts.push("--tasks", quoted(where.tasksDir));
  if (where.knowledgeDir && resolve(where.knowledgeDir) !== resolve(join(where.dataDir, "knowledge"))) parts.push("--knowledge", quoted(where.knowledgeDir));
  return parts.join(" ");
}

/** 一个要升级（或者升不了）的任务。 */
export interface PlannedTask {
  /** 任务目录的名字（相对任务根目录）。 */
  dir: string;
  task_id: string | null;
  name: string | null;
  /** 任务库现在的格式版本。 */
  version: number;
}

export interface UpgradePlan extends DataLocations {
  /** 服务级库：还没有（missing，升级时建）、格式旧（outdated）、已经是现在的（current）、比这个程序新（newer）。 */
  service: { state: "missing" | "outdated" | "current" | "newer"; data_format: number | null; written_by: string | null };
  /** 要升级的任务：格式比现在的旧，而且没有记着升级失败。 */
  tasks: PlannedTask[];
  /** 记着升级失败的任务：启动时不再自动重试，命令行每次都重试。 */
  failed: (PlannedTask & { error: string })[];
  /** 比这个程序新的任务：不动它。 */
  newer: (PlannedTask & { written_by: string | null })[];
  /** 现在的程序版本要的任务库格式。 */
  target: number;
}

/** 任务目录里那几行给人看的：编号与名字。读不出来都是 null。 */
function taskLabel(taskDir: string): { task_id: string | null; name: string | null } {
  const db = library.openRo(taskDir);
  try {
    const row = db ? (db.prepare("SELECT task_id, task_name FROM task LIMIT 1").get() as Record<string, any> | undefined) : undefined;
    return { task_id: row?.task_id ?? null, name: row?.task_name || null };
  } catch {
    return { task_id: null, name: null };
  } finally {
    db?.close();
  }
}


/** 只读地看一遍数据目录，得出要升级什么。什么都不改，也不建任何文件。 */
export function planUpgrade(where: DataLocations): UpgradePlan {
  const state = peekDataDirectory(where.dataDir);
  const service: UpgradePlan["service"] = state === null ? { state: "missing", data_format: null, written_by: null }
    : { state: state.data_format > DATA_FORMAT ? "newer" : state.data_format < DATA_FORMAT ? "outdated" : "current", data_format: state.data_format, written_by: state.last_written_by };
  const plan: UpgradePlan = { ...where, service, tasks: [], failed: [], newer: [], target: TASK_DB_VERSION };
  // 记着升级失败的任务目录：服务级库还读得了时从登记表取（只读）。
  const failures = new Map<string, string>();
  if (service.state === "current" || service.state === "outdated") {
    for (const row of readFailures(where.dataDir)) failures.set(row.dir, row.error);
  }
  let names: string[] = [];
  try {
    names = readdirSync(where.tasksDir).sort(library.byCodePoint);
  } catch {
    // 任务根目录还不存在：没有任务
  }
  for (const dir of names) {
    const taskDir = join(where.tasksDir, dir);
    const version = library.taskDbVersion(taskDir);
    if (version === null || version === TASK_DB_VERSION) continue;
    const task: PlannedTask = { dir, ...taskLabel(taskDir), version };
    if (version > TASK_DB_VERSION) plan.newer.push({ ...task, written_by: taskWrittenBy(taskDir) });
    // 格式早于本程序能升级的最早格式：不升级，服务把它列为旧格式。
    else if (version < MIN_TASK_DB_VERSION) continue;
    else if (failures.has(dir)) plan.failed.push({ ...task, error: failures.get(dir)! });
    else plan.tasks.push(task);
  }
  return plan;
}

/** 登记表里记着升级失败的任务目录与原因。只读一下就关。 */
function readFailures(dataDir: string): { dir: string; error: string }[] {
  let db: ServiceDb | null = null;
  try {
    db = ServiceDb.read(dataDir);
    return db ? db.tasks().filter((t) => t.upgrade_error).map((t) => ({ dir: t.dir, error: t.upgrade_error! })) : [];
  } catch {
    return [];
  } finally {
    db?.close();
  }
}

/**
 * 启动时要不要先做数据升级：有任务要升级，或者服务级库的格式旧。服务级库只是还没有（全新的数据目录、或者第一次用这一版而没有
 * 任何任务）不算，启动时直接建。记着失败的任务不算（它们在列表里标「需要处理」，由命令行重试）。
 */
export function upgradeNeeded(plan: UpgradePlan): boolean {
  return plan.tasks.length > 0 || plan.service.state === "outdated";
}

/** 任务根目录下被别的、还活着的服务占着的任务目录。 */
export function occupiedTasks(tasksDir: string): { dir: string; lock: occupancy.Lock }[] {
  const out: { dir: string; lock: occupancy.Lock }[] = [];
  let names: string[] = [];
  try {
    names = readdirSync(tasksDir).sort(library.byCodePoint);
  } catch {
    return out;
  }
  for (const dir of names) {
    const lock = occupancy.readLock(join(tasksDir, dir));
    if (occupancy.occupiedByOther(lock)) out.push({ dir, lock: lock! });
  }
  return out;
}

/** 报告里一个任务的一行。 */
export interface TaskOutcome {
  dir: string;
  task_id: string | null;
  name: string | null;
  from: number;
  /** 升级之后的格式版本；没有做成时与 from 相同。 */
  to: number;
  ok: boolean;
  /** 没有做成的原因。 */
  error: string | null;
  ms: number;
  /** 升级时另做了的事，写进报告那一行的末尾，例如「补了业务说明集合」「补了第 1 版的版本记录（早先已完成，修订 12）」。 */
  notes?: string[];
}

export interface UpgradeReport {
  product_version: string;
  started_at: string;
  finished_at: string;
  data_dir: string;
  /** 这一次扫的是哪个任务目录（各个任务目录的上级目录）。 */
  tasks_dir: string;
  /** 备份放在哪里、一共多少字节、里面有几个文件；没有东西要备份时文件数是 0。备份没有做成、或者这一次不做备份时是 null。 */
  backup: { dir: string; bytes: number; files: number } | null;
  /** 服务级库这一次是新建的（created）、升级的（upgraded）还是本来就是现在的格式（current）；整体没有做成时是 null。 */
  service: "created" | "upgraded" | "current" | null;
  tasks: TaskOutcome[];
  succeeded: number;
  failed: number;
  /** 整体没有做成的原因（备份不成、服务级库打不开）：这时一个任务都没有动。做成了是 null。 */
  fatal: string | null;
  /** 这份报告写在哪个文件里；没有写成时是 null。 */
  file: string | null;
}

/** 进度：一共几项、做完了几项、正在做哪一项（给人看的一句）。 */
export interface UpgradeProgress {
  total: number;
  done: number;
  current: string | null;
}

export interface RunOptions {
  /** 记着升级失败的任务也再试一次（命令行每次都试；启动时的升级不试）。 */
  retryFailed?: boolean;
  /**
   * 给假时不做升级之前的备份：只给数据包用（data_pack.ts 把包解到一个暂存的数据目录里再升级，那个目录本身就是副本）。
   * 对真正的数据目录一律要备份，所以缺省是做。
   */
  backup?: boolean;
  onProgress?: (progress: UpgradeProgress) => void;
  /** 时刻与产品版本可以由测试给定。 */
  now?: () => Date;
  productVersion?: string;
  env?: NodeJS.ProcessEnv;
}

const pad = (n: number) => String(n).padStart(2, "0");
/** 目录名与文件名里用的时刻：年月日-时分秒（本机时间）。 */
const stamp = (at: Date) => `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}-${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}`;

/** 备份目录名里的「旧产品版本」：服务级库里记的最近写它的版本；上一版没有服务级库，写 pre-0.5。只留文件名里放得下的字符。 */
function previousVersion(plan: UpgradePlan): string {
  return (plan.service.written_by ?? "pre-0.5").replace(/[^0-9A-Za-z._-]/g, "_");
}

/**
 * 升级之前的备份：要升级的每个任务的任务库与 task.json、服务级库、产品设置文件、知识库清单。返回备份目录、字节数与文件数。
 * 有一样复制不成就抛错（调用方据此不升级）。
 */
async function backupBeforeUpgrade(plan: UpgradePlan, tasks: PlannedTask[], at: Date, env: NodeJS.ProcessEnv): Promise<{ dir: string; bytes: number; files: number }> {
  const dir = join(plan.dataDir, "backups", `${stamp(at)}-${previousVersion(plan)}`);
  let bytes = 0;
  let files = 0;
  const copy = (from: string, to: string) => {
    if (!existsSync(from)) return;
    mkdirSync(join(to, ".."), { recursive: true });
    copyFileSync(from, to);
    bytes += statSync(to).size;
    files += 1;
  };
  for (const task of tasks) {
    const from = join(plan.tasksDir, task.dir);
    bytes += await library.backupTaskDb(from, join(dir, "tasks", task.dir, DB_NAME));
    files += 1;
    copy(taskJsonPath(from), join(dir, "tasks", task.dir, basename(taskJsonPath(from))));
  }
  const service = await backupServiceDb(plan.dataDir, join(dir, SERVICE_DB_NAME));
  if (service !== null) {
    bytes += service;
    files += 1;
  }
  const settings = settingsFile(env);
  copy(settings, join(dir, basename(settings)));
  if (plan.knowledgeDir) copy(join(plan.knowledgeDir, "libraries.json"), join(dir, "knowledge", "libraries.json"));
  return { dir, bytes, files };
}

/** 任务目录里那份任务定义写的版本（任务类型说明是第几版）；读不出来或者没有写是 null。 */
function copiedTypeVersion(taskDir: string, definitionPath: string | null): number | null {
  if (!definitionPath) return null;
  try {
    const version = JSON.parse(readFileSync(join(taskDir, definitionPath), "utf-8"))["版本"];
    return Number.isInteger(version) ? version : null;
  } catch {
    return null;
  }
}

/** 一个任务升级做成之后：补写 task.json，记进登记表并清掉先前记的失败。 */
function afterTaskUpgraded(plan: UpgradePlan, dir: string, registry: ServiceDb, productVersion: string): void {
  const taskDir = join(plan.tasksDir, dir);
  const db = library.openRo(taskDir);
  let row: Record<string, any> | undefined;
  try {
    row = db ? (db.prepare("SELECT task_id, task_name, definition_path, started_at FROM task LIMIT 1").get() as Record<string, any> | undefined) : undefined;
  } finally {
    db?.close();
  }
  const taskType = typeof row?.definition_path === "string" ? basename(row.definition_path).replace(/\.json$/i, "") : null;
  const had = readTaskJson(taskDir);
  writeTaskJson(taskDir, {
    created_by_version: had?.created_by_version ?? null, task_type: had?.task_type ?? taskType,
    task_type_version: had ? had.task_type_version : copiedTypeVersion(taskDir, row?.definition_path ?? null),
    // 用的是任务类型的第几个修订：没有记过的（任务类型落到用户目录之前建的）按播种版算，记作修订 1。
    task_type_revision: had?.task_type_revision ?? 1,
    owner: had?.owner ?? "local", created_at: had?.created_at ?? row?.started_at ?? null,
    upgraded_by_version: productVersion, upgraded_at: clock.now(),
  });
  if (row?.task_id) {
    registry.putTask({ task_id: row.task_id, name: row.task_name || null, owner: had?.owner ?? "local", status: null,
      task_type: taskType, created_at: row.started_at ?? null, dir });
  }
  registry.clearUpgradeFailed(dir);
}

/**
 * 照 plan 做一次数据升级，返回报告与打开着的服务级库（整体没有做成时是 null）。调用方用完服务级库要关掉它，或者交给服务对象。
 * 被别的、还活着的服务占着的任务不升级，报告里写「任务正在被另一个服务使用」。
 */
export async function runUpgrade(plan: UpgradePlan, options: RunOptions = {}): Promise<{ report: UpgradeReport; registry: ServiceDb | null }> {
  const now = options.now ?? (() => new Date());
  const env = options.env ?? process.env;
  const productVersion = options.productVersion ?? appVersion();
  const started = now();
  const tasks = [...plan.tasks, ...(options.retryFailed ? plan.failed : [])].sort((a, b) => library.byCodePoint(a.dir, b.dir));
  const report: UpgradeReport = { product_version: productVersion, started_at: clock.now(), finished_at: "", data_dir: plan.dataDir, tasks_dir: plan.tasksDir, backup: null,
    service: null, tasks: [], succeeded: 0, failed: 0, fatal: null, file: null };
  const total = tasks.length + 2;
  let done = 0;
  const progress = (current: string | null) => options.onProgress?.({ total, done, current });
  let registry: ServiceDb | null = null;
  try {
    if (plan.service.state === "newer") throw new Error(newerDataText(plan.service.written_by));
    if (options.backup !== false) {
      progress("正在备份");
      try {
        report.backup = await backupBeforeUpgrade(plan, tasks, started, env);
      } catch (error) {
        throw new Error(`升级之前的备份没有做成，所以没有升级：${(error as Error).message}`);
      }
    }
    done += 1;
    progress("正在准备数据目录");
    try {
      registry = ServiceDb.open(plan.dataDir, productVersion);
    } catch (error) {
      throw new Error(error instanceof NewerDataDirectory ? newerDataText(error.writtenBy) : `数据目录没有升级成：${(error as Error).message}`);
    }
    report.service = plan.service.state === "missing" ? "created" : plan.service.state === "outdated" ? "upgraded" : "current";
    done += 1;
    // 助手一侧写任务库之前要核对它在本服务的任务根目录之下：告诉它这一次的任务根目录是哪个。
    const before = process.env[TASKS_ROOT_ENV];
    process.env[TASKS_ROOT_ENV] = plan.tasksDir;
    try {
      for (const task of tasks) {
        progress(`正在升级任务「${task.name ?? task.task_id ?? task.dir}」`);
        const t0 = Date.now();
        const outcome: TaskOutcome = { dir: task.dir, task_id: task.task_id, name: task.name, from: task.version, to: task.version, ok: false, error: null, ms: 0 };
        try {
          const lock = occupancy.readLock(join(plan.tasksDir, task.dir));
          if (occupancy.occupiedByOther(lock)) throw new Error("任务正在被另一个服务使用");
          const result = upgradeTaskDatabase(join(plan.tasksDir, task.dir));
          outcome.to = result.to;
          outcome.notes = result.notes;
          afterTaskUpgraded(plan, task.dir, registry, productVersion);
          outcome.ok = true;
          report.succeeded += 1;
        } catch (error) {
          outcome.error = (error as Error).message;
          report.failed += 1;
          registry.markUpgradeFailed(task.dir, clock.now(), outcome.error);
        }
        outcome.ms = Date.now() - t0;
        report.tasks.push(outcome);
        done += 1;
      }
    } finally {
      if (before === undefined) delete process.env[TASKS_ROOT_ENV];
      else process.env[TASKS_ROOT_ENV] = before;
    }
  } catch (error) {
    report.fatal = (error as Error).message;
    registry?.close();
    registry = null;
  }
  progress(null);
  report.finished_at = clock.now();
  try {
    const dir = join(plan.dataDir, "logs");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `upgrade-${stamp(started)}.txt`);
    report.file = file;
    writeFileSync(file, reportText(report), "utf-8");
  } catch {
    report.file = null;
  }
  return { report, registry };
}

const sizeText = (bytes: number) => (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : bytes >= 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${bytes} 字节`);

/** 报告写成给人看的一段文字：页面与命令行显示的、写进文件的都是它。 */
export function reportText(report: UpgradeReport): string {
  const lines = [`数据升级报告（${report.product_version}）`, `数据目录：${report.data_dir}`, `任务目录：${report.tasks_dir}`, `开始：${report.started_at}　结束：${report.finished_at}`];
  if (report.backup) {
    lines.push(report.backup.files > 0 ? `升级之前的备份：${report.backup.dir}（${report.backup.files} 个文件，${sizeText(report.backup.bytes)}）` : "升级之前的备份：没有要备份的文件");
  }
  if (report.fatal) {
    lines.push(`没有升级：${report.fatal}`);
    return lines.join("\n") + "\n";
  }
  lines.push(report.service === "created" ? "数据目录：新建了任务登记" : report.service === "upgraded" ? "数据目录：升级了任务登记" : "数据目录：不需要升级");
  lines.push("知识库：不需要升级");
  if (report.tasks.length === 0) lines.push("任务：没有要升级的");
  for (const t of report.tasks) {
    const label = `${t.task_id ?? t.dir}${t.name ? `「${t.name}」` : ""}`;
    const notes = t.notes?.length ? `；${t.notes.join("；")}` : "";
    lines.push(t.ok ? `任务 ${label}：格式 ${t.from} 升到 ${t.to}，成功，用了 ${t.ms} 毫秒${notes}` : `任务 ${label}：格式 ${t.from}，没有升级成（${t.error}），用了 ${t.ms} 毫秒`);
  }
  lines.push(`合计：${report.tasks.length} 个任务，成功 ${report.succeeded} 个，没有做成 ${report.failed} 个。`);
  if (report.failed > 0 && report.backup?.files) lines.push(`没有做成的任务原样没动；要回到升级之前，把备份里的文件复制回去：${report.backup.dir}`);
  return lines.join("\n") + "\n";
}

/**
 * 服务启动时发现要先做数据升级（桌面形态）：服务起来了，但在升级做完之前不对外提供别的功能。页面上显示要升级什么，
 * 用户点「开始升级」才做（start）。状态：pending 还没有开始；running 正在做；done 做完了（个别任务没有做成也算做完，
 * 报告里写着）；failed 整体没有做成（备份不成、数据目录打不开），一个任务都没有动，可以再试。
 */
export class PendingUpgrade {
  plan: UpgradePlan;
  state: "pending" | "running" | "done" | "failed" = "pending";
  progress: UpgradeProgress | null = null;
  report: UpgradeReport | null = null;
  /** 做完时把打开着的服务级库交出去（交给服务对象）。 */
  private readonly onDone: (registry: ServiceDb) => void;
  private readonly options: RunOptions;

  constructor(plan: UpgradePlan, onDone: (registry: ServiceDb) => void, options: RunOptions = {}) {
    this.plan = plan;
    this.onDone = onDone;
    this.options = options;
  }

  /** 服务是不是还在等升级（等着、正在做、或者整体没有做成）：这段时间别的接口都不给用。 */
  get blocking(): boolean {
    return this.state !== "done";
  }

  /** 给页面看的：状态、要升级什么、备份会放在哪里、进度与报告（连同给人看的那段文字）。 */
  view() {
    return {
      state: this.state, data_dir: this.plan.dataDir, backup_dir: join(this.plan.dataDir, "backups"),
      tasks: this.plan.tasks.map((t) => ({ task_id: t.task_id ?? t.dir, name: t.name })),
      service: this.plan.service.state === "outdated", knowledge: false,
      progress: this.progress, report: this.report ? { ...this.report, text: reportText(this.report) } : null,
    };
  }

  /**
   * 开始升级；立刻返回，升级在后面做，进度与结果经 view 看。正在做或者已经做完时什么都不做，返回假。
   * 整体没有做成之后再调是再试一次：重新看一遍数据目录再做。
   */
  start(): boolean {
    if (this.state === "running" || this.state === "done") return false;
    if (this.state === "failed") this.plan = planUpgrade(this.plan);
    this.state = "running";
    this.report = null;
    this.progress = { total: this.plan.tasks.length + 2, done: 0, current: null };
    void runUpgrade(this.plan, { ...this.options, onProgress: (progress) => (this.progress = progress) }).then(({ report, registry }) => {
      this.report = report;
      if (registry === null) {
        this.state = "failed";
        return;
      }
      this.onDone(registry);
      this.state = "done";
    }, (error: Error) => {
      // runUpgrade 自己把错都写进报告里；到这里是意料之外的错，照整体没有做成算。
      this.report = { product_version: this.options.productVersion ?? appVersion(), started_at: clock.now(), finished_at: clock.now(), data_dir: this.plan.dataDir,
        tasks_dir: this.plan.tasksDir, backup: null, service: null, tasks: [], succeeded: 0, failed: 0, fatal: error.message, file: null };
      this.state = "failed";
    });
    return true;
  }
}
