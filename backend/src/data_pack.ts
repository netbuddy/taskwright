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
 * 本文件不直接碰数据库：读任务库经 library.ts，服务级库经 service_db.ts。
 */

import { existsSync, lstatSync, mkdtempSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import { TASK_ID_PATTERN } from "../../agent/src/lib/create_task.ts";
import { DB_NAME } from "../../agent/src/lib/db.ts";
import { TASK_DB_VERSION } from "../../agent/src/lib/schema.ts";
import * as clock from "./clock.ts";
import { KnowledgeStore, type LibraryRow } from "./knowledge.ts";
import * as library from "./library.ts";
import * as occupancy from "./occupancy.ts";
import { appVersion } from "./paths.ts";
import { UPLOADING_DIR } from "./service.ts";
import { ServiceDb, type TaskEntry, peekDataDirectory } from "./service_db.ts";
import { readTaskJson } from "./task_json.ts";
import { ZipTooLarge, ZipWriter } from "./zip.ts";

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
