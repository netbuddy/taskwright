/**
 * 会话类：启动 pi 的 RPC 模式（pi 不画界面，改成按行收发 JSON：往它的标准输入写一行命令，它往标准输出写一行行事件），
 * 发命令，读事件，归档。它只做搬运与看护，不做判断：不写任务数据库，不解读用户说的话，不评价模型的产出。
 *
 * 归档写三个文件（格式见 observatory/archive-format.md，观测台按它读）：
 * - 原始事件流「<label>-<年月日>-<时分秒>.jsonl」：pi 标准输出的每一行，原样；
 * - 后端补记（同名，扩展名 .backend.jsonl）：pi 标准输出里没有的事实，每行 {"记录", "时刻", …}；
 * - 收到时刻（同名，扩展名 .times.jsonl）：原始事件流第 N 行是什么时候读到的，每行 {"行号", "收到时刻"}。
 */

import { type ChildProcess, spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, writeSync, writeFileSync } from "node:fs";
import { constants } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import * as launch from "./launch.ts";
import { localStamp, pyDumps } from "./py.ts";

/** 等一条命令的回应最多等这么久（毫秒）。超过就认为 pi 没反应。 */
export const RESPONSE_TIMEOUT = 60_000;
/** 等 pi 进程退干净最多等这么久（毫秒）。 */
export const SHUTDOWN_TIMEOUT = 10_000;
/** 需要我们回一个应答、否则 pi 会一直等下去的那几种界面请求。 */
export const DIALOG_METHODS = ["select", "confirm", "input", "editor"];
/** 进程内那个只读小扩展往外报事实时用的两个状态栏键名（agent/src/hooks/report_to_backend.ts）。 */
export const ACTIVE_TOOLS_STATUS_KEY = "taskwright-active-tools";
export const TURN_STATUS_KEY = "taskwright-turn";
/** 打开会话时扩展追加的任务现状消息的类型名，以及它经状态栏报给后端用的键名。 */
export const TASK_STATUS_CUSTOM_TYPE = "taskwright-task-status";
export const TASK_STATUS_REPORT_KEY = "taskwright-task-status";
/** 扩展写进会话的自定义消息转成的事件类型。 */
export const SYSTEM_NOTE_EVENT = "system_note";
/** 本服务的任务根目录，传给 pi 里的扩展：扩展写库前核对任务库在它之下。 */
export const TASKS_ROOT_ENV = "TASKWRIGHT_TASKS_ROOT";

export type PiEvent = Record<string, any>;

/** pi 进程没了。附上它的标准错误原文。 */
export class PiExited extends Error {
  readonly returncode: number | null;
  readonly stderr: string;
  constructor(returncode: number | null, stderr: string) {
    const tail = stderr.trim() || "（标准错误是空的，pi 什么也没说）";
    super(`pi 进程已经退出，退出码 ${returncode === null ? "None" : returncode}。它的标准错误是：\n${tail}`);
    this.returncode = returncode;
    this.stderr = stderr;
  }
}

/** pi 拒绝了一条命令（回应里 success 为假）。 */
export class PiRefused extends Error {}
/** 等一条命令的回应超时。 */
export class PiTimeout extends Error {}

const stampCompact = (at = new Date()) => localStamp(at).replace(/[-:]/g, "").replace("T", "-");

/**
 * 续接之前核对会话文件第一行记的工作目录：与本服务的任务目录不同时改写第一行，改写之前把原文件原样备份成
 * 「原名.cwd-时刻.bak」。一致、读不出或第一行不是会话头时什么都不做，返回 null；改写了返回 [原来记的目录, 备份文件]。
 */
export function rebaseSessionCwd(sessionFile: string, workspace: string): [string, string] | null {
  let text: string;
  try {
    text = readFileSync(sessionFile, "utf-8");
  } catch {
    return null;
  }
  const at = text.indexOf("\n");
  const first = at >= 0 ? text.slice(0, at) : text;
  const rest = at >= 0 ? text.slice(at) : "";
  let header: any;
  try {
    header = JSON.parse(first);
  } catch {
    return null;
  }
  if (!header || typeof header !== "object" || Array.isArray(header) || header.type !== "session" || typeof header.cwd !== "string") return null;
  const target = resolve(workspace);
  const old = header.cwd;
  if (old === target) return null;
  const backup = join(dirname(sessionFile), `${basename(sessionFile)}.cwd-${stampCompact()}.bak`);
  writeFileSync(backup, text, "utf-8");
  header.cwd = target;
  const temp = sessionFile + ".tmp";
  writeFileSync(temp, pyDumps(header) + rest, "utf-8");
  renameSync(temp, sessionFile);
  return [old, backup];
}

/** 一个先进先出的事件队列；get 可以带超时。 */
class EventQueue<T> {
  private items: T[] = [];
  private waiters: ((v: { value: T } | null) => void)[] = [];

  put(item: T): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value: item });
    else this.items.push(item);
  }

  get(timeoutMs?: number): Promise<{ value: T } | null> {
    if (this.items.length) return Promise.resolve({ value: this.items.shift()! });
    return new Promise((done) => {
      let timer: NodeJS.Timeout | undefined;
      const waiter = (v: { value: T } | null) => {
        if (timer) clearTimeout(timer);
        done(v);
      };
      this.waiters.push(waiter);
      if (timeoutMs !== undefined) {
        timer = setTimeout(() => {
          const i = this.waiters.indexOf(waiter);
          if (i >= 0) this.waiters.splice(i, 1);
          done(null);
        }, timeoutMs);
      }
    });
  }

  clear(): void {
    this.items = [];
  }
}

/** 退出码：被信号杀掉时写成负的信号编号（与 Python 的 returncode 相同）。 */
function exitCode(child: ChildProcess): number | null {
  if (child.exitCode !== null) return child.exitCode;
  if (child.signalCode) return -((constants.signals as Record<string, number>)[child.signalCode] ?? 0);
  return null;
}

const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));

/** 一个 pi 子进程加它的一条会话。 */
export class PiSession {
  readonly profile: launch.Profile;
  readonly tasksRoot: string | null;
  readonly workspace: string;
  readonly runsDir: string;
  readonly label: string;
  process: ChildProcess | null = null;
  command: string[] = [];
  /** 自动应答过的界面请求，每项是 [方法名, 标题, 我们回了什么]。 */
  readonly uiRequests: [string, string, string][] = [];
  /** 标准输出里出现过的、解析不成 JSON 的行。 */
  readonly badLines: string[] = [];
  /** 扩展写进会话的自定义消息转成的系统说明事件，按先后排。 */
  readonly systemNotes: PiEvent[] = [];
  private events = new EventQueue<PiEvent | null>();
  private responses = new Map<string, (message: PiEvent | null) => void>();
  private stderrLines: string[] = [];
  private counter = 0;
  private exited = false;
  private exitNoted = false;
  private archive: number | null = null;
  private notes: number | null = null;
  private times: number | null = null;
  private archivedLines = 0;
  archivePath: string | null = null;
  notesPath: string | null = null;
  timesPath: string | null = null;
  private stdoutDone: Promise<void> = Promise.resolve();
  private stderrDone: Promise<void> = Promise.resolve();
  private exitedPromise: Promise<void> = Promise.resolve();

  constructor(profile: launch.Profile, workspace: string, runsDir: string, label = "session", tasksRoot: string | null = null) {
    this.profile = profile;
    this.tasksRoot = tasksRoot !== null ? resolve(tasksRoot) : null;
    this.workspace = resolve(workspace);
    this.runsDir = resolve(runsDir);
    this.label = label;
  }

  // ───────────── 启动与关闭 ─────────────

  /** 启动 pi 子进程。给了 sessionFile 就让它接着那个会话文件往下跑。 */
  async start(sessionFile: string | null = null): Promise<void> {
    if (this.alive()) throw new Error("这个会话的 pi 进程还在跑，不要重复启动。");
    const sessionDir = join(this.runsDir, "pi-sessions", this.label);
    mkdirSync(sessionDir, { recursive: true });
    const eventsDir = join(this.runsDir, "pi-events");
    mkdirSync(eventsDir, { recursive: true });
    const rebased = sessionFile !== null ? rebaseSessionCwd(sessionFile, this.workspace) : null;
    const built = launch.buildCommand(this.profile, this.workspace, sessionDir, sessionFile);
    this.command = built.argv;
    const env = built.env;
    if (this.tasksRoot !== null) env[TASKS_ROOT_ENV] = this.tasksRoot;
    this.exitNoted = false;
    this.archivePath = join(eventsDir, `${this.label}-${stampCompact()}.jsonl`);
    this.archive = openSync(this.archivePath, "a");
    this.notesPath = this.archivePath.replace(/\.jsonl$/, ".backend.jsonl");
    this.notes = openSync(this.notesPath, "a");
    this.timesPath = this.archivePath.replace(/\.jsonl$/, ".times.jsonl");
    this.times = openSync(this.timesPath, "a");
    this.archivedLines = 0;
    this.exited = false;
    this.events = new EventQueue();
    this.responses = new Map();
    this.stderrLines = [];
    const knowledge = launch.knowledgeSnapshot(this.workspace, this.profile);
    const child = spawn(built.command, built.args, { cwd: this.workspace, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    this.process = child;
    const spawned = await new Promise<Error | null>((ok) => {
      child.once("spawn", () => ok(null));
      child.once("error", (error) => ok(error));
    });
    if (spawned) {
      this.process = null;
      this.closeFiles();
      throw spawned;
    }
    this.exitedPromise = new Promise((ok) => child.once("exit", () => ok()));
    // 往已经关掉的管道里写时 Node 会异步报 EPIPE；不接住会把整个服务带倒。写不进去由 write 按进程已退出处理。
    child.stdin?.on("error", () => {});
    if (rebased !== null) this.noteRebased(sessionFile!, ...rebased);
    this.note("启动", { ...launch.startupRecord(this.profile, this.command), 任务目录: this.workspace, 接回的会话文件: sessionFile ?? "",
      是不是重启接回: sessionFile !== null, 归档文件: basename(this.archivePath) });
    this.readStdout(child);
    this.readStderr(child);
    this.note("知识仓库摘要", { ...knowledge, 说明: "启动 pi 之前那一刻，任务目录知识仓库与平台 skill 里每份文件的路径与内容摘要值；只记摘要值，不记内容。" });
    this.note("上下文文件", launch.contextFileCandidates(this.command, this.workspace, env));
    await this.noteLoadedSkills();
  }

  /** 问 pi 这次实际加载了哪些 skill（RPC 的 get_commands 里来源是 skill 的那几项），记进后端补记。 */
  private async noteLoadedSkills(): Promise<void> {
    let data: PiEvent;
    try {
      data = await this.request("get_commands", {}, 30_000);
    } catch (error) {
      this.note("已加载的 skill", { 取得到吗: false, 为什么取不到: (error as Error).message, skill: [] });
      return;
    }
    const skills = (data.commands || []).filter((c: PiEvent) => c.source === "skill").map((c: PiEvent) => ({
      名字: String(c.name ?? "").replace(/^skill:/, ""), 描述: c.description ?? "", 文件: (c.sourceInfo || {}).path ?? "",
    }));
    this.note("已加载的 skill", { 取得到吗: true, 取法: "RPC 的 get_commands，来源是 skill 的那几项", skill: skills });
  }

  /** 关掉 pi 子进程：先关它的标准输入让它自己退，等不及就强杀。 */
  async close(): Promise<void> {
    const child = this.process;
    if (child === null) return;
    try {
      child.stdin?.end();
    } catch {
      // 已经关了
    }
    if (!(await this.waitExit(SHUTDOWN_TIMEOUT))) {
      child.kill("SIGKILL");
      await this.waitExit(SHUTDOWN_TIMEOUT);
    }
    await Promise.race([this.stderrDone, sleep(2000)]);
    this.noteExit(exitCode(child));
    this.closeFiles();
    this.process = null;
  }

  private async waitExit(ms: number): Promise<boolean> {
    const child = this.process;
    if (child === null || child.exitCode !== null || child.signalCode !== null) return true;
    return Promise.race([this.exitedPromise.then(() => true), sleep(ms).then(() => false)]);
  }

  private closeFiles(): void {
    for (const key of ["archive", "notes", "times"] as const) {
      const fd = this[key];
      if (fd !== null) {
        try {
          closeSync(fd);
        } catch {
          // 已经关了
        }
        this[key] = null;
      }
    }
  }

  private noteRebased(sessionFile: string, old: string, backup: string): void {
    const text = `会话文件记的工作目录是 ${old}，已按本服务的任务目录 ${this.workspace} 续接。`;
    console.log(`${basename(sessionFile)}：${text}`);
    this.note("续接工作目录", { 会话文件: basename(sessionFile), 会话文件记的工作目录: old, 按本服务的任务目录续接: this.workspace,
      原文件备份: basename(backup), 说明: text });
  }

  /** 让在跑的 pi 接上另一条会话文件；续接前同样核对并改写会话文件记的工作目录。 */
  async switchSession(sessionFile: string): Promise<PiEvent> {
    const rebased = rebaseSessionCwd(sessionFile, this.workspace);
    if (rebased !== null) this.noteRebased(sessionFile, ...rebased);
    return this.request("switch_session", { sessionPath: sessionFile });
  }

  /** 重启 pi；resume 为真时接回原来那条会话，返回接回的会话文件路径。 */
  async restart(resume = true): Promise<string | null> {
    let sessionFile: string | null = null;
    if (resume) {
      const state = await this.getState();
      sessionFile = state.sessionFile ? String(state.sessionFile) : null;
    }
    await this.close();
    await this.start(sessionFile);
    return sessionFile;
  }

  /** 往后端补记文件里写一行。写不进去也不能把会话带倒，所以这里把出错咽掉。 */
  note(kind: string, fields: Record<string, unknown> = {}): void {
    if (this.notes === null) return;
    try {
      writeSync(this.notes, pyDumps({ 记录: kind, 时刻: localStamp(), ...fields }) + "\n");
    } catch {
      // 写不进去就算了
    }
  }

  private noteReceived(lineNumber: number, received: number): void {
    if (this.times === null) return;
    const rounded = Math.round(received * 1000) / 1000;
    const text = Number.isInteger(rounded) ? rounded.toFixed(1) : String(rounded);
    try {
      writeSync(this.times, `{"行号": ${lineNumber}, "收到时刻": ${text}}\n`);
    } catch {
      // 写不进去就算了
    }
  }

  /** 记一条 pi 退出的补记。不管是谁先发现进程没了，都只记一次。 */
  private noteExit(code: number | null): void {
    if (this.exitNoted) return;
    this.exitNoted = true;
    this.note("退出", { 退出码: code, 标准错误: this.stderrText.trim() });
  }

  get stderrText(): string {
    return this.stderrLines.join("");
  }

  alive(): boolean {
    const child = this.process;
    return child !== null && child.exitCode === null && child.signalCode === null && !this.exited;
  }

  // ───────────── 读 pi 的两路输出 ─────────────

  private readStdout(child: ChildProcess): void {
    const reader = createInterface({ input: child.stdout!, crlfDelay: Infinity });
    this.stdoutDone = new Promise((ok) => {
      reader.on("line", (line) => this.onLine(line));
      reader.on("close", async () => {
        // 标准输出到头了，说明进程没了。先把退出码与标准错误记下来，再叫醒所有还在等的人。
        await Promise.race([this.stderrDone, sleep(2000)]);
        await Promise.race([this.exitedPromise, sleep(5000)]);
        this.noteExit(exitCode(child));
        this.exited = true;
        this.events.put(null);
        for (const resolveOne of [...this.responses.values()]) resolveOne(null);
        ok();
      });
    });
  }

  private readStderr(child: ChildProcess): void {
    const reader = createInterface({ input: child.stderr!, crlfDelay: Infinity });
    this.stderrDone = new Promise((ok) => {
      reader.on("line", (line) => {
        this.stderrLines.push(line + "\n");
        this.note("标准错误", { 文字: line });
      });
      reader.on("close", () => ok());
    });
  }

  private onLine(line: string): void {
    const received = Date.now() / 1000;
    if (this.archive !== null) {
      writeSync(this.archive, line + "\n");
      this.archivedLines += 1;
      this.noteReceived(this.archivedLines, received);
    }
    if (!line.trim()) return;
    let message: PiEvent;
    try {
      message = JSON.parse(line);
    } catch {
      this.badLines.push(line);
      this.events.put({ type: "非JSON行", line });
      return;
    }
    const kind = message?.type;
    if (kind === "response") {
      const slot = this.responses.get(String(message.id));
      if (slot) slot(message);
      else this.events.put(message);
    } else if (kind === "extension_ui_request") {
      this.answerUiRequest(message);
      if (message.method === "setStatus" && message.statusKey === TASK_STATUS_REPORT_KEY) {
        let reported: PiEvent = {};
        try {
          reported = JSON.parse(message.statusText || "{}");
        } catch {
          reported = {};
        }
        const note = { type: SYSTEM_NOTE_EVENT, custom_type: TASK_STATUS_CUSTOM_TYPE, text: reported.text ?? "", details: reported.details ?? null,
          entry_id: reported.entry_id ?? null, session_id: reported.session_id ?? null };
        this.systemNotes.push(note);
        this.note("扩展写入的消息", { 类型: TASK_STATUS_CUSTOM_TYPE, 文字: note.text, 会话条目编号: note.entry_id, 会话编号: note.session_id });
        this.events.put(note);
      }
    } else {
      this.events.put(message);
      let note = PiSession.systemNoteOf(message);
      // 任务现状消息一律以扩展经状态栏报来的那一份为准，免得会话中途换会话时记两次。
      if (note !== null && note.custom_type === TASK_STATUS_CUSTOM_TYPE) note = null;
      if (note !== null) {
        this.systemNotes.push(note);
        this.note("扩展写入的消息", { 类型: note.custom_type, 文字: note.text });
        this.events.put(note);
      }
    }
  }

  /** 扩展写进会话的自定义消息（message_end 事件，角色是 custom）转成一条系统说明事件；别的事件返回 null。 */
  static systemNoteOf(message: PiEvent): PiEvent | null {
    if (message.type !== "message_end") return null;
    const body = message.message || {};
    if (body.role !== "custom") return null;
    const content = body.content;
    const text = typeof content === "string" ? content
      : (content || []).filter((p: unknown) => typeof p === "object" && p !== null).map((p: PiEvent) => p.text ?? "").join("");
    return { type: SYSTEM_NOTE_EVENT, custom_type: String(body.customType || ""), text, details: body.details ?? null };
  }

  // ───────────── 自动应答界面请求 ─────────────

  /** 扩展要跟人交互时 pi 发界面请求并一直等着：一律回「取消」或「否」，好让会话不卡死；不需要应答的那几种只记录。 */
  private answerUiRequest(message: PiEvent): void {
    const method = String(message.method ?? "");
    const title = String(message.title ?? "");
    const statusKey = method === "setStatus" ? String(message.statusKey ?? "") : "";
    if (statusKey === TURN_STATUS_KEY || statusKey === ACTIVE_TOOLS_STATUS_KEY) {
      const raw = String(message.statusText ?? "");
      let fact: unknown = null;
      try {
        fact = JSON.parse(raw);
      } catch {
        fact = null;
      }
      if (statusKey === TURN_STATUS_KEY) {
        this.note("本轮事实", { 内容: fact, 原文: raw });
        this.events.put({ type: "本轮事实", 内容: fact });
      } else {
        this.note("实际工具清单", { 工具: fact, 原文: raw });
        this.events.put({ type: "实际工具清单", 工具: fact });
      }
      return;
    }
    if (!DIALOG_METHODS.includes(method)) {
      this.uiRequests.push([method, title, "不需要应答，只记录"]);
      this.note("界面请求应答", { 方法: method, 标题: title, 要不要应答: false, 回了什么: "不需要应答，只记录", 请求编号: message.id ?? null });
      const event: PiEvent = { type: "界面请求", method, title, answered: null };
      if (method === "setStatus") {
        event.status_key = statusKey;
        event.status_text = String(message.statusText ?? "");
      }
      this.events.put(event);
      return;
    }
    const [reply, answer] = method === "confirm"
      ? [{ type: "extension_ui_response", id: message.id ?? null, confirmed: false }, "回了「否」"]
      : [{ type: "extension_ui_response", id: message.id ?? null, cancelled: true }, "回了「取消」"];
    this.uiRequests.push([method, title, answer]);
    this.note("界面请求应答", { 方法: method, 标题: title, 要不要应答: true, 回了什么: answer, 请求编号: message.id ?? null });
    this.write(reply);
    this.events.put({ type: "界面请求", method, title, answered: answer });
  }

  // ───────────── 发命令 ─────────────

  private write(payload: unknown): void {
    const child = this.process;
    if (child === null || !child.stdin || child.stdin.destroyed || child.stdin.writableEnded || this.exited) {
      throw new PiExited(child ? exitCode(child) : null, this.stderrText);
    }
    child.stdin.write(pyDumps(payload) + "\n");
  }

  /** 发一条命令并等它的回应。回应里 success 为假时抛 PiRefused，带上 pi 给的原因。 */
  async request(command: string, fields: Record<string, unknown> = {}, timeoutMs = RESPONSE_TIMEOUT): Promise<PiEvent> {
    this.counter += 1;
    const id = `${this.label}-${this.counter}`;
    let timer: NodeJS.Timeout | undefined;
    const answer = new Promise<PiEvent | null | "timeout">((ok) => {
      this.responses.set(id, ok);
      timer = setTimeout(() => ok("timeout"), timeoutMs);
    });
    let message: PiEvent | null | "timeout";
    try {
      this.write({ id, type: command, ...fields });
      message = await answer;
    } finally {
      clearTimeout(timer);
      this.responses.delete(id);
    }
    if (message === "timeout") throw new PiTimeout(`等 pi 回应命令「${command}」等了 ${Math.round(timeoutMs / 1000)} 秒还没等到。`);
    if (message === null) throw new PiExited(this.process ? exitCode(this.process) : null, this.stderrText);
    if (!message.success) throw new PiRefused(`pi 拒绝了命令「${command}」：${message.error ?? "没有给原因"}`);
    return message.data || {};
  }

  /** 取下一条事件（常驻的任务服务一直在取）。超时返回 null；pi 进程没了时返回 {"type": "进程已退出"}。 */
  async nextEvent(timeoutMs?: number): Promise<PiEvent | null> {
    const got = await this.events.get(timeoutMs);
    if (got === null) return null;
    return got.value === null ? { type: "进程已退出" } : got.value;
  }

  getState(): Promise<PiEvent> {
    return this.request("get_state");
  }

  /** 把一句话发给 pi，逐条交出事件，直到这句话结束（agent_settled，之后用 get_state 确认没有卡在压缩里）。给测试与终端客户端用。 */
  async *send(text: string): AsyncGenerator<PiEvent> {
    if (!this.alive()) throw new PiExited(this.process ? exitCode(this.process) : null, this.stderrText);
    this.events.clear();
    this.note("提示", { 原文: text, 投递方式: "后端经 RPC 的 prompt 命令提交", 下一条请求编号: `${this.label}-${this.counter + 1}` });
    await this.request("prompt", { message: text });
    for (;;) {
      const got = await this.events.get();
      if (got === null || got.value === null) throw new PiExited(this.process ? exitCode(this.process) : null, this.stderrText);
      yield got.value;
      if (got.value.type === "agent_settled") break;
    }
    const state = await this.getState();
    if (state.isCompacting) {
      for (;;) {
        const got = await this.events.get();
        if (got === null || got.value === null) throw new PiExited(this.process ? exitCode(this.process) : null, this.stderrText);
        yield got.value;
        if (got.value.type === "compaction_end") break;
      }
    }
  }
}
