/**
 * 过程摘要：一次工作做了几步、用了多久、合并后的阶段。从 pi 的会话条目算，刷新之后也能重算，不用另存。
 *
 * 一次工作从一句用户的话开始，到下一句用户的话之前为止（兜底追加的那句固定文字不算用户的话）。
 * · 步数：这次工作里工具调用的次数。
 * · 用时：从那句用户的话到这次工作最后一个条目的时刻。
 * · 阶段：每个工具调用写成一句，相邻的同类调用合成一句，例如连着读了三份材料写成「读了材料《a》、《b》、《c》」。
 *   保存修订被拒时，这一句写「保存修订被拒：」加第一条原因的事实，阶段另有 reasons 列出全部原因的事实。
 * · 工作编号：「w-{那句用户的话的会话条目编号}」。修订日志按它把修订归到工作。
 */

import { readFileSync } from "node:fs";
import { basename } from "node:path";
import * as clock from "./clock.ts";
import { INTENT_SCHEMA_PATH } from "./paths.ts";
import { jsonOrText } from "../../agent/src/lib/task_read.ts";
import { openRo } from "./library.ts";
import { isObject, or, truthy } from "./py.ts";

export const REPLY_TOOL = "reply";
export const OP_WORDS: Record<string, string> = { add: "新增", update: "修改", delete: "删除", restore: "恢复" };
export const SAVE_REJECTED_HEAD = "这次「保存修订」什么都没有写入";
export const SAVE_REJECTED_TAIL = "\n请把这些地方改正之后";
/** 拒绝正文里每个操作那一行开头的标签，例如「操作 1（修改，条目 TBD-001）：」；事实不带它。 */
const OP_LABEL = /^操作 \d+(?:（[^）]*）)?：/;
/** 指引那一行的开头（agent/src/lib/save_revision.ts 的 GUIDANCE_PREFIX）。 */
export const GUIDANCE_PREFIX = "怎么办：";

type Dict = Record<string, any>;

/**
 * 保存修订被拒时逐条的原因，一个操作一条，每条 {fact, guidance}。原因只在结果正文里：开头一句「这次「保存修订」什么都没有写入……」，
 * 下面每个操作一段「- 操作 N（……）：事实」，下一行「  怎么办：指引」，最后一句「请把这些地方改正之后……」。
 * details 里已经带了 reasons 的直接用。不是这种正文时返回空列表。
 */
export function rejectionParts(details: Dict | null, text: string): { fact: string; guidance: string }[] {
  const given = (details || {}).reasons;
  if (Array.isArray(given) && given.length) return given.map((one) => (isObject(one) ? one as any : { fact: String(one), guidance: "" }));
  if (!text.startsWith(SAVE_REJECTED_HEAD)) return [];
  let body = text.includes("\n") ? text.slice(text.indexOf("\n") + 1) : "";
  const tail = body.indexOf(SAVE_REJECTED_TAIL);
  if (tail >= 0) body = body.slice(0, tail);
  const out = [];
  for (const block of body.split(/(?:^|\n)- /)) {
    if (!block.trim()) continue;
    const lines = block.split("\n");
    const hit = lines.slice(1).find((line) => line.trim().startsWith(GUIDANCE_PREFIX));
    out.push({ fact: lines[0].trim().replace(OP_LABEL, ""), guidance: hit ? hit.trim().slice(GUIDANCE_PREFIX.length) : "" });
  }
  return out;
}

export function rejectionReasons(details: Dict | null, text: string): string[] {
  return rejectionParts(details, text).map((one) => one.fact);
}

/** 工具结果正文里的文字部分，连成一段。 */
export function resultText(result: Dict): string {
  const content = result.content;
  if (typeof content === "string") return content;
  return (or(content, []) as unknown[]).filter((p) => isObject(p) && p.type === "text").map((p: any) => or(p.text, "")).join("\n");
}

/** 读的是什么：[种类, 显示的名字]。种类用来判断相邻两次读能不能合成一句。 */
export function readKind(path: string, definition: Dict): [string, string] {
  const name = basename(path);
  const materials = or(definition["材料目录"], "inputs/") as string;
  if (path.includes(".pi/skills/") || path.endsWith("SKILL.md")) return ["方法说明", "方法说明"];
  if ((or(definition["领域规矩"], []) as string[]).some((r) => path.endsWith(r) || path.includes(r))) return ["领域规矩", `《${name}》`];
  if (path.includes("task-definitions/")) return ["任务定义", "任务定义"];
  if (path.includes(`/${materials}`) || path.startsWith(materials)) return ["材料", `《${name}》`];
  return ["文件", `《${name}》`];
}

const py = (v: unknown) => (v === null || v === undefined ? "None" : String(v));

/** 一次工具调用写成一句话：进行中、做完、失败三种说法。实时的 step 行与过程摘要共用。 */
export function stepText(tool: string, args: Dict, done: boolean, failed: boolean, details: Dict | null, definition: Dict): string {
  if (tool === "read") {
    const [kind, name] = readKind(String(or(args.path, "")), definition);
    const what = kind === "方法说明" || kind === "任务定义" ? name : `${kind === "领域规矩" ? "领域规矩" : kind}${name}`;
    return failed ? `读${what}没有读成` : done ? `读了${what}` : `正在读${what}`;
  }
  if (tool === "ls") return failed ? "看目录没有看成" : done ? "看了目录" : "正在看目录";
  if (tool === "save_revision") {
    if (failed) {
      const reasons = rejectionReasons(details, "");
      if (!reasons.length) return "保存修订被拒，助手正在照原因改";
      const first = reasons[0].split("\n")[0];
      const more = reasons.length > 1 ? `（还有 ${reasons.length - 1} 条）` : "";
      return `保存修订被拒：${first}${more}`;
    }
    if (!done) return "正在保存修订";
    const d = details || {};
    if (d.replayed === true) return `这次保存是重复的请求，修订 ${py(d.revision_no)} 之前已经保存过，没有重复写入`;
    const grouped = new Map<string, any[]>();
    for (const op of or(d.operations, []) as Dict[]) {
      const key = `${OP_WORDS[op.op] ?? py(op.op)}${py(op.collection)}`;
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key)!.push(op.item ?? null);
    }
    const parts = [...grouped].map(([k, v]) => `${k} ${v.length} 个（${v.length === 1 ? py(v[0]) : py(v[0]) + " 到 " + py(v[v.length - 1])}）`);
    return `写好并保存了修订 ${py(d.revision_no)}：` + parts.join("；");
  }
  if (tool === "get_item") {
    const item = or(args.item_id, "");
    return failed ? `查看条目 ${item} 没有成` : done ? `查看了条目 ${item}` : `正在查看条目 ${item}`;
  }
  if (tool === "get_task_status") return failed ? "查看任务状态没有成" : done ? "查看了任务状态" : "正在查看任务状态";
  if (tool === "complete_task") return failed ? "完成任务被拒，完成条件还没满足" : done ? "把任务标为已完成" : "正在完成任务";
  if (tool === "request_review") {
    if (failed) return "请评审者评审没有做成";
    if (!done) return "正在请评审者评审";
    const results = or((details || {}).results, []) as Dict[];
    const bad = results.filter((r) => r.status === "不合规").length;
    return `评审了 ${results.length} 个条目，${bad} 个不合规`;
  }
  if (tool === REPLY_TOOL) return failed ? "回复的形式不对，助手正在改" : done ? "说完了" : "正在组织回复";
  return failed ? `调用 ${tool} 失败` : done ? `调用了 ${tool}` : `正在调用 ${tool}`;
}

/** 把一次工作的全部工具调用合成阶段。calls 每项是 {tool, args, failed, details}，按先后排。 */
export function stages(calls: Dict[], definition: Dict) {
  const out: Dict[] = [];
  let lastKey: string | null = null;
  for (const c of calls) {
    const tool = c.tool;
    const args = or(c.args, {}) as Dict;
    const failed = truthy(c.failed);
    let key: string | null;
    let text: string;
    if (failed) {
      key = null;
      text = stepText(tool, args, true, true, c.details ?? null, definition);
      const reasons = tool === "save_revision" ? rejectionReasons(c.details ?? null, "") : [];
      if (reasons.length) {
        out.push({ text, count: 1, names: [], _key: key, reasons });
        lastKey = key;
        continue;
      }
    } else if (tool === "read") {
      const [kind, name] = readKind(String(or(args.path, "")), definition);
      key = `read\u0000${kind}`;
      if (lastKey === key && ["材料", "领域规矩", "文件"].includes(kind)) {
        const last = out[out.length - 1];
        last.names.push(name);
        last.count += 1;
        last.text = `读了${kind === "领域规矩" ? "领域规矩" : kind}` + last.names.join("、");
        continue;
      }
      text = stepText(tool, args, true, false, c.details ?? null, definition);
      out.push({ text, count: 1, names: [name], _key: key });
      lastKey = key;
      continue;
    } else if (["ls", "get_task_status", REPLY_TOOL].includes(tool)) {
      key = tool;
      if (lastKey === key) {
        out[out.length - 1].count += 1;
        continue;
      }
      text = tool === REPLY_TOOL ? "组织并发出了回复" : stepText(tool, args, true, false, c.details ?? null, definition);
    } else {
      key = null;
      text = stepText(tool, args, true, false, c.details ?? null, definition);
    }
    out.push({ text, count: 1, names: [], _key: key });
    lastKey = key;
  }
  return out.map((s) => ({ text: s.text, count: s.count, ...(truthy(s.reasons) ? { reasons: s.reasons } : {}) }));
}

let names: Record<string, string> | null = null;

/** 用户行为各功能的中文名，键是英文码，取自理解格式的 schema。读不到时为空。 */
export function functionNames(): Record<string, string> {
  if (names === null) {
    try {
      const schema = JSON.parse(readFileSync(INTENT_SCHEMA_PATH, "utf-8"));
      const got = schema["$defs"]["user_function"]["x-names"];
      names = isObject(got) ? { ...got } : {};
    } catch {
      names = {};
    }
  }
  return names;
}

/** 保留一位小数，逢五取偶（与 Python 的 round(x, 1) 相同）。 */
export function round1(x: number): number {
  const scaled = x * 10;
  const floor = Math.floor(scaled);
  const diff = scaled - floor;
  if (diff === 0.5) return (floor % 2 === 0 ? floor : floor + 1) / 10;
  return Number(x.toFixed(1));
}

function isFallback(entry: Dict, fallbackText: string, textOf: (c: unknown) => string): boolean {
  const m = or(entry.message, {}) as Dict;
  return m.role === "user" && textOf(m.content ?? null) === fallbackText;
}

export interface Work {
  work_id: string;
  user_message_id: string;
  reply_ids: string[];
  call_ids: string[];
  at: string | null;
  seconds: number | null;
  step_count: number;
  stages: Dict[];
}

/**
 * 从当前分支上的会话条目切出每一次工作，算出过程摘要。没有调用过工具、也没有回复的那一段不算一次工作。
 * call_ids 是这次工作里全部工具调用的调用编号，修订日志据此把一次修订归到产生它的那次工作。
 */
export function worksFromEntries(pathEntries: Dict[], definition: Dict, fallbackText: string, textOf: (c: unknown) => string): Work[] {
  const results = new Map<string, Dict>();
  for (const e of pathEntries) {
    const m = or(e.message, {}) as Dict;
    if (e.type === "message" && m.role === "toolResult") results.set(m.toolCallId ?? "", m);
  }
  const works: Work[] = [];
  let current: Dict | null = null;
  const close = () => {
    if (current && (current.calls.length || current.reply_ids.length)) {
      const start = clock.parseUtcIso(current.start);
      const end = clock.parseUtcIso(current.end);
      works.push({
        work_id: `w-${py(current.user_message_id)}`, user_message_id: current.user_message_id, reply_ids: current.reply_ids,
        call_ids: current.call_ids, at: clock.fromUtcIso(current.end), seconds: start !== null && end !== null ? round1(end - start) : null,
        step_count: current.calls.length, stages: stages(current.calls, definition),
      });
    }
  };
  for (const e of pathEntries) {
    if (e.type !== "message") continue;
    const m = or(e.message, {}) as Dict;
    const role = m.role;
    if (role === "user" && !isFallback(e, fallbackText, textOf)) {
      close();
      current = { user_message_id: e.id ?? null, start: e.timestamp ?? null, end: e.timestamp ?? null, calls: [], reply_ids: [], call_ids: [] };
      continue;
    }
    if (current === null) continue;
    current.end = or(e.timestamp, null) ?? current.end;
    if (role !== "assistant") continue;
    for (const part of or(m.content, []) as unknown[]) {
      if (!(isObject(part) && part.type === "toolCall")) continue;
      const result = results.get(part.id ?? null) ?? {};
      const failed = truthy(result.isError);
      current.call_ids.push(part.id ?? null);
      let details = or(result.details, {}) as Dict;
      if (failed && part.name === "save_revision") details = { ...details, reasons: rejectionParts(details, resultText(result)) };
      current.calls.push({ tool: or(part.name, ""), args: or(part.arguments, {}), failed, details });
      if (part.name === REPLY_TOOL && truthy(result) && !failed) current.reply_ids.push(e.id ?? null);
    }
  }
  close();
  return works;
}

// ───────────── 「理解为」那一行 ─────────────

/** 这句话还没有合格的理解时，「理解为」那一行的三种说法（agent 侧的三种事件见 agent/src/lib/dialogue_acts.ts）。 */
export const INTENT_INVALID_TEXT = "助手的理解里有对不上的地方，正在重写";
export const INTENT_MISSING_TEXT = "助手这一轮没有写下理解";
export const INTENT_PENDING_TEXT = "助手的理解正在重写";
/** 这一轮还在进行中的两种说法：界面上这一行带进行中的样子。 */
export const INTENT_IN_PROGRESS_TEXTS = [INTENT_INVALID_TEXT, INTENT_PENDING_TEXT];
/** 几种说法的先后：同一句话有几种事件时取排在前面的；记下了理解就写理解，不看这几种。 */
const NO_UNDERSTANDING: Record<string, string> = {
  USER_INTENT_MISSING: INTENT_MISSING_TEXT, USER_INTENT_INVALID: INTENT_INVALID_TEXT, STRUCTURED_OUTPUT_UNMATCHED: INTENT_PENDING_TEXT,
};
const CONFIDENCE_ORDER = ["low", "medium", "high"];
const CONFIDENCE_NOTE: Record<string, string> = { low: "（把握低）", medium: "（把握中）", high: "" };

/** 一条用户行为在「理解为」一行里的写法：「中文名（英文码）摘要」。 */
export function actText(act: Dict): string {
  const summary = String(or(act.summary, "")).trim();
  const code = act.function;
  const name = truthy(code) ? functionNames()[code] : undefined;
  return name ? `${name}（${code}）${summary}` : summary;
}

/** 一份理解写成一行：各条用户行为用「；」连起来，把握取最低的一档，中或低时括注。 */
export function understandingText(acts: Dict[]): string | null {
  const summaries = acts.filter((a) => String(or(a.summary, "")).trim()).map(actText);
  if (!summaries.length) return null;
  const levels = acts.map((a) => a.confidence).filter((c) => CONFIDENCE_ORDER.includes(c));
  const lowest = levels.length ? levels.reduce((a, b) => (CONFIDENCE_ORDER.indexOf(b) < CONFIDENCE_ORDER.indexOf(a) ? b : a)) : "high";
  return "理解为：" + summaries.join("；") + CONFIDENCE_NOTE[lowest];
}

/**
 * 这条会话里每句用户的话（按会话条目编号）对应的「理解为」那一行，从任务库的事件表读。界面合成的话（origin 为 ui）值为 null；
 * 还没有理解时按事件写一句（见 NO_UNDERSTANDING）。没有库、没有这几种事件的旧库，返回空的。只读。
 */
export function understandingLines(taskDir: string | null, sessionId: string): Map<string, string | null> {
  const out = new Map<string, string | null>();
  if (taskDir === null) return out;
  const db = openRo(taskDir);
  if (db === null) return out;
  try {
    const names = ["USER_INTENT_RECORDED", ...Object.keys(NO_UNDERSTANDING)];
    const rows = db.prepare(`SELECT name, payload FROM event WHERE session_id = ? AND name IN (${names.map(() => "?").join(", ")}) ORDER BY seq`)
      .all(sessionId, ...names) as Dict[];
    const rank = Object.values(NO_UNDERSTANDING);
    const understood = new Set<string>();
    const hasActs = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'dialogue_act'").get() !== undefined;
    for (const { name, payload } of rows) {
      const data = or(jsonOrText(payload), {}) as Dict;
      const entry = data.user_entry;
      if (!truthy(entry)) continue;
      if (name in NO_UNDERSTANDING) {
        const text = NO_UNDERSTANDING[name];
        if (!understood.has(entry) && (!out.has(entry) || rank.indexOf(text) < rank.indexOf(out.get(entry) as string))) out.set(entry, text);
        continue;
      }
      understood.add(entry);
      if (data.origin === "ui") {
        out.set(entry, null);
        continue;
      }
      const acts = (or(data.acts, []) as unknown[]).filter(isObject).map((a) => ({ ...a }));
      for (const act of acts) {
        if ((act.confidence ?? null) === null && hasActs && truthy(act.act_id)) {
          const found = db.prepare("SELECT confidence FROM dialogue_act WHERE session_id = ? AND act_id = ?").get(sessionId, act.act_id) as Dict | undefined;
          act.confidence = found ? found.confidence : null;
        }
      }
      out.set(entry, understandingText(acts));
    }
  } catch {
    return out; // 读不出来只是少这一行，不影响摘要
  } finally {
    db.close();
  }
  return out;
}
