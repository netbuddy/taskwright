/**
 * 平台说明的能力模块：一份文件一个模块，放在 agent/prompts/capabilities/<能力>/<模块>.md。只读文件、不读库、不碰 pi。
 *
 * 平台说明按七项能力分目录（CAPABILITIES，目录名固定）：读、分析、整理、写、评审、对话、规划。每份模块文件开头两行 --- 之间
 * 是头，写法与活动的定义相同（一行一栏，「名字: 值」）：name 模块名（全目录不重）、order 拼装次序号（整数，全目录不重）、
 * when 进入条件。头去掉之后的正文拼进系统提示。同一条规矩只在一个模块里写，别处引用它写模块的小节名。
 *
 * when 的写法：几个选项用逗号隔开，任一满足就进；一个选项里几个条件用 & 连起来，要同时满足；条件前加 ! 是「不满足」。条件有六种：
 * - always：总是进。它只能单独写，不能与别的条件连用，也不能加 !。
 * - main=<资产>：这次会话的活动头的「写」一栏含这类资产（这是它的主要工作，给全文）。
 * - allowed=<写入的那一项>：获准能力表含这一项（page、problem、diagram、item、review、publish；给短说明）。
 * - reads=<资产>：活动头的「读」一栏含这一类；「读」写了 all 时，全部资产与知识库都算读。资产还可以写 knowledge（知识库）。
 * - mode=batch|dialogue：活动的方式。
 * - session=flow|single|idle：会话的位置：工作流的工作项（flow）、单项活动的工作项、空闲。
 * 比如「allowed=page & !main=description」：获准写页、而主要工作不是 description 这一类资产时进。
 *
 * 读不成就抛 PromptAssemblyError，调用方停下这次运行、不沿用任何旧的提示：目录里有不认的子目录或文件、头缺栏或取值不认、
 * 两份文件同名、两份文件次序号相同、调用方要的模块不在。次序号相同不按文件名排一个先后，而是报错：
 * 拼出来的先后只看次序号，与目录列出文件的先后无关。
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { ASSETS, type AssetKey, type Mode, READ_ALL, READ_KNOWLEDGE, type ReadKey, splitHead } from "./activity_def.ts";
import type { WriteKind } from "./stage.ts";

/** 七项能力，目录名。 */
export const CAPABILITIES = ["reading", "analysis", "organizing", "writing", "reviewing", "dialogue", "planning"] as const;
export type Capability = (typeof CAPABILITIES)[number];

/** 获准能力表里的写法：与 lib/stage.ts 的 WriteKind 是同一组写法。 */
export const WRITE_KINDS: readonly WriteKind[] = ["page", "problem", "diagram", "item", "review", "publish"];

/** 会话的三种位置。 */
export const SESSION_KINDS = ["flow", "single", "idle"] as const;
export type SessionKind = (typeof SESSION_KINDS)[number];

/** 拼系统提示时选不成、读不成的错：调用方据此停下这次运行并告诉用户。 */
export class PromptAssemblyError extends Error {}

/** 一个条件。always 只出现在单独的一个选项里。 */
export type Atom =
  | { kind: "always" }
  | { kind: "main"; value: AssetKey; negated: boolean }
  | { kind: "allowed"; value: WriteKind; negated: boolean }
  | { kind: "reads"; value: AssetKey | typeof READ_KNOWLEDGE; negated: boolean }
  | { kind: "mode"; value: Exclude<Mode, "user_only">; negated: boolean }
  | { kind: "session"; value: SessionKind; negated: boolean };

/** when 一栏：几个选项任一满足；一个选项里的条件都要满足。 */
export type When = Atom[][];

export interface PromptModule {
  name: string;
  capability: Capability;
  order: number;
  when: When;
  /** 相对 capabilities 目录的路径，例如 reading/materials.md。 */
  file: string;
  /** 去掉头之后的正文。 */
  body: string;
}

/** 这次会话的三样输入：活动头（方式、读、写）、获准能力表、会话的位置。 */
export interface Situation {
  mode: Exclude<Mode, "user_only">;
  reads: readonly ReadKey[];
  writes: readonly AssetKey[];
  allowed: readonly WriteKind[];
  session: SessionKind;
}

const READ_VALUES: readonly string[] = [...ASSETS, READ_KNOWLEDGE];

/** 读一个条件。file 是报错时说的文件名。 */
function parseAtom(raw: string, file: string): Atom {
  const text = raw.trim();
  const negated = text.startsWith("!");
  const body = negated ? text.slice(1).trim() : text;
  if (body === "always") {
    if (negated) throw new PromptAssemblyError(`${file} 的头里「when」写了「${text}」：always 前面不能加 !。`);
    return { kind: "always" };
  }
  const at = body.indexOf("=");
  const [key, value] = at > 0 ? [body.slice(0, at).trim(), body.slice(at + 1).trim()] : [body, ""];
  const bad = (allowed: readonly string[]) =>
    new PromptAssemblyError(`${file} 的头里「when」写了「${text}」：${key} 的值只能是 ${allowed.join("、")} 之一。`);
  switch (key) {
    case "main":
      if (!(ASSETS as readonly string[]).includes(value)) throw bad(ASSETS);
      return { kind: "main", value: value as AssetKey, negated };
    case "allowed":
      if (!(WRITE_KINDS as readonly string[]).includes(value)) throw bad(WRITE_KINDS);
      return { kind: "allowed", value: value as WriteKind, negated };
    case "reads":
      if (!READ_VALUES.includes(value)) throw bad(READ_VALUES);
      return { kind: "reads", value: value as AssetKey | typeof READ_KNOWLEDGE, negated };
    case "mode":
      if (value !== "batch" && value !== "dialogue") throw bad(["batch", "dialogue"]);
      return { kind: "mode", value, negated };
    case "session":
      if (!(SESSION_KINDS as readonly string[]).includes(value)) throw bad(SESSION_KINDS);
      return { kind: "session", value: value as SessionKind, negated };
    default:
      throw new PromptAssemblyError(`${file} 的头里「when」写了「${text}」：条件只能是 always、main=、allowed=、reads=、mode=、session= 之一。`);
  }
}

/** 读 when 一栏。 */
export function parseWhen(text: string, file: string): When {
  const options = text.split(/[,，]/).map((one) => one.trim());
  if (options.length === 0 || options.some((one) => one === "")) throw new PromptAssemblyError(`${file} 的头里「when」一栏是空的，或者有一个选项是空的。`);
  return options.map((option) => {
    const atoms = option.split("&").map((one) => parseAtom(one, file));
    if (atoms.length > 1 && atoms.some((one) => one.kind === "always")) {
      throw new PromptAssemblyError(`${file} 的头里「when」写了「${option}」：always 只能单独写。`);
    }
    return atoms;
  });
}

/** 一个条件在这次会话里成不成立。 */
function holds(atom: Atom, at: Situation): boolean {
  if (atom.kind === "always") return true;
  let yes: boolean;
  if (atom.kind === "main") yes = at.writes.includes(atom.value);
  else if (atom.kind === "allowed") yes = at.allowed.includes(atom.value);
  else if (atom.kind === "reads") yes = at.reads.includes(READ_ALL) || at.reads.includes(atom.value);
  else if (atom.kind === "mode") yes = at.mode === atom.value;
  else yes = at.session === atom.value;
  return atom.negated ? !yes : yes;
}

/** 这次会话该不该放这个模块。 */
export function wanted(when: When, at: Situation): boolean {
  return when.some((option) => option.every((atom) => holds(atom, at)));
}

/** 是不是 always 模块：只有一个选项、只有 always 一个条件。 */
export function isAlways(when: When): boolean {
  return when.length === 1 && when[0].length === 1 && when[0][0].kind === "always";
}

/** 读一份模块文件。 */
export function parseModule(text: string, capability: Capability, file: string): PromptModule {
  const { head, body } = splitHead(text);
  if (head === null) throw new PromptAssemblyError(`${file} 开头没有头（两行 --- 之间的那一段）。`);
  const name = head.name ?? "";
  if (!/^[a-z][a-z0-9_]*$/.test(name)) throw new PromptAssemblyError(`${file} 的头里「name」写的是「${name}」：只能是小写字母开头的字母、数字与下划线。`);
  const orderText = head.order ?? "";
  if (!/^\d+$/.test(orderText)) throw new PromptAssemblyError(`${file} 的头里「order」写的是「${orderText}」：只能是一个非负整数。`);
  if (head.when === undefined) throw new PromptAssemblyError(`${file} 的头里缺「when」一栏。`);
  const known = new Set(["name", "order", "when"]);
  const extra = Object.keys(head).filter((key) => !known.has(key));
  if (extra.length > 0) throw new PromptAssemblyError(`${file} 的头里有不认的栏：${extra.join("、")}。`);
  return { name, capability, order: Number(orderText), when: parseWhen(head.when, file), file, body: body.replace(/\s+$/, "") };
}

/** 读文件的两个动作；测试里换成别的。 */
export interface ModuleIo {
  /** 一个目录里的子目录与文件的名字；不在时返回 null。 */
  list(dir: string): { dirs: string[]; files: string[] } | null;
  read(path: string): string;
  /** 文件的修改时刻与大小，用来看变没变。 */
  stamp(path: string): string;
}

export const MODULE_IO: ModuleIo = {
  list(dir) {
    try {
      const entries = readdirSync(dir, { withFileTypes: true });
      return { dirs: entries.filter((one) => one.isDirectory()).map((one) => one.name), files: entries.filter((one) => !one.isDirectory()).map((one) => one.name) };
    } catch {
      return null;
    }
  },
  read: (path) => readFileSync(path, "utf-8"),
  stamp(path) {
    const found = statSync(path, { throwIfNoEntry: false });
    return found ? `${found.mtimeMs}:${found.size}` : "-";
  },
};

/**
 * 模块目录的指纹：每个能力目录下的文件清单与各文件的修改时刻和大小。新增、删除、改了任何一份，指纹就变。只查属性、不读内容。
 * 能力目录以外的东西也算进去（例如多出来的子目录），这样放错地方的文件同样让旧结果失效，下次读的时候报错。
 */
export function modulesStamp(dir: string, io: ModuleIo = MODULE_IO): string {
  const top = io.list(dir);
  if (top === null) return "absent";
  const parts: string[] = [`files:${[...top.files].sort().join("|")}`];
  for (const sub of [...top.dirs].sort()) {
    const inner = io.list(join(dir, sub));
    for (const name of [...(inner?.files ?? [])].sort()) parts.push(`${sub}/${name}@${io.stamp(join(dir, sub, name))}`);
    for (const name of [...(inner?.dirs ?? [])].sort()) parts.push(`${sub}/${name}/`);
  }
  return parts.join("\n");
}

/**
 * 读整个模块目录并校验。目录根上只许有七个能力目录（另可有一份 README.md）；能力目录里只许有 .md 文件。
 * 名字或次序号重了都报错。返回的模块按次序号排。
 */
export function loadModules(dir: string, io: ModuleIo = MODULE_IO): PromptModule[] {
  const top = io.list(dir);
  if (top === null) throw new PromptAssemblyError(`平台说明的模块目录不在：${dir}`);
  const strayFiles = top.files.filter((name) => name !== "README.md");
  if (strayFiles.length > 0) throw new PromptAssemblyError(`平台说明的模块目录根上有不认的文件：${strayFiles.sort().join("、")}。模块要放在能力目录里。`);
  const strayDirs = top.dirs.filter((name) => !(CAPABILITIES as readonly string[]).includes(name));
  if (strayDirs.length > 0) throw new PromptAssemblyError(`平台说明的模块目录里有不认的能力目录：${strayDirs.sort().join("、")}。能力目录只能是 ${CAPABILITIES.join("、")}。`);
  const modules: PromptModule[] = [];
  for (const capability of CAPABILITIES) {
    const inner = io.list(join(dir, capability));
    if (inner === null) continue;
    if (inner.dirs.length > 0) throw new PromptAssemblyError(`能力目录 ${capability} 里不能再有子目录：${inner.dirs.sort().join("、")}。`);
    for (const name of [...inner.files].sort()) {
      const file = `${capability}/${name}`;
      if (!name.endsWith(".md")) throw new PromptAssemblyError(`能力目录里只能放 .md 文件：${file}。`);
      modules.push(parseModule(io.read(join(dir, capability, name)), capability, file));
    }
  }
  const byName = new Map<string, string>();
  const byOrder = new Map<number, string>();
  for (const one of modules) {
    const sameName = byName.get(one.name);
    if (sameName) throw new PromptAssemblyError(`两份模块同名「${one.name}」：${sameName} 与 ${one.file}。`);
    byName.set(one.name, one.file);
    const sameOrder = byOrder.get(one.order);
    if (sameOrder) throw new PromptAssemblyError(`两份模块的次序号都是 ${one.order}：${sameOrder} 与 ${one.file}。次序号不能相同。`);
    byOrder.set(one.order, one.file);
  }
  return modules.sort((a, b) => a.order - b.order);
}

/** 要的模块都要在：缺了任何一份就报错。required 是模块名。 */
export function requireModules(modules: readonly PromptModule[], required: readonly string[]): void {
  const have = new Set(modules.map((one) => one.name));
  const missing = required.filter((name) => !have.has(name));
  if (missing.length > 0) throw new PromptAssemblyError(`平台说明缺了这几个模块：${missing.join("、")}。`);
}

/** 这次会话放哪几个模块：先 always 的，再有条件的，各按次序号。 */
export function selectModules(modules: readonly PromptModule[], at: Situation): PromptModule[] {
  const sorted = [...modules].sort((a, b) => a.order - b.order);
  return [...sorted.filter((one) => isAlways(one.when)), ...sorted.filter((one) => !isAlways(one.when) && wanted(one.when, at))];
}
