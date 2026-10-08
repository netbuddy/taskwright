/**
 * 助手一侧读知识库：这个任务选用了哪些知识库、里面各有哪些文档、一条知识库来源的出处指向哪个文件。只读，不写任何东西。
 *
 * 知识库根目录由后端启动助手时经环境变量 TASKWRIGHT_KNOWLEDGE_ROOT 传进来；没有这个变量（服务没有知识库、
 * 直接跑命令行入口、单元测试）就当作没有知识库。根目录在任务目录之外，存放的样子由后端定（backend/src/knowledge.ts）：
 *   <根>/libraries.json            {libraries: [{id, name}]}
 *   <根>/<知识库编号>/documents.json  {documents: [{name, kind, bytes}]}
 *   <根>/<知识库编号>/files/<文档名>  文档本体；Word 文档旁边有由它生成的投影（文档名加 .md）
 * 任务选用了哪些知识库记在任务目录的 knowledge.json（{libraries: [知识库编号]}）；没有这个文件的旧任务按只选用通用知识库算。
 *
 * 本模块不依赖 pi，单元测试可以直接调用。
 */

import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { GENERAL, KIND_NAMES, type Kind, knowledgeLocator, parseKnowledgeLocator } from "./knowledge_locator.ts";

/** 知识库根目录：后端启动助手时经这个环境变量传进来。 */
export const KNOWLEDGE_ROOT_ENV = "TASKWRIGHT_KNOWLEDGE_ROOT";

/** 任务目录里记选用的知识库的文件。 */
export const SELECTION_FILE = "knowledge.json";

/** 当前进程的知识库根目录；没设时为 null（没有知识库）。 */
export function envKnowledgeRoot(env: NodeJS.ProcessEnv = process.env): string | null {
  return (env[KNOWLEDGE_ROOT_ENV] ?? "").trim() || null;
}

export interface KnowledgeDocument {
  name: string;
  /** 种类的中文叫法。 */
  kindName: string;
  bytes: number;
  /** 引用它作来源时出处的写法（Word 文档还要加段落号）。 */
  locator: string;
  word: boolean;
}

export interface SelectedLibrary {
  id: string;
  name: string;
  documents: KnowledgeDocument[];
}

function readJson(path: string): Record<string, unknown> | null {
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8"));
    return raw && typeof raw === "object" ? raw : null;
  } catch {
    return null;
  }
}

/** 任务选用的知识库的编号；没有 knowledge.json（旧任务）或读不出来时按只选用通用知识库算。 */
export function selectedLibraryIds(taskDir: string): string[] {
  const raw = readJson(join(taskDir, SELECTION_FILE));
  if (!Array.isArray(raw?.libraries)) return [GENERAL];
  // 编号只会是一个目录名；带路径分隔符或是「..」的不认，免得拼出知识库根目录之外的路径。
  return raw.libraries.filter((one): one is string => typeof one === "string" && one !== "" && one !== "." && one !== ".." && !/[\\/]/.test(one));
}

/** 知识库的编号到名字；根目录不存在或清单读不出来时是空的。 */
export function libraryNames(root: string): Map<string, string> {
  const raw = readJson(join(root, "libraries.json"));
  const rows = Array.isArray(raw?.libraries) ? (raw.libraries as { id?: unknown; name?: unknown }[]) : [];
  return new Map(rows.filter((one) => typeof one?.id === "string").map((one) => [one.id as string, typeof one.name === "string" ? one.name : (one.id as string)]));
}

/**
 * 这个任务选用的知识库与里面的文档，先后照任务的选用。没有知识库根目录时是空的；
 * 选用的编号在知识库清单里找不到（那个知识库已经删除）时跳过，不报错。
 */
export function selectedKnowledge(taskDir: string, root: string | null): SelectedLibrary[] {
  if (!root) return [];
  const names = libraryNames(root);
  const out: SelectedLibrary[] = [];
  for (const id of selectedLibraryIds(taskDir)) {
    if (!names.has(id)) continue;
    const raw = readJson(join(root, id, "documents.json"));
    const rows = Array.isArray(raw?.documents) ? (raw.documents as { name?: unknown; kind?: unknown; bytes?: unknown }[]) : [];
    const documents = rows.filter((one) => typeof one?.name === "string").map((one) => {
      const name = one.name as string;
      const word = /\.docx$/i.test(name);
      return {
        name,
        kindName: KIND_NAMES[one.kind as Kind] ?? String(one.kind ?? ""),
        bytes: typeof one.bytes === "number" ? one.bytes : 0,
        locator: knowledgeLocator(id, name),
        word,
      };
    });
    out.push({ id, name: names.get(id)!, documents });
  }
  return out;
}

/**
 * 知识库来源的出处（knowledge/<知识库编号>/<文件名>，不带段落号）指向的文件的绝对路径。
 * 写法不对（缺编号或文件名、带路径分隔符或「..」）时返回 null：这样的出处指不到知识库里的文件。
 */
export function knowledgeFilePath(root: string, locator: string): string | null {
  const parsed = parseKnowledgeLocator(locator);
  return parsed ? join(root, parsed.library, "files", parsed.name) : null;
}

/**
 * 这个任务选用的知识库最近一次变动的时刻（毫秒）：任务的选用与各选用知识库的文档清单这几个文件里最晚的修改时刻；
 * 一个都读不到时为 0。续接会话时用它判断上次之后知识库有没有变。
 *
 * 不看知识库根目录的 libraries.json：新建、改名或删除任何一个知识库都会改写它，与这个任务无关的也算进来的话，
 * 每条续接的会话都会误报「知识库有变化」。删除任务选用的知识库时，后端会改写任务的 knowledge.json，仍然察觉得到；
 * 只给选用的知识库改名察觉不到，名字在下一次写这一段时才更新。
 */
export function knowledgeChangedAt(taskDir: string, root: string | null): number {
  if (!root) return 0;
  const files = [join(taskDir, SELECTION_FILE), ...selectedLibraryIds(taskDir).map((id) => join(root, id, "documents.json"))];
  let latest = 0;
  for (const file of files) {
    try {
      latest = Math.max(latest, statSync(file).mtimeMs);
    } catch {
      // 没有这个文件
    }
  }
  return latest;
}
