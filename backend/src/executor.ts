/**
 * 执行者看护：每个任务一个。它启动、续接、切换 pi 会话，一直读 pi 的事件流，拼成过程与对话类事件交给事件分发（hub），
 * 并把用户的话转交给 pi。它不写库，不解读用户的话。
 *
 * 同一任务同一时刻只有一条活动会话（pi 进程一次只接一条会话文件）：执行者在会话 A 里工作时，对会话 B 的请求返回 session_busy；
 * 空闲时切换会话即让 pi 接上另一条会话文件（RPC 的 switch_session）。
 * 对话严格轮替：执行者工作中收到说话，一律返回 session_busy（data.reason 为 working），不交给 pi 排队。
 */

import { randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { parseDefinition } from "../../agent/src/lib/task_read.ts";
import * as clock from "./clock.ts";
import * as conversation from "./conversation.ts";
import { ApiError } from "./errors.ts";
import { splitLines } from "./files.ts";
import type { Hub } from "./hub.ts";
import type { Profile } from "./launch.ts";
import { openRo } from "./library.ts";
import { type PiEvent, PiExited, PiRefused, PiSession, PiTimeout } from "./pi_session.ts";
import { or, truthy } from "./py.ts";
import { LABEL, Sessions } from "./sessions.ts";
import * as workSummary from "./work_summary.ts";

export const USER_RESULT_KEY = "taskwright-user-result";
export const UI_RESULT_KEY = "taskwright-ui-result";
/** 界面发起的评审在后台跑，每记一条事件经这个状态栏键提示一次。 */
export const REVIEW_STATUS_KEY = "taskwright-review";
export const WRITE_TOOLS = new Set(["save_revision", "create_task", "complete_task", "request_review"]);
export const REPLY_TOOL = "reply";
/** 用户消息的 message_end 到达时它可能还没写进会话记录：查不到就隔一会儿再取，最多这么多次，合计约半秒。 */
export const ENTRY_RETRIES = 10;
export const ENTRY_RETRY_DELAY = 50;
export const STATE_TEXT: Record<string, string> = {
  not_started: "助手还没有启动。",
  starting: "助手正在启动。",
  idle: "助手空闲，可以开始。",
  working: "助手正在做事。",
  exited: "助手已经退出，下一次说话时会重新启动。",
  failed_to_start: "助手没有启动起来。",
};

export function newId(prefix: string): string {
  return prefix + randomUUID().replaceAll("-", "").slice(0, 12);
}

/** 「先不管这条」之后发给执行者的固定模板。前缀用来把这句话认成界面操作之后发的话。 */
export const KEEP_PENDING_NOTICE_PREFIX = "我先不管 ";

const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));

/** 一把异步的锁：同一时刻只让一段代码进去，其余的排队。 */
class Mutex {
  private tail: Promise<void> = Promise.resolve();
  async run<T>(body: () => Promise<T> | T): Promise<T> {
    let release!: () => void;
    const next = new Promise<void>((ok) => (release = ok));
    const previous = this.tail;
    this.tail = previous.then(() => next);
    await previous;
    try {
      return await body();
    } finally {
      release();
    }
  }
}

type Dict = Record<string, any>;

interface Work {
  work_id: string;
  started: number;
  started_at: string;
  triggered_by: string | null;
  announced: boolean;
  steps: Map<string, Dict>;
  step_count: number;
  turn: number;
  turn_tools: Dict[];
  replied: boolean;
  stopped: boolean;
  failed: boolean;
  last_text: string | null;
  last_user_id: string | null;
  replied_since_user: boolean;
  understanding?: string | null;
}

export class Executor {
  readonly taskId: string;
  readonly taskDir: string;
  readonly runsDir: string;
  readonly profile: Profile;
  readonly hub: Hub;
  readonly sessions: Sessions;
  pi: PiSession | null = null;
  state = "not_started";
  detail = "";
  activeSession: string | null = null;
  private cursor: string | null = null;
  work: Work | null = null;
  readonly waiters = new Map<string, { resolve: (result: Dict) => void }>();
  /** （发给 pi 的原文, client_id），按先后。 */
  private pendingClients: [string, string | null][] = [];
  /** 发给 pi 的原文的开头 → origin（ui_request 之类）。 */
  readonly pendingOrigin = new Map<string, string>();
  private named = new Set<string>();
  private lastClick: Dict | null = null;
  private lastUserEntry: string | null = null;
  private readonly lock = new Mutex();

  constructor(taskId: string, taskDir: string, runsDir: string, profile: Profile, hub: Hub) {
    this.taskId = taskId;
    this.taskDir = taskDir;
    this.runsDir = runsDir;
    this.profile = profile;
    this.hub = hub;
    this.sessions = new Sessions(runsDir, taskId);
  }

  // ───────────── 会话文件 ─────────────

  listSessions() {
    const rows: Dict[] = this.sessions.list();
    const seen = new Set(rows.map((r) => r.session_id));
    // 刚新建、还没有助手消息的会话，pi 还没把文件写出来；活动会话照样列出来。
    if (this.activeSession && !seen.has(this.activeSession)) {
      rows.push({ session_id: this.activeSession, name: null, started_at: null, last_active_at: null, message_count: 0, active: false });
    }
    for (const row of rows) row.active = row.session_id === this.activeSession && this.running();
    return rows;
  }

  // ───────────── 状态 ─────────────

  running(): boolean {
    return this.pi !== null && this.pi.alive();
  }

  setState(state: string, detail = ""): void {
    this.state = state;
    this.detail = detail;
    this.hub.emit("executor_state", { state, text: (STATE_TEXT[state] ?? "") + (detail ? `（${detail}）` : ""), active_session: this.activeSession, at: clock.now() });
  }

  view() {
    const state = this.running() || ["not_started", "failed_to_start", "starting"].includes(this.state) ? this.state : "exited";
    return { state, text: STATE_TEXT[state] ?? "", active_session: this.activeSession };
  }

  // ───────────── 启动、续接、切换、新建（都在锁里调用） ─────────────

  private async startPi(sessionFile: string | null): Promise<void> {
    this.setState("starting");
    // 任务目录都在本服务的 --tasks 目录下；把它作为任务根目录传给 pi，扩展写库前核对任务库在它之下。
    const pi = new PiSession(this.profile, this.taskDir, join(this.runsDir, this.taskId), LABEL, dirname(resolve(this.taskDir)));
    let state: Dict;
    try {
      await pi.start(sessionFile);
      state = await pi.getState();
    } catch (error) {
      const detail = (pi.stderrText || (error as Error).message || String(error)).trim().slice(-500);
      try {
        await pi.close();
      } catch {
        // 关不掉也不影响报错
      }
      this.pi = null;
      this.setState("failed_to_start", detail);
      throw new ApiError("executor_unavailable", "助手现在不可用。", { detail });
    }
    this.pi = pi;
    this.adopt(state);
    this.cursor = null;
    void this.pumpLoop(pi);
    this.setState("idle");
  }

  private adopt(state: Dict): void {
    this.activeSession = state.sessionId ?? null;
    if (state.sessionFile && this.activeSession) this.sessions.remember(this.activeSession, String(state.sessionFile));
  }

  private async openLocked(sessionId: string): Promise<void> {
    if (this.state === "starting") throw new ApiError("executor_starting", "助手正在启动，请稍候。");
    if (this.running() && this.activeSession === sessionId) return;
    const path = this.sessions.file(sessionId);
    if (!path || !this.sessions.isFile(path)) throw new ApiError("not_found", `这个任务里没有会话 ${sessionId}。`);
    if (!this.running()) {
      await this.startPi(path);
      return;
    }
    this.busyCheck(sessionId);
    await this.pi!.switchSession(path);
    this.adopt(await this.pi!.getState());
    this.cursor = null;
    this.setState("idle");
  }

  /** 打开一条会话：pi 没在跑就启动并续接它；在跑、接着别的会话、并且空闲时切过去；正在工作时返回 session_busy。 */
  openSession(sessionId: string): Promise<void> {
    return this.lock.run(() => this.openLocked(sessionId));
  }

  newSession(): Promise<string | null> {
    return this.lock.run(async () => {
      if (this.state === "starting") throw new ApiError("executor_starting", "助手正在启动，请稍候。");
      if (!this.running()) {
        await this.startPi(null);
      } else {
        this.busyCheck(null);
        await this.pi!.request("new_session");
        this.adopt(await this.pi!.getState());
        this.cursor = null;
        this.setState("idle");
      }
      return this.activeSession;
    });
  }

  private busyCheck(sessionId: string | null): void {
    if (this.state === "working" && this.activeSession !== sessionId) {
      throw new ApiError("session_busy", "助手正在另一条会话里工作，做完才能在这里继续。", { active_session: this.activeSession });
    }
  }

  /** 说话之前：会话要是活动的那条；start 为真时 pi 不在就按需启动，否则失败。 */
  require(sessionId: string | null, start: boolean): Promise<void> {
    return this.lock.run(async () => {
      if (this.state === "starting") throw new ApiError("executor_starting", "助手正在启动，请稍候。");
      if (!this.running()) {
        if (!start) {
          throw new ApiError("executor_unavailable", "助手现在不可用，界面操作要在助手启动之后才能做。", { detail: this.detail || "pi 没有在跑" });
        }
        if (sessionId) await this.openLocked(sessionId);
        else await this.startPi(null);
        return;
      }
      if (sessionId && sessionId !== this.activeSession) {
        this.busyCheck(sessionId);
        await this.openLocked(sessionId);
      }
    });
  }

  close(): Promise<void> {
    return this.lock.run(async () => {
      if (this.pi !== null) {
        const pi = this.pi;
        this.pi = null;
        await pi.close();
      }
      this.setState("exited");
    });
  }

  // ───────────── 说话 ─────────────

  private turnCheck(): void {
    if (this.state === "working") {
      throw new ApiError("session_busy", "助手正在工作，这一轮做完之后才能发下一句。你可以先把话打好。",
        { active_session: this.activeSession, reason: "working" });
    }
  }

  /**
   * 把用户的一句话交给 pi。执行者正在工作时返回 session_busy（对话严格轮替），所以返回值恒为假（没有排队）。
   * text 是发给 pi 的文字；它与用户原来打的字不同时（斜杠改写、附上材料路径），两者都记进归档的后端补记。
   */
  async say(sessionId: string | null, text: string, clientId: string | null, original: string | null = null): Promise<boolean> {
    await this.require(sessionId, true);
    await this.lock.run(async () => {
      this.turnCheck();
      if (original !== null && original !== text) {
        this.pi!.note("提示改写", { 原文: original, 改写后: text, 依据: "docs/api.md §5.1：斜杠开头加「用户说：」；附件按第 7 节模板附上路径" });
      }
      this.pendingClients.push([text, clientId]);
      try {
        await this.pi!.request("prompt", { message: text });
      } catch (error) {
        if (error instanceof PiExited || error instanceof PiRefused) throw new ApiError("executor_unavailable", "助手现在不可用。", { detail: error.message });
        throw error;
      }
    });
    return false;
  }

  // ───────────── 对话记录 ─────────────

  /** 一条会话的全部条目：pi 在跑且接着它时用 get_entries，否则直接读会话文件。 */
  async entries(sessionId: string): Promise<Dict[]> {
    const fromPi = await this.lock.run(async () => {
      if (this.running() && this.activeSession === sessionId) {
        try {
          return [...((await this.pi!.request("get_entries")).entries || [])];
        } catch (error) {
          if (!(error instanceof PiExited || error instanceof PiRefused || error instanceof PiTimeout)) throw error;
        }
      }
      return null;
    });
    return fromPi ?? this.sessions.entries(sessionId);
  }

  currentWork(sessionId: string) {
    const work = this.work;
    if (!work || this.activeSession !== sessionId) return null;
    return { work_id: work.work_id, started_at: work.started_at, triggered_by: work.triggered_by, steps: [...work.steps.values()] };
  }

  // ───────────── 读 pi 事件流 ─────────────

  private async pumpLoop(pi: PiSession): Promise<void> {
    for (;;) {
      const event = await pi.nextEvent(1000);
      if (event === null) {
        if (!pi.alive()) break;
        continue;
      }
      if (event.type === "进程已退出") break;
      try {
        await this.handle(pi, event);
      } catch (error) {
        // 一条事件拼坏了不能让整个看护停下
        pi.note("任务服务拼事件出错", { 事件类型: event.type ?? null, 原因: (error as Error).message });
      }
    }
    await this.lock.run(() => {
      if (this.pi === pi) {
        this.pi = null;
        this.setState("exited", "pi 进程退出了");
      }
    });
  }

  private async fetchNewEntries(pi: PiSession): Promise<Dict[]> {
    let data: Dict;
    try {
      data = this.cursor ? await pi.request("get_entries", { since: this.cursor }) : await pi.request("get_entries");
    } catch (error) {
      if (!(error instanceof PiExited || error instanceof PiRefused || error instanceof PiTimeout)) throw error;
      data = await pi.request("get_entries");
    }
    const entries = [...((data || {}).entries || [])];
    if (entries.length) this.cursor = entries[entries.length - 1].id;
    return entries;
  }

  private async fetchAllEntries(pi: PiSession): Promise<Dict[]> {
    return [...((await pi.request("get_entries")).entries || [])];
  }

  private async handle(pi: PiSession, event: PiEvent): Promise<void> {
    const kind = event.type;
    const sid = this.activeSession;
    if (kind === "agent_start") {
      if (this.work === null) {
        this.work = { work_id: newId("work-"), started: Date.now() / 1000, started_at: clock.now(), triggered_by: null, announced: false, steps: new Map(),
          step_count: 0, turn: 0, turn_tools: [], replied: false, stopped: false, failed: false, last_text: null, last_user_id: null, replied_since_user: true };
        this.setState("working");
      }
      return;
    }
    if (kind === "本轮事实") {
      const fact = event["内容"] || {};
      if (this.work !== null && Number.isInteger(fact.turnIndex)) this.work.turn = fact.turnIndex;
      return;
    }
    if (kind === "turn_start") {
      if (this.work !== null) this.work.turn_tools = [];
      return;
    }
    if (kind === "message_end") return this.messageEnd(pi, event.message || {}, sid);
    if (kind === "tool_execution_start") {
      this.announceWork(sid);
      this.toolStart(event, sid);
      return;
    }
    if (kind === "tool_execution_end") return this.toolEnd(event, sid);
    if (kind === "turn_end") return this.turnEnd(sid);
    if (kind === "auto_retry_start") {
      this.hub.emit("problem", { session_id: sid, code: "model_unavailable", text: `模型服务暂时不可用，正在第 ${event.attempt ?? "None"} 次重试。`,
        retry: { attempt: event.attempt ?? null, delay_ms: event.delayMs ?? null } });
      return;
    }
    if (kind === "agent_settled") return this.settled(pi, sid);
    if (kind === "system_note") {
      // 只有任务现状消息算系统说明；界面操作的通知已经在 message_end 里转成 ui_action_noted。
      if (event.custom_type !== conversation.TASK_STATUS) return;
      this.hub.emit("system_note", { session_id: event.session_id || sid, message_id: event.entry_id ?? null, at: clock.now(), text: event.text ?? "" });
      return;
    }
    if (kind === "界面请求" && event.method === "setStatus") {
      const key = event.status_key;
      if (key === REVIEW_STATUS_KEY) {
        this.hub.trigger();
        return;
      }
      if (key === USER_RESULT_KEY || key === UI_RESULT_KEY) {
        let result: Dict = {};
        try {
          result = JSON.parse(event.status_text || "{}");
        } catch {
          result = {};
        }
        this.waiters.get(result.op_id || "")?.resolve(result);
        if (key === USER_RESULT_KEY && result.ok) this.hub.trigger();
      }
    }
  }

  private announceWork(sid: string | null): void {
    const work = this.work;
    if (work !== null && !work.announced) {
      work.announced = true;
      this.hub.emit("work_started", { session_id: sid, work_id: work.work_id, at: work.started_at, triggered_by: work.triggered_by });
    }
  }

  private static userEntry(entries: Dict[], raw: string): Dict | null {
    return [...entries].reverse().find((e) => e.type === "message" && (e.message || {}).role === "user"
      && conversation.textOf((e.message || {}).content ?? null) === raw) ?? null;
  }

  private async messageEnd(pi: PiSession, message: Dict, sid: string | null): Promise<void> {
    const role = message.role;
    if (role === "user" && conversation.textOf(message.content ?? null) === conversation.FALLBACK_TEXT) {
      // 兜底扩展追加的那句固定文字：转成 system_note，不当作用户的话。
      const raw = conversation.FALLBACK_TEXT;
      const entries = await this.fetchNewEntries(pi);
      const hit = Executor.userEntry(entries, raw);
      this.hub.emit("system_note", { session_id: sid, message_id: hit ? hit.id ?? null : null, at: clock.now(), text: conversation.fallbackNoteText(raw) });
      return;
    }
    if (role === "user") {
      const raw = conversation.textOf(message.content ?? null);
      let entries = await this.fetchNewEntries(pi);
      let hit = Executor.userEntry(entries, raw);
      // 按「上次取到的位置之后」没找到时，到全部条目里找；这句话也可能还没写进会话记录，那就隔一会儿再取，最多约半秒。
      // 只在上一次认过的那条用户消息之后找，免得认回更早说过的同一句话。
      for (let attempt = 0; hit === null && attempt <= ENTRY_RETRIES; attempt++) {
        if (attempt) await sleep(ENTRY_RETRY_DELAY);
        let everything: Dict[];
        try {
          everything = await this.fetchAllEntries(pi);
        } catch (error) {
          if (error instanceof PiExited || error instanceof PiRefused || error instanceof PiTimeout) break;
          throw error;
        }
        const ids = everything.map((e) => e.id);
        const start = this.lastUserEntry !== null && ids.includes(this.lastUserEntry) ? ids.indexOf(this.lastUserEntry) + 1 : 0;
        hit = Executor.userEntry(everything.slice(start), raw);
        if (hit !== null) entries = everything;
      }
      if (hit !== null) this.lastUserEntry = hit.id ?? null;
      let click: Dict | null = [...entries].reverse().find((e) => e.type === "custom_message" && e.customType === conversation.UI_CLICK
        && (e.details || {}).text === raw) ?? null;
      if (click === null && this.lastClick && (this.lastClick.details || {}).text === raw) click = this.lastClick;
      this.lastClick = null;
      let clientId: string | null = null;
      const n = this.pendingClients.findIndex(([text]) => text === raw);
      if (n >= 0) {
        clientId = this.pendingClients[n][1];
        this.pendingClients.splice(n, 1);
      }
      let origin = "typed";
      let annotation: Dict | null = null;
      if (click !== null) {
        const d = click.details || {};
        origin = "card_choice";
        annotation = { reply_message_id: d.reply_entry ?? null, option_key: d.option_key ?? null, option_text: d.option_text ?? null, click_message_id: click.id ?? null };
      } else if ([...this.pendingOrigin.keys()].some((p) => raw.startsWith(p))) {
        origin = "ui_request";
      }
      const messageId = hit ? hit.id ?? null : null;
      this.hub.emit("user_message", { session_id: sid, message_id: messageId, at: clock.now(), text: conversation.displayText(raw), origin, annotation,
        queued: false, client_id: clientId });
      const work = this.work;
      if (work !== null) {
        if (work.triggered_by === null) {
          work.triggered_by = messageId;
          // 工作编号改用触发它的那句话的会话条目编号，与刷新后从会话文件算出的编号一致；推出去之后编号不再变。
          if (messageId && !work.announced) work.work_id = `w-${messageId}`;
        }
        work.last_user_id = messageId;
        work.understanding = null;
        work.replied_since_user = false;
        work.last_text = null;
        this.announceWork(sid);
      }
      if (sid && !this.named.has(sid) && raw.trim()) await this.maybeName(pi, sid, conversation.displayText(raw));
      return;
    }
    if (role === "custom") {
      const ctype = message.customType;
      if (ctype === conversation.USER_EDIT) {
        const entries = await this.fetchNewEntries(pi);
        const hit = [...entries].reverse().find((e) => e.type === "custom_message" && e.customType === ctype) ?? null;
        const details = message.details || {};
        const seqs = details.event_seqs || [];
        this.hub.emit("ui_action_noted", { session_id: sid, message_id: hit ? hit.id ?? null : null, at: clock.now(),
          text: conversation.textOf(message.content ?? null), event_seq: seqs.length ? seqs[0] : null, undoable: truthy(details.undoable),
          op_id: details.op_id ?? null, revision_no: details.revision_no ?? null, kind: details.kind ?? null, review: details.review ?? null });
      } else if (ctype === conversation.UI_CLICK) {
        const entries = await this.fetchNewEntries(pi);
        const hit = [...entries].reverse().find((e) => e.type === "custom_message" && e.customType === ctype) ?? null;
        this.lastClick = { id: hit ? hit.id ?? null : null, details: message.details || {} };
      }
      return;
    }
    if (role === "assistant" && this.work !== null) {
      this.understandingStep(sid);
      const text = conversation.textOf(message.content ?? null).trim();
      const calls = (message.content || []).filter((p: unknown) => typeof p === "object" && p !== null && (p as Dict).type === "toolCall");
      if (message.stopReason === "error") this.work.failed = true;
      if (text && !calls.length) this.work.last_text = text;
    }
  }

  /** 助手消息落进会话时，把执行者对这句话的理解推成这次工作的第一行步骤「理解为：……」。 */
  private understandingStep(sid: string | null): void {
    const work = this.work!;
    const userId = work.last_user_id || work.triggered_by;
    if (!userId) return;
    const lines = sid ? workSummary.understandingLines(this.taskDir, sid) : new Map<string, string | null>();
    if (!lines.has(userId) || lines.get(userId) === null || lines.get(userId) === work.understanding) return;
    const text = lines.get(userId)!;
    work.understanding = text;
    const key = `${work.work_id}-intent`;
    const step = { session_id: sid, work_id: work.work_id, step_key: key, text, in_progress: workSummary.INTENT_IN_PROGRESS_TEXTS.includes(text), failed: false };
    const rest = [...work.steps].filter(([k]) => k !== key);
    work.steps = new Map([[key, step], ...rest]);
    this.hub.emit("step", step);
  }

  /** 工作结束时推一条过程摘要：从会话条目里切出这次工作，与刷新后从会话文件重算的是同一个函数。 */
  private async emitSummary(pi: PiSession, sid: string | null, work: Work): Promise<void> {
    const userId = work.last_user_id || work.triggered_by;
    if (!userId) return;
    let path: Dict[];
    try {
      path = conversation.branch(await this.fetchAllEntries(pi));
    } catch (error) {
      if (error instanceof PiExited || error instanceof PiRefused || error instanceof PiTimeout) return;
      throw error;
    }
    const found = workSummary.worksFromEntries(path, this.definition(), conversation.FALLBACK_TEXT, conversation.textOf).find((w) => w.user_message_id === userId);
    if (!found) return;
    const understanding = sid ? workSummary.understandingLines(this.taskDir, sid).get(userId) ?? null : null;
    this.hub.emit("work_summary", { session_id: sid, work_id: work.work_id, at: found.at, seconds: found.seconds, step_count: found.step_count,
      stages: found.stages, understanding });
  }

  /** 会话名按第一句用户的话自动起（RPC 的 set_session_name）。 */
  private async maybeName(pi: PiSession, sid: string, text: string): Promise<void> {
    this.named.add(sid);
    try {
      const state = await pi.getState();
      if (!state.sessionName) await pi.request("set_session_name", { name: [...(splitLines(text.trim())[0] ?? "")].slice(0, 24).join("") });
    } catch (error) {
      if (!(error instanceof PiExited || error instanceof PiRefused || error instanceof PiTimeout)) throw error;
    }
  }

  private definition(): Dict {
    const db = (() => {
      try {
        return openRo(this.taskDir);
      } catch {
        return null;
      }
    })();
    if (db === null) return {};
    try {
      const row = db.prepare("SELECT definition_text FROM task LIMIT 1").get() as Dict | undefined;
      return row ? parseDefinition(row.definition_text) : {};
    } catch {
      return {};
    } finally {
      db.close();
    }
  }

  private stepText(tool: string, args: Dict, done: boolean, failed: boolean, details: Dict | null): string {
    return workSummary.stepText(tool, args, done, failed, details, this.definition());
  }

  private toolStart(event: PiEvent, sid: string | null): void {
    const work = this.work;
    if (work === null) return;
    const tool = event.toolName || "";
    work.turn_tools.push({ id: event.toolCallId ?? null, tool, args: event.args || {}, done: false, failed: false, details: null });
    work.step_count += 1;
    const key = `${work.work_id}-${work.turn}`;
    const step = { session_id: sid, work_id: work.work_id, step_key: key, text: this.stepText(tool, event.args || {}, false, false, null), in_progress: true, failed: false };
    work.steps.set(key, step);
    this.hub.emit("step", step);
  }

  private toolEnd(event: PiEvent, sid: string | null): void {
    const work = this.work;
    const tool = event.toolName || "";
    const failed = truthy(event.isError);
    const result = event.result || {};
    let details: Dict = result.details || {};
    // 保存修订被拒时原因只在结果正文里，先拆出来，实时的 step 行与过程摘要同一个写法。
    if (failed && tool === "save_revision") details = { ...details, reasons: workSummary.rejectionParts(details, workSummary.resultText(result)) };
    if (work !== null) {
      for (const t of work.turn_tools) if (t.id === (event.toolCallId ?? null)) Object.assign(t, { done: true, failed, details });
    }
    if (WRITE_TOOLS.has(tool) && !failed) this.hub.trigger();
    if (tool === REPLY_TOOL && !failed) {
      const reply = details.reply || {};
      if (work !== null) {
        work.replied = true;
        work.replied_since_user = true;
      }
      this.hub.emit("assistant_reply", { session_id: sid, message_id: details.message_id ?? null, at: clock.now(), work_id: work ? work.work_id : null,
        via_reply_tool: true, informs: conversation.normalizeInforms(reply.informs ?? null), act: reply.act ?? null, text: or(reply.text, ""),
        degraded: truthy(details.degraded) });
    }
  }

  private turnEnd(sid: string | null): void {
    const work = this.work;
    if (work === null || !work.turn_tools.length) return;
    const key = `${work.work_id}-${work.turn}`;
    const texts = work.turn_tools.map((t) => this.stepText(t.tool, t.args, true, t.failed, t.details));
    const step = { session_id: sid, work_id: work.work_id, step_key: key, text: texts.join("；"), in_progress: false, failed: work.turn_tools.some((t) => t.failed) };
    work.steps.set(key, step);
    this.hub.emit("step", step);
  }

  private async settled(pi: PiSession, sid: string | null): Promise<void> {
    const work = this.work;
    if (work === null) return;
    try {
      if ((await pi.getState()).isCompacting) return;
    } catch (error) {
      if (!(error instanceof PiExited || error instanceof PiRefused || error instanceof PiTimeout)) throw error;
    }
    if (!work.replied_since_user) {
      // 兜底：这段话之后没有一次被接受的「回复」。转发最后一条助手正文；正文也没有就发 problem。
      if (work.last_text) {
        const entries = await this.fetchNewEntries(pi);
        const hit = [...entries].reverse().find((e) => e.type === "message" && (e.message || {}).role === "assistant") ?? null;
        this.hub.emit("assistant_reply", { session_id: sid, message_id: hit ? hit.id ?? null : null, at: clock.now(), work_id: work.work_id,
          via_reply_tool: false, informs: [], act: null, text: work.last_text });
      } else if (!work.stopped) {
        this.hub.emit("problem", { session_id: sid, code: "no_reply", text: "助手这次没有说话就停下了，你可以再问它一句。", retry: null });
      }
    }
    await this.emitSummary(pi, sid, work);
    const outcome = work.stopped ? "stopped_by_user" : work.failed ? "failed" : work.replied ? "replied" : "no_reply";
    this.hub.emit("work_ended", { session_id: sid, work_id: work.work_id, at: clock.now(), seconds: workSummary.round1(Date.now() / 1000 - work.started),
      step_count: work.step_count, outcome });
    this.work = null;
    this.pendingOrigin.clear();
    this.setState("idle");
    this.hub.trigger();
  }
}
