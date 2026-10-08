/**
 * 知识库：整理材料时用来参考的资料，与任务的输入材料是两样东西。知识库分成若干个库，每个任务选用其中几个；
 * 「通用知识库」（编号 general）每个任务默认选用，不能删除、不能改名，服务启动时没有就建出来。
 *
 * 存放（根目录由启动参数 --knowledge 给，缺省在用户数据目录下，与任务目录并列）：
 *   <根>/libraries.json                  {version: 1, libraries: [{id, name, created_at}]}
 *   <根>/<库编号>/documents.json         {version: 1, documents: [{name, kind, bytes, sha256, uploaded_at}]}
 *   <根>/<库编号>/files/<文件名>          文档本体；Word 文档旁边照材料的办法生成投影、分段清单、位置表与图片目录，这些派生文件不列在 documents 里。
 *                                        换算好的数字串也在文档旁边（<文件名>.embeddings.json 与 .embeddings.bin，见 knowledge_embeddings.ts），同样不列。
 * 两个 JSON 文件都先写临时文件再改名。文档没有版本：一份文档改了，就当作一份新文件上传。
 *
 * 任务选用了哪些库记在任务目录的 knowledge.json（{version: 1, libraries: [库编号], notes: [{at, text}]}），新建任务时写 ["general"]；
 * 没有这个文件的旧任务按只选用通用知识库算，用户改选用之前不写文件。删除一个库时，选用了它的任务改为不再选用它，并在 notes 里记一句。
 */

import { randomBytes, randomUUID, createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, rmdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";
import * as clock from "./clock.ts";
import { ApiError } from "./errors.ts";
import { readTextFile, readTextFileLenient } from "./files.ts";
import { removeEmbeddings, sweepLeftovers } from "./knowledge_embeddings.ts";
import type { PdfRunLimits } from "./launch.ts";
import { PDF_PROJECTION_SUFFIX, removePdfProjection } from "./pdf_projection.ts";
import { PDF_NO_TEXT, PdfUploadError, runPdfProjection } from "./pdf_upload.ts";
import { PDF_DERIVED_SUFFIXES, ProjectionError, isReserved, projectionPath, projectionText, removeProjection, reservedNameText, writeProjection } from "./projection.ts";
import { SEGMENT_DEFAULTS, type SegmentParams } from "../../agent/src/lib/segments.ts";
import { SELECTION_FILE } from "../../agent/src/lib/knowledge.ts";
import { GENERAL, KINDS, KIND_NAMES, type Kind } from "../../agent/src/lib/knowledge_locator.ts";
import { UPLOADING_DIR, UPLOAD_TYPES, resolvePath, sameMaterialName, unsupportedTypeText } from "./service.ts";

// 编号、种类与任务目录里记选用的文件名，助手一侧也要用，定义在 agent/src/lib 下，这里原样交出去。
export { GENERAL, KINDS, KIND_NAMES, SELECTION_FILE, type Kind };
/** 通用知识库的名字。0.4.1 之前叫「通用库」，已有的清单里存着旧名，服务启动时改成新名（ensure）。 */
export const GENERAL_NAME = "通用知识库";
export const LEGACY_GENERAL_NAME = "通用库";

/** 知识库文档的上传上限（材料的 5 MB 上限不变）。 */
export const KNOWLEDGE_MAX_UPLOAD = 20 * 1024 * 1024;
export const KNOWLEDGE_TOO_LARGE_TEXT = `单个文件不能超过 ${KNOWLEDGE_MAX_UPLOAD / 1024 / 1024} MB。`;

/** 上传的内容与这个库里已有的某份文档完全相同时的那句话（错误码 duplicate_content）。 */
export const docDuplicateText = (name: string) => `这份文件与这个知识库里已有的文档《${name}》内容完全相同，没有重复保存。`;
/** 上传的文件名与这个库里已有的某份文档相同、内容不同时的那句话（错误码 name_taken）。 */
export const docNameTakenText = (name: string) => `这个知识库里已经有一份叫《${name}》的文档，内容与这份不同。请给文件换一个名字再上传。`;

export interface LibraryRow {
  id: string;
  name: string;
  created_at: string;
}

export interface DocumentRow {
  name: string;
  kind: Kind;
  bytes: number;
  sha256: string;
  uploaded_at: string;
}

const sha256 = (data: Buffer) => createHash("sha256").update(data).digest("hex");

/** 先写临时文件再改名，写到一半断电也不会留下半个 JSON 文件。 */
function writeJson(path: string, value: unknown): void {
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(value, null, 2) + "\n", "utf-8");
  renameSync(temp, path);
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

export class KnowledgeStore {
  readonly root: string;

  constructor(root: string) {
    this.root = root;
  }

  /**
   * 建出根目录；libraries.json 不存在时写一份只有通用知识库的。已有的清单里通用知识库那一项还叫旧名「通用库」时，
   * 改成现在的名字再写回去（先写临时文件再改名）；用户自己起的名字不动。清单读不出来（文件损坏）或写不回去时
   * 跳过这一步，服务照常启动，知识库的接口到用的时候再报错。各库的文档目录里换算留下的半成品（上一次服务停下时正算到一半的）顺手清掉。
   */
  ensure(): void {
    mkdirSync(this.root, { recursive: true });
    if (!existsSync(this.librariesFile())) {
      writeJson(this.librariesFile(), { version: 1, libraries: [{ id: GENERAL, name: GENERAL_NAME, created_at: clock.now() }] });
    } else {
      try {
        const rows = this.libraries();
        if (rows.some((one) => one.id === GENERAL && one.name === LEGACY_GENERAL_NAME)) {
          this.saveLibraries(rows.map((one) => (one.id === GENERAL && one.name === LEGACY_GENERAL_NAME ? { ...one, name: GENERAL_NAME } : one)));
        }
      } catch {
        // 清单读不出来或写不回去：不修正，也不让服务因此起不来
      }
    }
    mkdirSync(this.filesDir(GENERAL), { recursive: true });
    try {
      for (const lib of this.libraries()) sweepLeftovers(this.filesDir(lib.id));
    } catch {
      // 清单读不出来：不清，也不让服务因此起不来
    }
  }

  private librariesFile(): string {
    return join(this.root, "libraries.json");
  }

  private libraryDir(id: string): string {
    return join(this.root, id);
  }

  filesDir(id: string): string {
    return join(this.libraryDir(id), "files");
  }

  private documentsFile(id: string): string {
    return join(this.libraryDir(id), "documents.json");
  }

  libraries(): LibraryRow[] {
    const raw = JSON.parse(readFileSync(this.librariesFile(), "utf-8"));
    return Array.isArray(raw?.libraries) ? raw.libraries : [];
  }

  private saveLibraries(rows: LibraryRow[]): void {
    writeJson(this.librariesFile(), { version: 1, libraries: rows });
  }

  /** 按编号找库；没有时以 not_found 拒绝。 */
  library(id: string): LibraryRow {
    const row = this.libraries().find((one) => one.id === id);
    if (!row) throw new ApiError("not_found", `没有这个知识库：${id}。`);
    return row;
  }

  has(id: string): boolean {
    return this.libraries().some((one) => one.id === id);
  }

  documents(id: string): DocumentRow[] {
    try {
      const raw = JSON.parse(readFileSync(this.documentsFile(id), "utf-8"));
      return Array.isArray(raw?.documents) ? raw.documents : [];
    } catch {
      return [];
    }
  }

  private saveDocuments(id: string, rows: DocumentRow[]): void {
    mkdirSync(this.libraryDir(id), { recursive: true });
    writeJson(this.documentsFile(id), { version: 1, documents: rows });
  }

  /** 库名：去掉首尾空白后不能是空的，也不能与别的库同名（同名规则与材料的文件名相同）。 */
  private checkName(name: unknown, except: string | null): string {
    const text = typeof name === "string" ? name.trim() : "";
    if (!text) throw new ApiError("rejected", "知识库的名字不能是空的。");
    const same = this.libraries().find((one) => one.id !== except && sameMaterialName(text, one.name));
    if (same) throw new ApiError("rejected", `已经有一个叫「${same.name}」的知识库了。`);
    return text;
  }

  create(name: unknown): LibraryRow {
    const text = this.checkName(name, null);
    const rows = this.libraries();
    let id: string;
    do id = `lib-${randomBytes(4).toString("hex")}`; while (rows.some((one) => one.id === id));
    const row = { id, name: text, created_at: clock.now() };
    mkdirSync(this.filesDir(id), { recursive: true });
    this.saveLibraries([...rows, row]);
    return row;
  }

  rename(id: string, name: unknown): LibraryRow {
    this.library(id);
    if (id === GENERAL) throw new ApiError("rejected", "通用知识库不能改名。");
    const text = this.checkName(name, id);
    const rows = this.libraries().map((one) => (one.id === id ? { ...one, name: text } : one));
    this.saveLibraries(rows);
    return rows.find((one) => one.id === id)!;
  }

  /** 删除库：先从清单里去掉，再删它的目录（文档一并删除）。 */
  remove(id: string): LibraryRow {
    const row = this.library(id);
    if (id === GENERAL) throw new ApiError("rejected", "通用知识库不能删除。");
    this.saveLibraries(this.libraries().filter((one) => one.id !== id));
    rmSync(this.libraryDir(id), { recursive: true, force: true });
    return row;
  }

  /** 与同一个库里已有的文档重内容或者重名就拒绝；返回这个库现在的文档清单。 */
  private refuseTwin(id: string, filename: string, digest: string): DocumentRow[] {
    const rows = this.documents(id);
    const twin = rows.find((one) => one.sha256 === digest);
    if (twin) throw new ApiError("duplicate_content", docDuplicateText(twin.name), { name: twin.name });
    const same = rows.find((one) => sameMaterialName(filename, one.name));
    if (same) throw new ApiError("name_taken", docNameTakenText(same.name), { name: same.name });
    return rows;
  }

  /**
   * 上传一份文档：文件名、类型、大小、同内容、同名依次检查（规则与上传材料相同，上限 20 MB）；同内容与同名只在同一个库里比。
   * Word 文档另生成投影、分段清单与位置表，路径写成相对知识库根目录的「库编号/files/文件名」；生成不了时连同文件一起删掉。
   * PDF 文档要另起一次运行生成这三样，所以这一种是异步的（uploadPdf）；别的类型当场做完。
   */
  upload(id: string, filename: string, data: Buffer, kind: unknown, segments?: SegmentParams, pdf?: PdfRunLimits): DocumentRow | Promise<DocumentRow> {
    this.library(id);
    if (!filename || filename.includes("/") || filename.includes("\\") || filename === "." || filename === "..") {
      throw new ApiError("bad_request", "文件名里不能带路径分隔符。");
    }
    if (!UPLOAD_TYPES.some((ext) => filename.toLowerCase().endsWith(ext))) throw new ApiError("unsupported_type", unsupportedTypeText());
    if (isReserved(filename)) throw new ApiError("bad_request", reservedNameText("文档"));
    if (data.length > KNOWLEDGE_MAX_UPLOAD) throw new ApiError("too_large", KNOWLEDGE_TOO_LARGE_TEXT);
    if (typeof kind !== "string" || !(KINDS as readonly string[]).includes(kind)) {
      throw new ApiError("bad_request", `资料的种类只能是${KINDS.map((k) => `「${KIND_NAMES[k]}」`).join("、")}之一。`);
    }
    const digest = sha256(data);
    const rows = this.refuseTwin(id, filename, digest);
    const folder = this.filesDir(id);
    mkdirSync(folder, { recursive: true });
    if (filename.toLowerCase().endsWith(".pdf")) return this.uploadPdf(id, filename, data, kind as Kind, digest, segments, pdf);
    const target = join(folder, filename);
    try {
      writeFileSync(target, data, { flag: "wx" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      throw new ApiError("name_taken", docNameTakenText(filename), { name: filename });
    }
    // 这个名字以前的文档留下的数字串（正常删除时已经删了）不是这份文件的，先清掉。
    removeEmbeddings(target);
    if (filename.toLowerCase().endsWith(".docx")) {
      try {
        writeProjection(target, `${id}/files/${filename}`, segments);
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
    const row: DocumentRow = { name: filename, kind: kind as Kind, bytes: data.length, sha256: digest, uploaded_at: clock.now() };
    this.saveDocuments(id, [...rows, row]);
    return row;
  }

  /**
   * 上传一份 PDF 文档，照上传 PDF 材料的三步做（service.ts 的 uploadPdf）：先在这个库的临时目录里另起一次运行生成投影、分段清单与位置表，
   * 整份没有可读的文字就拒绝；做成了再比较一次重内容、重名，把四个文件一起移进文档目录并记进清单。哪一步不成都不留东西。
   */
  private async uploadPdf(id: string, filename: string, data: Buffer, kind: Kind, digest: string, segments?: SegmentParams, limits?: PdfRunLimits): Promise<DocumentRow> {
    const folder = this.filesDir(id);
    const holding = join(this.libraryDir(id), UPLOADING_DIR);
    const staging = join(holding, randomUUID());
    mkdirSync(staging, { recursive: true });
    const staged = join(staging, filename);
    try {
      writeFileSync(staged, data);
      let parsed;
      try {
        parsed = await runPdfProjection(staged, `${id}/files/${filename}`, segments ?? SEGMENT_DEFAULTS, limits);
      } catch (error) {
        if (!(error instanceof PdfUploadError)) throw error;
        throw new ApiError("unsupported_type", error.message);
      }
      if (parsed.units === 0) throw new ApiError("unsupported_type", PDF_NO_TEXT);
      const rows = this.refuseTwin(id, filename, digest);
      const names = [...PDF_DERIVED_SUFFIXES.map((suffix) => filename + suffix), filename];
      if (names.some((name) => existsSync(join(folder, name)))) throw new ApiError("name_taken", docNameTakenText(filename), { name: filename });
      const target = join(folder, filename);
      // 这个名字以前的文档留下的数字串不是这份文件的，先清掉。
      removeEmbeddings(target);
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
      const row: DocumentRow = { name: filename, kind, bytes: data.length, sha256: digest, uploaded_at: clock.now() };
      this.saveDocuments(id, [...rows, row]);
      return row;
    } finally {
      rmSync(staging, { recursive: true, force: true });
      try {
        rmdirSync(holding); // 没有别的上传还在用它时才删得掉
      } catch {
        // 还有别的上传在用，或者已经不在了
      }
    }
  }

  /** 删除文档：从清单里去掉，再删本体与派生文件（投影一类，以及换算好的数字串）。 */
  removeDocument(id: string, name: unknown): void {
    this.library(id);
    const rows = this.documents(id);
    const row = rows.find((one) => one.name === name);
    if (!row) throw new ApiError("not_found", `这个知识库里没有文档《${String(name ?? "")}》。`);
    this.saveDocuments(id, rows.filter((one) => one !== row));
    const target = join(this.filesDir(id), row.name);
    try {
      unlinkSync(target);
    } catch {
      // 已经不在了
    }
    removeProjection(target);
    removePdfProjection(target);
    removeEmbeddings(target);
    if (row.name.toLowerCase().endsWith(".docx")) {
      try {
        unlinkSync(target + ".txt");
      } catch {
        // 本来就没有
      }
    }
  }

  /** 库里一个文件的绝对路径：必须落在这个库的 files/ 里，而且是一个文件。 */
  filePath(id: string, name: string): string {
    this.library(id);
    const base = resolvePath(this.filesDir(id));
    const target = resolvePath(join(base, name));
    if (!name || !target.startsWith(base + sep)) throw new ApiError("bad_request", `《${name}》不在这个知识库里。`);
    if (!isFile(target)) throw new ApiError("not_found", `这个知识库里没有《${name}》。`);
    return target;
  }

  /** 文档正文：.docx 给投影（没有投影时现算一份，不写文件），.pdf 给上传时生成的投影，其余按 UTF-8 读。 */
  text(id: string, name: string): string {
    const target = this.filePath(id, name);
    if (target.toLowerCase().endsWith(".pdf")) {
      const projection = target + PDF_PROJECTION_SUFFIX;
      if (!isFile(projection)) throw new ApiError("not_found", `没有由《${name}》生成的投影。`);
      return readTextFile(projection);
    }
    if (target.toLowerCase().endsWith(".docx")) {
      const projection = projectionPath(target);
      try {
        return isFile(projection) ? readTextFile(projection) : projectionText(target, `${id}/files/${name}`);
      } catch (error) {
        if (error instanceof ProjectionError || error instanceof TypeError) throw new ApiError("unsupported_type", `${(error as Error).message}。`);
        throw error;
      }
    }
    return readTextFileLenient(target);
  }
}

// ───────────── 任务选用的库 ─────────────

interface Selection {
  version: 1;
  libraries: string[];
  notes: { at: string; text: string }[];
}

function readSelectionFile(taskDir: string): Selection | null {
  try {
    const raw = JSON.parse(readFileSync(join(taskDir, SELECTION_FILE), "utf-8"));
    if (!raw || !Array.isArray(raw.libraries)) return null;
    return { version: 1, libraries: raw.libraries.filter((one: unknown) => typeof one === "string"), notes: Array.isArray(raw.notes) ? raw.notes : [] };
  } catch {
    return null;
  }
}

/** 任务选用的库；没有 knowledge.json（旧任务）或读不出来时按只选用通用知识库算。 */
export function selectedLibraries(taskDir: string): string[] {
  return readSelectionFile(taskDir)?.libraries ?? [GENERAL];
}

/** 写任务选用的库。note 给了就在 notes 里追加一句（删除库时用）。 */
export function writeSelection(taskDir: string, libraries: string[], note: string | null = null): void {
  const current = readSelectionFile(taskDir);
  const notes = [...(current?.notes ?? []), ...(note ? [{ at: clock.now(), text: note }] : [])];
  writeJson(join(taskDir, SELECTION_FILE), { version: 1, libraries, notes });
}

/** 新建任务时写的内容：只选用通用知识库。 */
export function initialSelection(): Selection {
  return { version: 1, libraries: [GENERAL], notes: [] };
}
