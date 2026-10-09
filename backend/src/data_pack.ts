/**
 * 数据包：把任务与知识库导出成一个 zip 文件（扩展名 .taskwright.zip），换机器、把单机的数据搬上服务器、或者升级之前先留一份时用。
 *
 * 包里有什么：
 *   manifest.json                清单文件：包的格式版本、产品版本、数据的格式版本、导出时刻、导出范围、任务清单、知识库清单、
 *                                每个文件的路径、字节数、SHA-256 与修改时刻，还有包里的空目录。它是包里最后一个条目，自己不列在文件清单里。
 *   tasks/<任务编号>/…           任务目录里的文件：任务库（task.sqlite，一个完整的副本）、docs、inputs、task.json、选用的知识库、
 *                                建任务时放进来的设置与方法说明。
 *   runs/<任务编号>/…            这个任务的归档（对话记录与事件记录），原样。没有对话过的任务没有这一部分。
 *   knowledge/<库编号>/…         知识库目录，原样：文档、文字版、片段与换算好的数字串。
 *   knowledge/libraries.json     包里这些库在知识库清单里的条目。
 *   service/tasks.json           包里这些任务在任务登记表里的行。
 * 包里没有：产品设置、模型配置与密钥、用户与会话；占用标记、任务库旁边的日志文件、上传到一半的暂存目录与各种临时文件。
 *
 * 目录名一律用编号：任务目录与归档目录都按任务编号（归档本来就是按任务编号放的；任务目录平时也以编号为名，手工复制来的可以不同，
 * 清单文件里记着原来的目录名）。读不出任务编号的目录不进包，导出的结果里写原因。
 *
 * 导出不改原数据：任务库用数据库自带的备份办法取一份完整的副本（library.backupTaskDb），源库只读打开，所以正在使用的任务也可以导出，
 * 清单文件里记着导出时它是不是正被一个服务占着、助手是不是正在工作。别的文件照原样读出。
 *
 * 写包用 zip.ts 的流式写法，不把内容整个放进内存。不做 zip64：包超过 4 GB、文件超过 65534 个时拒绝并说明（PackError 的 too_large）。
 *
 * 导入（importPack）分两段。第一段核对整个包，有一处不对就整包不导入，目标数据目录原样不动：清单文件读得出来、版本不比这个程序新、
 * 包里的条目与文件清单一一对应、路径都落在该在的位置、每个文件解出来的 SHA-256 与清单文件记的相同。解出来的文件先放在暂存目录里
 * （任务根目录、归档根目录、知识库根目录下各一个 .importing-<时刻>-<随机数> 目录），修改时刻设回清单文件记的值。
 * 第二段一项一项进位，一项出错只影响它自己：知识库先做，任务后做；每一项从暂存目录改名到正式的位置（同一个文件系统上，一步完成），
 * 任务另记进登记表。做完删掉暂存目录，写一份报告。
 *
 * 编号相同怎么办：目标里已经有同编号的任务时缺省跳过；选了「改编号导入」就给它一个新编号（任务库经助手一侧的 renumberTask 改，
 * 任务目录与归档目录用新编号作名字）。知识库不改编号：库编号写在文档的文字版、分段清单、位置表与任务来源的出处里，改了它们就指错了库。
 * 目标里同编号的库是空的就导入到它的位置上（全新数据目录里的通用知识库就是这样带过去的），有文档就跳过。
 *
 * 归档里的会话文件第一行记着原来的任务目录，导入时不改（归档是证据，原样）：服务续接一条会话之前会核对这一行并改写
 * （pi_session.ts 的 rebaseSessionCwd），助手写任务库之前会核对库在本服务的任务根目录之下（schema.ts 的 checkUnderTasksRoot）。
 *
 * 本文件不直接碰数据库：读任务库经 library.ts，服务级库经 service_db.ts，改任务编号经助手一侧的 renumberTask。
 */

import { randomBytes } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import { TASK_ID_PATTERN } from "../../agent/src/lib/create_task.ts";
import { DB_NAME } from "../../agent/src/lib/db.ts";
// renumberTask 是后端里除建任务、数据升级之外唯一会改任务库的调用，只在这里（导入时改编号）用，改的是还在暂存目录里的副本。
import { renumberTask } from "../../agent/src/lib/renumber_task.ts";
import { TASKS_ROOT_ENV, TASK_DB_VERSION, newerDataText } from "../../agent/src/lib/schema.ts";
import * as clock from "./clock.ts";
import { GENERAL, KnowledgeStore, type LibraryRow, selectedLibraries } from "./knowledge.ts";
import * as library from "./library.ts";
import * as occupancy from "./occupancy.ts";
import { appVersion } from "./paths.ts";
import { UPLOADING_DIR, newTaskId } from "./service.ts";
import { DATA_FORMAT, ServiceDb, type TaskEntry, peekDataDirectory } from "./service_db.ts";
import { readTaskJson } from "./task_json.ts";
import { ZipError, type ZipEntry, ZipReader, ZipTooLarge, ZipWriter, validEntryName } from "./zip.ts";

/** 数据包文件名的结尾。 */
export const PACK_SUFFIX = ".taskwright.zip";
/** 包的格式版本：包里的布局与清单文件的写法。以后改了布局就加 1，旧程序据此拒绝读不了的包。 */
export const PACK_FORMAT = 1;
/** 清单文件在包里的名字。 */
export const MANIFEST_NAME = "manifest.json";
/** 包里知识库清单与任务登记两个文件的路径。 */
export const PACK_LIBRARIES = "knowledge/libraries.json";
export const PACK_REGISTER = "service/tasks.json";

/** 知识库编号的写法：通用知识库，或者 lib- 加十六进制数字。 */
export const LIBRARY_ID_PATTERN = /^(general|lib-[0-9a-f]{1,32})$/;

/** 数据目录里与数据包有关的几个位置。 */
export interface PackLocations {
  dataDir: string;
  tasksDir: string;
  runsDir: string;
  /** 知识库根目录；没有知识库时是 null。 */
  knowledgeDir: string | null;
}

/** 导出范围：整套（全部任务与知识库）、一个任务、一个知识库。 */
export type PackScope = "all" | "task" | "library";

/** 清单文件里的一个任务。 */
export interface PackTask {
  task_id: string;
  name: string | null;
  /** 属主；现在只有单机用户，是 local。 */
  owner: string;
  /** 导出时任务目录的名字（平时与编号相同）。 */
  dir: string;
  /** 任务库的格式版本。 */
  task_db_version: number;
  /** 导出时这个任务是不是正被一个活着的服务占着。 */
  in_use: boolean;
  /** 导出时助手是不是正在这个任务里工作（只有经服务的接口导出时才知道，命令行导出恒为假）。 */
  assistant_working: boolean;
  /** 包里属于这个任务的文件数（任务目录与归档合计）。 */
  files: number;
}

/** 清单文件里的一个知识库。 */
export interface PackLibrary {
  id: string;
  name: string;
  files: number;
}

/** 清单文件里的一个文件。 */
export interface PackFile {
  /** 在包里的路径（正斜杠分段）。 */
  path: string;
  bytes: number;
  sha256: string;
  /** 修改时刻（从 1970 年起的毫秒数）；导入之后设回去。 */
  mtime_ms: number;
}

export interface Manifest {
  pack_format: number;
  /** 导出它的产品版本。 */
  product_version: string;
  /** 数据目录的格式版本；导出时还没有服务级库（上一版留下的数据目录）是 0。 */
  data_format: number;
  /** 导出它的程序要的任务库格式版本；各任务库实际的版本记在各任务里。 */
  task_db_version: number;
  exported_at: string;
  scope: PackScope;
  tasks: PackTask[];
  libraries: PackLibrary[];
  files: PackFile[];
  /** 包里的空目录（包里只有文件的条目，空目录靠这里带着走）。 */
  empty_dirs: string[];
}

/** 导出或导入做不了：code 是 not_found（没有这个任务或知识库）、exists（目标文件已经在）、too_large（超过了包的上限）、refused（别的原因）。 */
export class PackError extends Error {
  readonly code: "not_found" | "exists" | "too_large" | "refused";
  constructor(code: PackError["code"], message: string) {
    super(message);
    this.code = code;
  }
}

/** 超过包的上限时的那句话。 */
export const PACK_TOO_LARGE_TEXT = "数据包不能超过 4 GB，里面的文件不能超过 65534 个，一个文件也不能超过 4 GB。请按任务、按知识库分开导出。";

/** 没有带进包的东西与原因（给人看的一句）。 */
export interface Skipped {
  what: string;
  reason: string;
}

export interface ExportResult {
  file: string;
  bytes: number;
  scope: PackScope;
  tasks: PackTask[];
  libraries: PackLibrary[];
  files: number;
  skipped: Skipped[];
}

export interface ExportOptions {
  scope: PackScope;
  /** 范围是一个任务时的任务编号、是一个知识库时的库编号。 */
  taskId?: string;
  libraryId?: string;
  /** 写到哪个文件；已经在时拒绝，不覆盖。 */
  to: string;
  /** 助手是不是正在这个任务里工作（服务的接口导出时给）。 */
  working?: (taskId: string) => boolean;
  productVersion?: string;
}

/** 本来就压缩过的文件类型与换算好的数字串：再压一遍省不下多少，原样存。 */
const STORED = new Set([".docx", ".xlsx", ".pptx", ".pdf", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".zip", ".gz", ".bin"]);

/** 任务目录第一层里不带进包的名字：任务库的三个文件（任务库另取完整的副本）、占用标记、上传到一半的暂存目录。 */
const TASK_LEFT_OUT = new Set([DB_NAME, `${DB_NAME}-wal`, `${DB_NAME}-shm`, occupancy.LOCK_NAME, UPLOADING_DIR]);

/** 导入时的暂存目录的名字开头（任务根目录、归档根目录、知识库根目录下）：导出不带，扫描任务时也不认。 */
export const IMPORTING_PREFIX = ".importing-";

interface Found {
  /** 相对起点目录的路径，正斜杠分段。 */
  rel: string;
  path: string;
  bytes: number;
  mtimeMs: number;
}

/**
 * 一个目录下的全部普通文件与空目录（递归，按名字排）。临时文件（.tmp 结尾）不要；不是普通文件也不是目录的（符号链接等）不要，
 * 记进 skipped。leftOut 是第一层里不要的名字。目录不存在时什么都没有。
 */
function walk(root: string, leftOut: ReadonlySet<string>, label: string, skipped: Skipped[]): { files: Found[]; emptyDirs: string[] } {
  const files: Found[] = [];
  const emptyDirs: string[] = [];
  const visit = (dir: string, rel: string): number => {
    let names: string[];
    try {
      names = readdirSync(dir).sort(library.byCodePoint);
    } catch {
      return 0;
    }
    let kept = 0;
    for (const name of names) {
      if (rel === "" && leftOut.has(name)) continue;
      if (name.endsWith(".tmp")) continue;
      const path = join(dir, name);
      const inPack = rel ? `${rel}/${name}` : name;
      const st = lstatSync(path);
      if (st.isDirectory()) {
        if (visit(path, inPack) === 0) emptyDirs.push(inPack);
        kept += 1;
      } else if (st.isFile()) {
        files.push({ rel: inPack, path, bytes: st.size, mtimeMs: Math.floor(st.mtimeMs) });
        kept += 1;
      } else {
        skipped.push({ what: `${label}/${inPack}`, reason: "不是普通文件（例如符号链接），没有带" });
      }
    }
    return kept;
  };
  visit(root, "");
  return { files, emptyDirs };
}

/** 任务库里任务的那一行里登记表要的几项；读不出来是 null。 */
function taskRow(taskDir: string): { task_id: string; name: string | null; status: string | null; task_type: string | null; created_at: string | null } | null {
  const db = library.openRo(taskDir);
  try {
    const row = db ? (db.prepare("SELECT task_id, task_name, status, definition_path, started_at FROM task LIMIT 1").get() as Record<string, any> | undefined) : undefined;
    if (!row || typeof row.task_id !== "string") return null;
    return {
      task_id: row.task_id, name: row.task_name || null, status: row.status ?? null,
      task_type: typeof row.definition_path === "string" ? basename(row.definition_path).replace(/\.json$/i, "") : null, created_at: row.started_at ?? null,
    };
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

/** 任务根目录下的任务：目录名与任务库里的那一行。暂存目录与别的以点开头的目录不看；没有任务库的目录不是任务。 */
export function tasksIn(tasksDir: string): { dir: string; row: ReturnType<typeof taskRow> }[] {
  let names: string[] = [];
  try {
    names = readdirSync(tasksDir).sort(library.byCodePoint);
  } catch {
    return [];
  }
  const out: { dir: string; row: ReturnType<typeof taskRow> }[] = [];
  for (const dir of names) {
    if (dir.startsWith(".")) continue;
    try {
      if (!statSync(join(tasksDir, dir, DB_NAME)).isFile()) continue;
    } catch {
      continue;
    }
    out.push({ dir, row: taskRow(join(tasksDir, dir)) });
  }
  return out;
}

/** 知识库清单里的条目；没有知识库、清单不在或者读不出来时是空的。只读，不建任何东西。 */
function librariesIn(knowledgeDir: string | null): LibraryRow[] {
  if (!knowledgeDir) return [];
  try {
    return new KnowledgeStore(knowledgeDir).libraries();
  } catch {
    return [];
  }
}

/**
 * 导出一个数据包。范围是一个任务或一个知识库而它不在时抛 PackError（not_found）；目标文件已经在时抛 exists；
 * 超过包的上限时抛 too_large。出错时不留下写了一半的文件。
 */
export async function exportPack(where: PackLocations, options: ExportOptions): Promise<ExportResult> {
  const skipped: Skipped[] = [];
  // 要带的任务。
  const chosen: { dir: string; row: NonNullable<ReturnType<typeof taskRow>> }[] = [];
  if (options.scope !== "library") {
    const seen = new Set<string>();
    for (const one of tasksIn(where.tasksDir)) {
      if (!one.row) {
        if (options.scope === "all") skipped.push({ what: `任务目录 ${one.dir}`, reason: "读不出任务编号，没有带" });
        continue;
      }
      if (options.scope === "task" && one.row.task_id !== options.taskId) continue;
      if (!TASK_ID_PATTERN.test(one.row.task_id)) {
        skipped.push({ what: `任务目录 ${one.dir}`, reason: `任务编号「${one.row.task_id}」的写法不是现在的写法，没有带` });
        continue;
      }
      if (seen.has(one.row.task_id)) {
        skipped.push({ what: `任务目录 ${one.dir}`, reason: `与前面的任务目录是同一个任务编号 ${one.row.task_id}，没有带` });
        continue;
      }
      seen.add(one.row.task_id);
      chosen.push({ dir: one.dir, row: one.row });
    }
    if (options.scope === "task" && chosen.length === 0) throw new PackError("not_found", `没有任务 ${options.taskId ?? ""}。`);
  }
  // 要带的知识库。
  const libraries: LibraryRow[] = [];
  if (options.scope !== "task") {
    for (const row of librariesIn(where.knowledgeDir)) {
      if (options.scope === "library" && row.id !== options.libraryId) continue;
      if (!LIBRARY_ID_PATTERN.test(row.id)) {
        skipped.push({ what: `知识库 ${row.id}`, reason: "编号的写法不是现在的写法，没有带" });
        continue;
      }
      libraries.push(row);
    }
    if (options.scope === "library" && libraries.length === 0) throw new PackError("not_found", `没有这个知识库：${options.libraryId ?? ""}。`);
  }

  if (existsSync(options.to)) throw new PackError("exists", `文件 ${options.to} 已经在了，没有覆盖它。请换一个文件名。`);
  // 先写到旁边的临时文件，全部写完再改成正式的名字。
  const partial = `${options.to}.${process.pid}.tmp`;
  rmSync(partial, { force: true });
  const scratch = mkdtempSync(join(tmpdir(), "taskwright-pack-"));
  const writer = ZipWriter.create(partial);
  const manifest: Manifest = {
    pack_format: PACK_FORMAT, product_version: options.productVersion ?? appVersion(), data_format: peekData(where.dataDir), task_db_version: TASK_DB_VERSION,
    exported_at: clock.now(), scope: options.scope, tasks: [], libraries: [], files: [], empty_dirs: [],
  };
  const put = async (path: string, source: string, mtimeMs: number) => {
    const written = await writer.addFile(path, source, { store: STORED.has(extname(path).toLowerCase()), mtime: new Date(mtimeMs) });
    manifest.files.push({ path, bytes: written.bytes, sha256: written.sha256, mtime_ms: mtimeMs });
  };
  const putJson = async (path: string, value: unknown) => {
    const now = Date.now();
    const written = await writer.addBuffer(path, Buffer.from(JSON.stringify(value, null, 2) + "\n", "utf-8"), { mtime: new Date(now) });
    manifest.files.push({ path, bytes: written.bytes, sha256: written.sha256, mtime_ms: now });
  };
  try {
    const register: TaskEntry[] = [];
    const registry = readRegistry(where.dataDir);
    try {
      for (const { dir, row } of chosen) {
        const taskDir = join(where.tasksDir, dir);
        const id = row.task_id;
        const before = manifest.files.length;
        // 任务库：取一份完整的副本再装进包。
        const copy = join(scratch, DB_NAME);
        rmSync(copy, { force: true });
        await library.backupTaskDb(taskDir, copy);
        await put(`tasks/${id}/${DB_NAME}`, copy, Math.floor(statSync(join(taskDir, DB_NAME)).mtimeMs));
        rmSync(copy, { force: true });
        const own = walk(taskDir, TASK_LEFT_OUT, `任务 ${id}`, skipped);
        for (const file of own.files) await put(`tasks/${id}/${file.rel}`, file.path, file.mtimeMs);
        manifest.empty_dirs.push(...own.emptyDirs.map((one) => `tasks/${id}/${one}`));
        const archive = walk(join(where.runsDir, id), new Set(), `任务 ${id} 的归档`, skipped);
        for (const file of archive.files) await put(`runs/${id}/${file.rel}`, file.path, file.mtimeMs);
        manifest.empty_dirs.push(...archive.emptyDirs.map((one) => `runs/${id}/${one}`));
        const lock = occupancy.readLock(taskDir);
        const owner = readTaskJson(taskDir)?.owner ?? "local";
        manifest.tasks.push({
          task_id: id, name: row.name, owner, dir, task_db_version: library.taskDbVersion(taskDir) ?? 0,
          in_use: occupancy.isOurs(lock) || occupancy.occupiedByOther(lock), assistant_working: options.working?.(id) ?? false,
          files: manifest.files.length - before,
        });
        // 登记表里的那一行：有登记就照登记的（属主以它为准），没有就照任务库现在的样子拼一行。目录一律记成编号。
        const listed = registry?.task(id) ?? null;
        register.push({
          task_id: id, name: listed?.name ?? row.name, owner: listed?.owner ?? owner, status: listed?.status ?? row.status,
          task_type: listed?.task_type ?? row.task_type, created_at: listed?.created_at ?? row.created_at, dir: id,
        });
      }
    } finally {
      registry?.close();
    }
    for (const row of libraries) {
      const before = manifest.files.length;
      const found = walk(join(where.knowledgeDir!, row.id), new Set(), `知识库 ${row.id}`, skipped);
      for (const file of found.files) await put(`knowledge/${row.id}/${file.rel}`, file.path, file.mtimeMs);
      manifest.empty_dirs.push(...found.emptyDirs.map((one) => `knowledge/${row.id}/${one}`));
      manifest.libraries.push({ id: row.id, name: row.name, files: manifest.files.length - before });
    }
    if (libraries.length > 0) await putJson(PACK_LIBRARIES, { version: 1, libraries });
    if (register.length > 0) await putJson(PACK_REGISTER, { version: 1, tasks: register });
    await writer.addBuffer(MANIFEST_NAME, Buffer.from(JSON.stringify(manifest, null, 2) + "\n", "utf-8"));
    const bytes = writer.finish();
    renameSync(partial, options.to);
    return { file: options.to, bytes, scope: options.scope, tasks: manifest.tasks, libraries: manifest.libraries, files: manifest.files.length, skipped };
  } catch (error) {
    writer.close();
    rmSync(partial, { force: true });
    if (error instanceof ZipTooLarge) throw new PackError("too_large", PACK_TOO_LARGE_TEXT);
    throw error;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** 数据目录的格式版本；还没有服务级库，或者读不出来，是 0。 */
function peekData(dataDir: string): number {
  try {
    return peekDataDirectory(dataDir)?.data_format ?? 0;
  } catch {
    return 0;
  }
}

/** 只读打开数据目录的登记表；没有服务级库或者打不开是 null。 */
function readRegistry(dataDir: string): ServiceDb | null {
  try {
    return ServiceDb.read(dataDir);
  } catch {
    return null;
  }
}

const sizeText = (bytes: number) => (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : bytes >= 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${bytes} 字节`);

/** 导出的结果写成给人看的几行（命令行打印的就是它）。 */
export function exportText(result: ExportResult): string {
  const lines = [`数据包已经写好：${result.file}（${result.files} 个文件，${sizeText(result.bytes)}）`];
  for (const task of result.tasks) {
    const using = task.assistant_working ? "；导出时助手正在这个任务里工作" : task.in_use ? "；导出时这个任务正在使用" : "";
    lines.push(`任务 ${task.task_id}${task.name ? `「${task.name}」` : ""}：${task.files} 个文件${using}`);
  }
  for (const one of result.libraries) lines.push(`知识库 ${one.id}「${one.name}」：${one.files} 个文件`);
  if (result.tasks.length === 0 && result.libraries.length === 0) lines.push("这个数据目录里没有任务，也没有知识库：包里只有清单文件。");
  for (const one of result.skipped) lines.push(`没有带：${one.what}（${one.reason}）`);
  lines.push("包里有材料与对话记录的副本，请妥善保管。产品设置、模型配置与密钥不在包里。");
  return lines.join("\n") + "\n";
}

// ───────────── 导入 ─────────────

const isObject = (value: unknown): value is Record<string, any> => value !== null && typeof value === "object" && !Array.isArray(value);
const isCount = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 0;

/** 把清单文件读成对象并核对它的样子与里面的编号；不对时抛 PackError（refused）。版本在 openPack 里另看。 */
function parseManifest(text: string): Manifest {
  const bad = (why: string) => new PackError("refused", `数据包的清单文件不对：${why}。`);
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new PackError("refused", "数据包的清单文件读不出来。");
  }
  if (!isObject(raw)) throw bad("不是一个对象");
  if (!isCount(raw.pack_format) || !isCount(raw.data_format) || !isCount(raw.task_db_version)) throw bad("没有写格式版本");
  if (raw.scope !== "all" && raw.scope !== "task" && raw.scope !== "library") throw bad("没有写导出范围");
  if (!Array.isArray(raw.tasks) || !Array.isArray(raw.libraries) || !Array.isArray(raw.files)) throw bad("没有任务、知识库或文件的清单");
  const tasks: PackTask[] = raw.tasks.map((one: unknown) => {
    if (!isObject(one) || typeof one.task_id !== "string" || !TASK_ID_PATTERN.test(one.task_id) || !isCount(one.task_db_version)) throw bad("任务清单里有一项写得不对");
    return {
      task_id: one.task_id, name: typeof one.name === "string" && one.name ? one.name : null, owner: typeof one.owner === "string" && one.owner ? one.owner : "local",
      dir: typeof one.dir === "string" ? one.dir : one.task_id, task_db_version: one.task_db_version, in_use: one.in_use === true,
      assistant_working: one.assistant_working === true, files: isCount(one.files) ? one.files : 0,
    };
  });
  const libraries: PackLibrary[] = raw.libraries.map((one: unknown) => {
    if (!isObject(one) || typeof one.id !== "string" || !LIBRARY_ID_PATTERN.test(one.id)) throw bad("知识库清单里有一项写得不对");
    return { id: one.id, name: typeof one.name === "string" && one.name ? one.name : one.id, files: isCount(one.files) ? one.files : 0 };
  });
  const files: PackFile[] = raw.files.map((one: unknown) => {
    if (!isObject(one) || typeof one.path !== "string" || !isCount(one.bytes) || typeof one.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(one.sha256)) throw bad("文件清单里有一项写得不对");
    return { path: one.path, bytes: one.bytes, sha256: one.sha256, mtime_ms: typeof one.mtime_ms === "number" && Number.isFinite(one.mtime_ms) && one.mtime_ms >= 0 ? one.mtime_ms : 0 };
  });
  const emptyDirs = Array.isArray(raw.empty_dirs) ? raw.empty_dirs.filter((one: unknown): one is string => typeof one === "string") : [];
  for (const [what, ids] of [["任务", tasks.map((t) => t.task_id)], ["知识库", libraries.map((x) => x.id)], ["文件", files.map((f) => f.path)]] as const) {
    if (new Set(ids).size !== ids.length) throw bad(`${what}清单里有重复的`);
  }
  return {
    pack_format: raw.pack_format, product_version: typeof raw.product_version === "string" && raw.product_version ? raw.product_version : "unknown",
    data_format: raw.data_format, task_db_version: raw.task_db_version, exported_at: typeof raw.exported_at === "string" ? raw.exported_at : "",
    scope: raw.scope, tasks, libraries, files, empty_dirs: emptyDirs,
  };
}

/** 包里的一个路径落在哪里：某个任务的目录、某个任务的归档、某个知识库的目录，或者两个固定的文件。都不是就是 null（不该有的路径）。 */
function placeOf(path: string, manifest: Manifest): "task" | "archive" | "library" | "fixed" | null {
  if (!validEntryName(path) || /[\0-\x1f:]/.test(path)) return null;
  if (path === PACK_LIBRARIES || path === PACK_REGISTER) return "fixed";
  const parts = path.split("/");
  if (parts.length < 3) return null;
  if (parts[0] === "tasks" && manifest.tasks.some((t) => t.task_id === parts[1])) return "task";
  if (parts[0] === "runs" && manifest.tasks.some((t) => t.task_id === parts[1])) return "archive";
  if (parts[0] === "knowledge" && manifest.libraries.some((x) => x.id === parts[1])) return "library";
  return null;
}

/** 一个打开着的数据包：读它的条目用 reader，用完要 close。 */
export interface OpenedPack {
  reader: ZipReader;
  manifest: Manifest;
}

/**
 * 打开一个数据包并核对它整体对不对（还不解任何文件）：是 zip、有清单文件、版本不比这个程序新、路径都落在该在的位置、
 * 包里的条目与文件清单一一对应而且长度相同。有一处不对抛 PackError（refused），话里写明原因。
 */
export function openPack(file: string): OpenedPack {
  let reader: ZipReader;
  try {
    reader = ZipReader.open(file);
  } catch (error) {
    if (error instanceof ZipError) throw new PackError("refused", `这个文件不是数据包，或者已经损坏：${error.message}。`);
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new PackError("not_found", `没有这个文件：${file}。`);
    throw error;
  }
  try {
    const entry = reader.entry(MANIFEST_NAME);
    if (!entry) throw new PackError("refused", "这个 zip 文件里没有清单文件，不是数据包。");
    let text: string;
    try {
      text = reader.read(entry).toString("utf-8");
    } catch (error) {
      if (error instanceof ZipError) throw new PackError("refused", `数据包的清单文件读不出来：${error.message}。`);
      throw error;
    }
    const manifest = parseManifest(text);
    if (manifest.pack_format > PACK_FORMAT || manifest.data_format > DATA_FORMAT || manifest.tasks.some((t) => t.task_db_version > TASK_DB_VERSION)) {
      throw new PackError("refused", `这个数据包比这个程序新。${newerDataText(manifest.product_version === "unknown" ? null : manifest.product_version)}`);
    }
    for (const path of [...manifest.files.map((f) => f.path), ...manifest.empty_dirs]) {
      if (placeOf(path, manifest) === null) throw new PackError("refused", `数据包里有不该有的路径：${path}。`);
    }
    const listed = new Map(manifest.files.map((f) => [f.path, f]));
    for (const one of reader.entries) {
      if (one.name === MANIFEST_NAME) continue;
      const wanted = listed.get(one.name);
      // 清单文件里没有的条目；同一个名字出现第二次的条目也落在这里（第一次已经从 listed 里去掉了）。
      if (!wanted) throw new PackError("refused", `数据包里的文件与清单文件对不上：多了 ${one.name}。`);
      if (wanted.bytes !== one.size) throw new PackError("refused", `数据包里的文件与清单文件对不上：${one.name} 的长度不同。`);
      listed.delete(one.name);
    }
    if (listed.size > 0) throw new PackError("refused", `数据包里的文件与清单文件对不上：少了 ${[...listed.keys()][0]}。`);
    return { reader, manifest };
  } catch (error) {
    reader.close();
    throw error;
  }
}

/** 导入时的暂存位置：包里各部分先解到这里，再改名进位。 */
interface Staging {
  /** 暂存的任务目录的上级（里面每个任务一个以编号为名的目录）。 */
  tasks: string;
  /** 暂存的归档目录的上级。 */
  runs: string;
  /** 暂存的知识库目录的上级（里面还有包里的知识库清单 libraries.json）。 */
  knowledge: string;
  /** 包里任务登记表那个文件解出来的位置。 */
  register: string;
  /** 做完要删的几个目录。 */
  roots: string[];
}

const pad = (n: number) => String(n).padStart(2, "0");
const stamp = (at: Date) => `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}-${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}`;

/** 一个新的暂存目录名：.importing-<年月日-时分秒>-<随机数>。 */
export function importingName(at: Date = new Date()): string {
  return `${IMPORTING_PREFIX}${stamp(at)}-${randomBytes(3).toString("hex")}`;
}

/** 在三个根目录下各定一个暂存目录（没有知识库根目录时知识库的部分放在任务的暂存目录里）。 */
function stagingIn(where: PackLocations, name: string): Staging {
  const tasksRoot = join(where.tasksDir, name);
  const runsRoot = join(where.runsDir, name);
  const knowledgeRoot = where.knowledgeDir ? join(where.knowledgeDir, name) : join(tasksRoot, "knowledge");
  return { tasks: join(tasksRoot, "tasks"), runs: runsRoot, knowledge: knowledgeRoot, register: join(tasksRoot, "service", "tasks.json"), roots: [tasksRoot, runsRoot, knowledgeRoot] };
}

/** 包里的一个路径解到暂存位置的哪里。 */
function stagedPath(staging: Staging, path: string): string {
  if (path === PACK_REGISTER) return staging.register;
  const [head, ...rest] = path.split("/");
  return join(head === "tasks" ? staging.tasks : head === "runs" ? staging.runs : staging.knowledge, ...rest);
}

/**
 * 把包里的每个文件解到暂存位置，核对 SHA-256，修改时刻设回清单文件记的值，再建出空目录。
 * 有一个文件解不出来或者校验值不符就抛 PackError（refused）；这时暂存位置里的东西由调用方删。
 */
async function extractPack(pack: OpenedPack, staging: Staging): Promise<void> {
  const entries = new Map<string, ZipEntry>(pack.reader.entries.map((one) => [one.name, one]));
  for (const file of pack.manifest.files) {
    const target = stagedPath(staging, file.path);
    let written;
    try {
      written = await pack.reader.extract(entries.get(file.path)!, target);
    } catch (error) {
      if (error instanceof ZipError) throw new PackError("refused", `数据包损坏了：${error.message}。整个包没有导入。`);
      throw error;
    }
    if (written.sha256 !== file.sha256) throw new PackError("refused", `数据包里的文件 ${file.path} 与清单文件记的校验值不符。整个包没有导入。`);
    if (file.mtime_ms > 0) utimesSync(target, file.mtime_ms / 1000, file.mtime_ms / 1000);
  }
  for (const dir of pack.manifest.empty_dirs) mkdirSync(stagedPath(staging, dir), { recursive: true });
}

/** 报告里一个任务的一行。 */
export interface ImportedTask {
  /** 包里的任务编号。 */
  task_id: string;
  name: string | null;
  /** imported 导入了；skipped 因为编号已经有任务在用而跳过；failed 没有导入成。 */
  outcome: "imported" | "skipped" | "failed";
  /** 改了编号时的新编号；没有改是 null。 */
  new_id: string | null;
  /** 跳过或没有做成的原因。 */
  reason: string | null;
  /** 另外要告诉用户的话（例如它选用的知识库不在这个数据目录里）。 */
  notes: string[];
}

/** 报告里一个知识库的一行。 */
export interface ImportedLibrary {
  id: string;
  name: string;
  outcome: "imported" | "skipped" | "failed";
  /** 因为重名而改了名字时的新名字；没有改是 null。 */
  new_name: string | null;
  reason: string | null;
}

export interface ImportReport {
  product_version: string;
  started_at: string;
  finished_at: string;
  data_dir: string;
  /** 数据包文件，以及从清单文件读出的几项；包打不开时这几项是 null。 */
  pack: { file: string; scope: PackScope | null; product_version: string | null; exported_at: string | null };
  tasks: ImportedTask[];
  libraries: ImportedLibrary[];
  /** 整个包没有导入的原因（打不开、比这个程序新、文件与清单文件对不上、校验值不符）：这时数据目录原样没动。导入了是 null。 */
  fatal: string | null;
  /** 这份报告写在哪个文件里；没有写成时是 null。 */
  file: string | null;
}

export interface ImportOptions {
  /** 数据包文件。 */
  file: string;
  /** 目标里已经有同编号的任务时：skip 跳过（缺省），renumber 改成新编号导入。对知识库不起作用。 */
  onConflict?: "skip" | "renumber";
  /** 只接受这个范围的包（服务的接口只收单个任务、单个知识库的包）；不给时都接受。 */
  only?: "task" | "library";
  /** 任务登记表；给了就把导入的任务记进去。由调用方打开与关闭。 */
  registry?: ServiceDb | null;
  productVersion?: string;
  now?: () => Date;
}

/** 范围的叫法。 */
const SCOPE_NAMES: Record<PackScope, string> = { all: "整套", task: "一个任务", library: "一个知识库" };

/** 暂存目录里登记表那个文件里的行，按任务编号取；读不出来是空的。 */
function stagedRegister(staging: Staging): Map<string, Record<string, any>> {
  try {
    const raw = JSON.parse(readFileSync(staging.register, "utf-8"));
    return new Map((Array.isArray(raw?.tasks) ? raw.tasks : []).filter((row: unknown) => isObject(row) && typeof row.task_id === "string").map((row: Record<string, any>) => [row.task_id, row]));
  } catch {
    return new Map();
  }
}

/** 暂存目录里知识库清单那个文件里的条目，按库编号取。 */
function stagedLibraries(staging: Staging): Map<string, LibraryRow> {
  try {
    const raw = JSON.parse(readFileSync(join(staging.knowledge, "libraries.json"), "utf-8"));
    return new Map((Array.isArray(raw?.libraries) ? raw.libraries : []).filter((row: unknown) => isObject(row) && typeof row.id === "string").map((row: LibraryRow) => [row.id, row]));
  } catch {
    return new Map();
  }
}

/** 暂存的一个库的文档清单里有几份文档。 */
function stagedDocumentCount(staging: Staging, id: string): number {
  try {
    const raw = JSON.parse(readFileSync(join(staging.knowledge, id, "documents.json"), "utf-8"));
    return Array.isArray(raw?.documents) ? raw.documents.length : 0;
  } catch {
    return 0;
  }
}

/** 导入一个知识库（不改编号）：目标里没有同编号的就放进去；有而是空的，放到它的位置上；有而有文档，跳过。 */
function importLibrary(where: PackLocations, staging: Staging, one: PackLibrary, rows: Map<string, LibraryRow>): ImportedLibrary {
  const out: ImportedLibrary = { id: one.id, name: one.name, outcome: "failed", new_name: null, reason: null };
  if (!where.knowledgeDir) return { ...out, reason: "这个数据目录没有知识库" };
  const store = new KnowledgeStore(where.knowledgeDir);
  const target = join(where.knowledgeDir, one.id);
  let moved = false;
  try {
    // 目标数据目录还没有知识库的清单（全新的数据目录）：先建出来，通用知识库随之建出。
    if (!existsSync(join(where.knowledgeDir, "libraries.json"))) store.ensure();
    if ((store.has(one.id) || existsSync(target)) && !store.isEmpty(one.id)) {
      const count = stagedDocumentCount(staging, one.id);
      const reason = one.id === GENERAL
        ? `通用知识库已经存在而且里面有文档，包里通用知识库的 ${count} 份文档没有导入；需要的话请在知识库页面把这些文档另行上传`
        : `已经有编号是 ${one.id} 的知识库而且里面有文档，包里这个库的 ${count} 份文档没有导入`;
      return { ...out, outcome: "skipped", reason };
    }
    const staged = join(staging.knowledge, one.id);
    if (existsSync(staged)) {
      // 原来那个同编号的库是空的：它的空目录让位。
      rmSync(target, { recursive: true, force: true });
      renameSync(staged, target);
      moved = true;
    }
    const row = rows.get(one.id);
    const adopted = store.adopt({ id: one.id, name: row?.name ?? one.name, created_at: typeof row?.created_at === "string" ? row.created_at : clock.now() });
    return { ...out, outcome: "imported", new_name: one.id !== GENERAL && adopted.name !== (row?.name ?? one.name) ? adopted.name : null };
  } catch (error) {
    if (moved) rmSync(target, { recursive: true, force: true });
    return { ...out, reason: (error as Error).message };
  }
}

/** 导入一个任务：判编号有没有被占，需要时改编号，归档与任务目录改名进位，记进登记表。 */
function importTask(where: PackLocations, staging: Staging, one: PackTask, options: ImportOptions, register: Map<string, Record<string, any>>): ImportedTask {
  const out: ImportedTask = { task_id: one.task_id, name: one.name, outcome: "failed", new_id: null, reason: null, notes: [] };
  let staged = join(staging.tasks, one.task_id);
  let stagedRuns = join(staging.runs, one.task_id);
  const placed: string[] = [];
  try {
    const row = taskRow(staged);
    if (!row || row.task_id !== one.task_id) return { ...out, reason: "数据包里这个任务的任务库与清单文件对不上" };
    const version = library.taskDbVersion(staged);
    if (version === null || version > TASK_DB_VERSION) return { ...out, reason: newerDataText(readTaskJson(staged)?.upgraded_by_version ?? null) };
    if (version < TASK_DB_VERSION) return { ...out, reason: "这个任务的数据是上一版的格式，还没有升级" };
    // 这个编号在目标里有没有被占：有同名的任务目录或归档目录，或者有任务库里编号相同的任务。
    const used = new Set(tasksIn(where.tasksDir).map((t) => t.row?.task_id).filter((id): id is string => typeof id === "string"));
    const taken = (id: string) => used.has(id) || existsSync(join(where.tasksDir, id)) || existsSync(join(where.runsDir, id));
    let id = one.task_id;
    if (taken(id)) {
      if (options.onConflict !== "renumber") return { ...out, outcome: "skipped", reason: `已经有编号是 ${id} 的任务；要让两个任务并存，请用「改编号导入」` };
      do id = newTaskId(); while (taken(id) || existsSync(join(staging.tasks, id)));
      // 助手一侧写任务库之前要核对它在任务根目录之下：这一次的任务根目录是暂存的那个。
      const before = process.env[TASKS_ROOT_ENV];
      process.env[TASKS_ROOT_ENV] = staging.tasks;
      try {
        renumberTask(staged, id);
      } finally {
        if (before === undefined) delete process.env[TASKS_ROOT_ENV];
        else process.env[TASKS_ROOT_ENV] = before;
      }
      renameSync(staged, join(staging.tasks, id));
      staged = join(staging.tasks, id);
      if (existsSync(stagedRuns)) {
        renameSync(stagedRuns, join(staging.runs, id));
        stagedRuns = join(staging.runs, id);
      }
      out.new_id = id;
    }
    // 归档先进位，任务目录后进位：服务是按任务目录认任务的，它看到这个任务时归档已经在了。
    if (existsSync(stagedRuns)) {
      mkdirSync(where.runsDir, { recursive: true });
      renameSync(stagedRuns, join(where.runsDir, id));
      placed.push(join(where.runsDir, id));
    }
    const target = join(where.tasksDir, id);
    renameSync(staged, target);
    placed.push(target);
    const listed = register.get(one.task_id);
    const text = (value: unknown) => (typeof value === "string" && value ? value : null);
    options.registry?.putTask({
      task_id: id, name: row.name, owner: text(listed?.owner) ?? readTaskJson(target)?.owner ?? one.owner, status: row.status,
      task_type: row.task_type ?? text(listed?.task_type), created_at: row.created_at ?? text(listed?.created_at), dir: id,
    });
    // 它选用的知识库在这个数据目录里有没有。
    const known = new Set(librariesIn(where.knowledgeDir).map((x) => x.id));
    for (const lib of selectedLibraries(target)) {
      if (lib !== GENERAL && !known.has(lib)) out.notes.push(`这个任务选用的知识库 ${lib} 不在这个数据目录里。`);
    }
    return { ...out, outcome: "imported" };
  } catch (error) {
    // 已经进位的那一半撤回。
    for (const dir of placed) rmSync(dir, { recursive: true, force: true });
    return { ...out, new_id: null, reason: (error as Error).message };
  }
}

/**
 * 把一个数据包导入到 where 这个数据目录。返回报告：整个包没有导入时 fatal 写着原因，数据目录原样没动；
 * 否则任务与知识库各有一行，写着导入了、跳过了还是没有做成。报告另写一份到数据目录的 logs/ 下。
 * 调用方负责保证这时没有别的服务在用这个数据目录（命令行），或者自己就是那个服务（接口）。
 */
export async function importPack(where: PackLocations, options: ImportOptions): Promise<ImportReport> {
  const now = options.now ?? (() => new Date());
  const started = now();
  const report: ImportReport = {
    product_version: options.productVersion ?? appVersion(), started_at: clock.now(), finished_at: "", data_dir: where.dataDir,
    pack: { file: options.file, scope: null, product_version: null, exported_at: null }, tasks: [], libraries: [], fatal: null, file: null,
  };
  let pack: OpenedPack | null = null;
  let staging: Staging | null = null;
  try {
    pack = openPack(options.file);
    const manifest = pack.manifest;
    report.pack = { file: options.file, scope: manifest.scope, product_version: manifest.product_version, exported_at: manifest.exported_at || null };
    if (options.only && manifest.scope !== options.only) {
      throw new PackError("refused", `这里只能导入范围是${SCOPE_NAMES[options.only]}的数据包，这个包的范围是${SCOPE_NAMES[manifest.scope]}。范围是整套的包请用命令行导入。`);
    }
    staging = stagingIn(where, importingName(started));
    for (const root of staging.roots) mkdirSync(root, { recursive: true });
    await extractPack(pack, staging);
    pack.reader.close();
    pack = null;
    // 知识库先做，任务后做（任务的说明里要写它选用的库在不在）。
    const rows = stagedLibraries(staging);
    for (const one of manifest.libraries) report.libraries.push(importLibrary(where, staging, one, rows));
    const register = stagedRegister(staging);
    for (const one of manifest.tasks) report.tasks.push(importTask(where, staging, one, options, register));
  } catch (error) {
    if (!(error instanceof PackError)) throw error;
    report.fatal = error.message;
  } finally {
    pack?.reader.close();
    for (const root of staging?.roots ?? []) rmSync(root, { recursive: true, force: true });
  }
  report.finished_at = clock.now();
  try {
    const dir = join(where.dataDir, "logs");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `import-${stamp(started)}.txt`);
    report.file = file;
    writeFileSync(file, importText(report), "utf-8");
  } catch {
    report.file = null;
  }
  return report;
}

/** 导入的报告写成给人看的一段文字：命令行打印的、接口回的、写进文件的都是它。 */
export function importText(report: ImportReport): string {
  const lines = [`数据包导入报告（${report.product_version}）`, `数据目录：${report.data_dir}`];
  const from = report.pack.scope ? `（由 ${report.pack.product_version} 导出${report.pack.exported_at ? `于 ${report.pack.exported_at}` : ""}，范围：${SCOPE_NAMES[report.pack.scope]}）` : "";
  lines.push(`数据包：${report.pack.file}${from}`, `开始：${report.started_at}　结束：${report.finished_at}`);
  if (report.fatal) {
    lines.push(`没有导入：${report.fatal}`);
    return lines.join("\n") + "\n";
  }
  const label = (id: string, name: string | null) => `${id}${name ? `「${name}」` : ""}`;
  for (const one of report.libraries) {
    const head = `知识库 ${label(one.id, one.name)}`;
    if (one.outcome === "imported") lines.push(`${head}：已导入${one.new_name ? `，名字与已有的知识库相同，改成了「${one.new_name}」` : ""}`);
    else lines.push(`${head}：${one.outcome === "skipped" ? "没有导入" : "没有导入成"}（${one.reason}）`);
  }
  for (const one of report.tasks) {
    const head = `任务 ${label(one.task_id, one.name)}`;
    if (one.outcome === "imported") lines.push(`${head}：已导入${one.new_id ? `，编号改成了 ${one.new_id}（原来的编号已经有任务在用）` : ""}`);
    else lines.push(`${head}：${one.outcome === "skipped" ? "没有导入" : "没有导入成"}（${one.reason}）`);
    for (const note of one.notes) lines.push(`  ${note}`);
  }
  const all = [...report.tasks, ...report.libraries];
  const count = (outcome: string) => all.filter((one) => one.outcome === outcome).length;
  const done = (items: { outcome: string }[]) => items.filter((one) => one.outcome === "imported").length;
  lines.push(`合计：导入了 ${done(report.tasks)} 个任务、${done(report.libraries)} 个知识库；因为已经存在而跳过 ${count("skipped")} 项；没有做成 ${count("failed")} 项。`);
  if (report.libraries.length > 0) lines.push("知识库不改编号：编号已经存在而且里面有文档的知识库不会导入，「改编号导入」只对任务起作用。");
  return lines.join("\n") + "\n";
}

/**
 * 清掉上一次导入没有做完留下的暂存目录（服务被强行停掉时会留下）：任务根目录、归档根目录、知识库根目录下名字以 .importing- 开头的目录。
 * 只在服务启动时调；别的名字一概不碰。返回清掉的目录。
 */
export function sweepImportLeftovers(where: PackLocations): string[] {
  const removed: string[] = [];
  for (const root of [where.tasksDir, where.runsDir, where.knowledgeDir]) {
    if (!root) continue;
    let names: string[] = [];
    try {
      names = readdirSync(root);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.startsWith(IMPORTING_PREFIX)) continue;
      const path = join(root, name);
      try {
        if (!lstatSync(path).isDirectory()) continue;
        rmSync(path, { recursive: true, force: true });
        removed.push(path);
      } catch {
        // 清不掉就留着，不让服务因此起不来
      }
    }
  }
  return removed;
}
