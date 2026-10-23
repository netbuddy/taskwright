/**
 * 按会话导出诊断包时，判断任务归档里哪些东西属于这条会话（data_pack.ts 用）。
 *
 * 会话文件：runs/<任务>/pi-sessions/<label>/<时刻>_<会话编号>.jsonl，一条会话一份；续接前改写工作目录留下的备份
 * （原名.cwd-<时刻>.bak）也算这条会话的。
 *
 * 归档组：pi-events 下同一个基名的三份文件（原始事件流、后端补记、收到时刻），每启动一次 pi 一组。一个任务实例只有一个 pi 进程，
 * 切换会话在进程内进行，所以一组常跨好几条会话。整组带、不切行，判断次序：
 * 1. 后端补记里有「会话起点」记录的组（新归档）：有指向这条会话的记录就带，否则不带。
 * 2. 没有这种记录的旧归档：看原始事件流里 get_state 回应的 data.sessionId（后端在启动、切换、新建会话之后都会发 get_state）：
 *    有这条会话的编号就带，只有别的编号就不带。
 * 3. 一条 get_state 回应都没有的组：按时刻判。组的时段是收到时刻文件的第一行到最后一行；会话文件里有条目的时刻落在时段之内就带，
 *    落在时段之外一秒以上的不带；判不出（收到时刻文件不在或是空的、会话文件里没有带时刻的条目、条目只落在时段前后一秒之内）的组
 *    不带，列进 omitted（宁缺勿错带别的会话的记录）。
 */

import { closeSync, openSync, readFileSync, readSync, readdirSync } from "node:fs";
import { join } from "node:path";
import * as clock from "./clock.ts";

/** 判不出归属的组的三种原因。措辞固定，只在这里。 */
export const OMITTED_NO_TIMES = "这组归档没有会话起点记录与会话编号，收到时刻文件不在或是空的，判断不了它是否属于这条会话。";
export const OMITTED_NO_SESSION_TIMES = "这组归档没有会话起点记录与会话编号，这条会话的会话文件里没有带时刻的条目，判断不了它是否属于这条会话。";
export const OMITTED_AT_EDGE = "这组归档没有会话起点记录与会话编号，这条会话的条目只落在这组归档时段前后一秒之内，判断不了它是否属于这条会话。";

/** 时段两头的容差（秒）：会话文件的条目时刻与收到时刻之间有一点先后，落在容差里的算判不出。 */
export const EDGE_SECONDS = 1;

export interface OmittedGroup {
  /** 组的基名，例如 service-20261022-040858。 */
  group: string;
  reason: string;
}

export interface SessionFacts {
  /** 会话文件与它的备份，相对归档目录的路径（正斜杠分段）。 */
  files: string[];
  /** 会话名（session_info 条目里最后一次起的名字）；没有起过名是 null。 */
  name: string | null;
  /** 会话文件里各条目的时刻（从 1970 年起的秒数），按先后排。 */
  times: number[];
  /** 首尾条目的时刻（本机时区的 ISO 8601）；没有带时刻的条目时是 null。 */
  first: string | null;
  last: string | null;
}

const lines = (text: string) => text.split("\n").filter((line) => line.trim());

function parsed(line: string): Record<string, any> | null {
  try {
    const value = JSON.parse(line);
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

/** 找这条会话的会话文件并读出名字与各条目的时刻；归档里没有这条会话时是 null。 */
export function sessionFacts(archiveDir: string, sessionId: string): SessionFacts | null {
  const root = join(archiveDir, "pi-sessions");
  let labels: string[];
  try {
    labels = readdirSync(root).sort();
  } catch {
    return null;
  }
  const suffix = `_${sessionId}.jsonl`;
  for (const label of labels) {
    let names: string[];
    try {
      names = readdirSync(join(root, label)).sort();
    } catch {
      continue;
    }
    const main = names.find((name) => name.endsWith(suffix));
    if (!main) continue;
    let name: string | null = null;
    const times: number[] = [];
    let text = "";
    try {
      text = readFileSync(join(root, label, main), "utf-8");
    } catch {
      // 读不出来就当没有条目
    }
    for (const line of lines(text)) {
      const entry = parsed(line);
      if (!entry) continue;
      if (entry.type === "session_info" && typeof entry.name === "string" && entry.name) name = entry.name;
      const at = clock.parseUtcIso(typeof entry.timestamp === "string" ? entry.timestamp : null);
      if (at !== null) times.push(at);
    }
    times.sort((a, b) => a - b);
    const iso = (seconds: number | undefined) => (seconds === undefined ? null : clock.fromUtcIso(new Date(seconds * 1000).toISOString()));
    const files = names.filter((one) => one === main || one.startsWith(`${main}.cwd-`)).map((one) => `pi-sessions/${label}/${one}`);
    return { files, name, times, first: iso(times[0]), last: iso(times[times.length - 1]) };
  }
  return null;
}

/** 后端补记里「会话起点」记录指向的会话编号；补记不在或者没有这种记录时是空的。 */
function sessionStarts(notesFile: string): Set<string> {
  const found = new Set<string>();
  let text: string;
  try {
    text = readFileSync(notesFile, "utf-8");
  } catch {
    return found;
  }
  for (const line of lines(text)) {
    if (!line.includes("会话起点")) continue;
    const note = parsed(line);
    if (note?.记录 === "会话起点" && typeof note.会话编号 === "string") found.add(note.会话编号);
  }
  return found;
}

/** 原始事件流里各条 get_state 回应报的会话编号。按块读、按行拆，不把整个文件读进内存。 */
function reportedSessions(rawFile: string): Set<string> {
  const found = new Set<string>();
  const look = (line: string) => {
    if (!line.includes("get_state")) return;
    const event = parsed(line);
    if (event?.type === "response" && event.command === "get_state" && typeof event.data?.sessionId === "string") found.add(event.data.sessionId);
  };
  let fd: number;
  try {
    fd = openSync(rawFile, "r");
  } catch {
    return found;
  }
  const chunk = Buffer.alloc(1 << 20);
  let rest = Buffer.alloc(0);
  try {
    for (;;) {
      const got = readSync(fd, chunk, 0, chunk.length, null);
      if (got === 0) break;
      let data = Buffer.concat([rest, chunk.subarray(0, got)]);
      let at = data.indexOf(10);
      while (at >= 0) {
        look(data.subarray(0, at).toString("utf-8"));
        data = data.subarray(at + 1);
        at = data.indexOf(10);
      }
      rest = Buffer.from(data);
    }
    if (rest.length) look(rest.toString("utf-8"));
  } catch {
    // 读到一半出错：用已经读到的
  } finally {
    closeSync(fd);
  }
  return found;
}

/** 收到时刻文件的首尾两个时刻；文件不在、是空的或者读不出时刻时是 null。 */
function receivedSpan(timesFile: string): [number, number] | null {
  let text: string;
  try {
    text = readFileSync(timesFile, "utf-8");
  } catch {
    return null;
  }
  const at = lines(text).map((line) => parsed(line)?.收到时刻).filter((value): value is number => typeof value === "number");
  return at.length ? [Math.min(...at), Math.max(...at)] : null;
}

/** 归档目录 pi-events 下的各组基名，按名字排。 */
export function groupsIn(archiveDir: string): string[] {
  try {
    return readdirSync(join(archiveDir, "pi-events"))
      .filter((name) => name.endsWith(".jsonl") && !name.endsWith(".backend.jsonl") && !name.endsWith(".times.jsonl"))
      .map((name) => name.slice(0, -".jsonl".length)).sort();
  } catch {
    return [];
  }
}

/** 一组归档是否属于这条会话：true 带，false 不带，字符串是判不出的原因。 */
export async function groupBelongs(archiveDir: string, group: string, sessionId: string, sessionTimes: readonly number[]): Promise<boolean | string> {
  const base = join(archiveDir, "pi-events", group);
  const starts = sessionStarts(`${base}.backend.jsonl`);
  if (starts.size > 0) return starts.has(sessionId);
  const reported = reportedSessions(`${base}.jsonl`);
  if (reported.size > 0) return reported.has(sessionId);
  const span = receivedSpan(`${base}.times.jsonl`);
  if (span === null) return OMITTED_NO_TIMES;
  if (sessionTimes.length === 0) return OMITTED_NO_SESSION_TIMES;
  const [from, to] = span;
  if (sessionTimes.some((at) => at >= from && at <= to)) return true;
  if (sessionTimes.some((at) => at >= from - EDGE_SECONDS && at <= to + EDGE_SECONDS)) return OMITTED_AT_EDGE;
  return false;
}

/** 这条会话涉及的归档组（带进包的）与判不出归属的组（不带，列出原因）。 */
export async function sessionGroups(archiveDir: string, sessionId: string, sessionTimes: readonly number[]): Promise<{ kept: string[]; omitted: OmittedGroup[] }> {
  const kept: string[] = [];
  const omitted: OmittedGroup[] = [];
  for (const group of groupsIn(archiveDir)) {
    const verdict = await groupBelongs(archiveDir, group, sessionId, sessionTimes);
    if (verdict === true) kept.push(group);
    else if (typeof verdict === "string") omitted.push({ group, reason: verdict });
  }
  return { kept, omitted };
}
