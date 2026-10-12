/**
 * 调试模式（启动参数 --debug）下的两样东西：设置里的「提示词目录」，与某个任务最近一次运行实际发给模型的系统提示。
 *
 * 提示词目录存在产品设置文件顶层的 debug.prompt_dir（文件里别的键原样保留）。助手一侧的扩展在调试模式下每次运行开始时读它，
 * 目录里有哪一份文件就用哪一份代替产品自带的或任务目录里的（agent/src/lib/stage_prompt.ts）。这里只管设与看：设的时候核对它是
 * 一个存在的目录的绝对路径；看的时候逐个列出那十五个固定的文件名在目录里有没有、用不用得上。产品只读这个目录，不往里写。
 *
 * 最近一次的系统提示来自扩展每次运行报来的那一行（pi_session.ts 的 lastStagePrompt），由执行者按任务留最近一份在内存里；
 * 服务重启之后、这个任务再运行一次之前是没有的。
 *
 * 不是调试模式时，这里的每个接口都答 not_found。
 */

import { statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { NODE_IO, ORIGIN_NAMES, PART_NAMES, promptDirNames } from "../../agent/src/lib/stage_prompt.ts";
import { STAGE_NAMES } from "../../agent/src/lib/stage.ts";
import { ApiError } from "./errors.ts";
import { readPromptDir, writePromptDir } from "./product_settings.ts";
import { baseMessages } from "./conversation.ts";
import * as library from "./library.ts";
import { personaDraft } from "./persona_draft.ts";
import type { Service } from "./service.ts";

export const DEBUG_ONLY_TEXT = "这个接口只在调试模式下可用：启动服务时加上 --debug。";

function requireDebug(service: Service): void {
  if (!service.debug) throw new ApiError("not_found", DEBUG_ONLY_TEXT);
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** 提示词目录现在设的是什么，以及十五个文件名各自在目录里的情形。 */
export function promptDirView(service: Service) {
  requireDebug(service);
  const dir = readPromptDir(process.env);
  const usable = dir !== null && isAbsolute(dir) && isDirectory(dir);
  return {
    prompt_dir: dir,
    // 设了而目录已经不在（或者不是目录）时为假，note 写着原因；这时每次运行都照旧用产品自带的。
    usable: dir === null ? null : usable,
    note: dir !== null && !usable ? `这个目录不存在或者不是目录：${dir}。现在每次运行用的都是产品自带的文字。` : null,
    files: promptDirNames().map((name) => {
      if (!usable) return { name, state: "absent" as const, reason: null };
      const state = NODE_IO.plain(join(dir!, name));
      // 「用得上」只看它是不是一份大小合适的普通文件；是不是合法的 UTF-8 要到读的时候才知道，那时不合的照旧用原来的。
      return state.kind === "file" ? { name, state: "used" as const, reason: null }
        : state.kind === "refused" ? { name, state: "refused" as const, reason: `${state.reason}，这一份照旧用原来的。` }
          : { name, state: "absent" as const, reason: null };
    }),
  };
}

/** 设或清掉提示词目录。body 写 { path }：绝对路径；空串或 null 是清掉。 */
export async function setPromptDir(service: Service, body: Record<string, unknown>) {
  requireDebug(service);
  const raw = body.path;
  if (raw !== null && typeof raw !== "string") throw new ApiError("bad_request", "要在 path 里写提示词目录的绝对路径；写空串是清掉。");
  const path = (raw ?? "").trim();
  if (path === "") {
    await writePromptDir(null, process.env);
    return promptDirView(service);
  }
  if (!isAbsolute(path)) throw new ApiError("bad_request", `提示词目录要写绝对路径，现在写的是「${path}」。`);
  const dir = resolve(path);
  if (!isDirectory(dir)) throw new ApiError("bad_request", `这个目录不存在或者不是目录：${dir}。先建好目录再设。`);
  await writePromptDir(dir, process.env);
  return promptDirView(service);
}

/** 某个任务最近一次运行实际发给模型的系统提示，分段给出。 */
export function lastSystemPrompt(service: Service, taskId: string) {
  requireDebug(service);
  const last = service.task(taskId).executor.lastStagePrompt;
  if (last === null) {
    return { available: false, note: "服务这次启动以来，这个任务还没有运行过，所以还没有可看的系统提示。对助手说一句话之后再来看。", parts: [], text: "" };
  }
  const fact = last.report;
  const parts = (Array.isArray(fact.texts) ? fact.texts : []).map((one: Record<string, any>) => {
    const text = String(one.text ?? "");
    const launch = one.part === "launch";
    return {
      part: String(one.part), part_name: launch ? "启动时给的整份系统提示（没有替换）" : PART_NAMES[one.part as keyof typeof PART_NAMES] ?? String(one.part),
      from: String(one.from), from_name: ORIGIN_NAMES[one.from as keyof typeof ORIGIN_NAMES] ?? String(one.from),
      file: one.file ?? null, lines: text.split("\n").length, bytes: Buffer.byteLength(text, "utf-8"), text,
    };
  });
  return {
    available: true,
    note: fact.replaced === false && typeof fact.error === "string" ? fact.error
      : fact.replaced === false ? "这个任务没有阶段，系统提示是启动时给的那一份，没有替换。" : null,
    session_id: last.session_id, at: last.at,
    replaced: fact.replaced === true,
    stage: fact.stage ?? null, stage_name: fact.stage ? STAGE_NAMES[fact.stage as keyof typeof STAGE_NAMES] ?? null : null,
    how: fact.how ?? null, error: fact.error ?? null,
    prompt_dir: fact.prompt_dir ?? null, notes: Array.isArray(fact.notes) ? fact.notes : [],
    digest: fact.digest ?? null,
    parts,
    // 各部分用一个空行接起来，就是发给模型的整份。
    text: parts.map((one: { text: string }) => one.text).join("\n\n"),
  };
}

/**
 * 某个任务的阶段记录流水与被拒的工具调用（调试面板的两块）。
 * records 是全部阶段记录，按先后；rejections 是最近被拒的工具调用，新的在前，各带它所属的那次工作 work_id；
 * latest_work_id 是最近一次被拒所在的那次工作，面板缺省只显示这一次工作里的。
 */
export function stageDebug(service: Service, taskId: string) {
  requireDebug(service);
  const view = library.stageDebugView(service.task(taskId).dir);
  const records = view.records.map((one) => ({
    ...one,
    from_name: STAGE_NAMES[one.from as keyof typeof STAGE_NAMES] ?? String(one.from),
    to_name: STAGE_NAMES[one.to as keyof typeof STAGE_NAMES] ?? String(one.to),
  }));
  return { records, rejections: view.rejections, latest_work_id: view.rejections.length > 0 ? view.rejections[0].work_id ?? null : null };
}

/**
 * 把这个任务里用户说过的话整理成模拟器用户画像的草稿（persona_draft.ts）：遍历任务的全部会话，按会话开始的先后。
 * 返回 { file_name, persona, sessions, facts }：页面把 persona 存成名为 file_name 的文件。只读，不写任何东西。
 * 哪条会话的记录读不出来就跳过它，skipped 里写它的编号。
 */
export async function personaDraftOf(service: Service, taskId: string) {
  requireDebug(service);
  const t = service.task(taskId);
  const row = t.row();
  const rows = [...t.executor.listSessions()].sort((a, b) => String(a.started_at ?? "").localeCompare(String(b.started_at ?? "")));
  const sessions: Record<string, any>[][] = [];
  const skipped: string[] = [];
  for (const one of rows) {
    try {
      sessions.push(baseMessages(await t.executor.entries(one.session_id), one.session_id));
    } catch {
      skipped.push(String(one.session_id));
    }
  }
  const materials = library.materials(t.dir, t.definition()).filter((m: Record<string, any>) => !m.derived_from).map((m: Record<string, any>) => String(m.path));
  const persona = personaDraft({ task_id: taskId, task_name: String(row?.task_name ?? taskId) }, materials, sessions);
  return { file_name: `persona-${taskId}.json`, persona, sessions: sessions.length, facts: persona["隐藏事实"].length, skipped };
}
