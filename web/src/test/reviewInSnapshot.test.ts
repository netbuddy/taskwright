// 整份数据里的进行中的评审（review_in_progress）：刷新页面之后立刻显示「评审中」；整份数据说没有进行中的评审时，
// 页面上还没结束的评审清掉（那一批已经结束，或者助手在评审中途退出了），已经结束的保持不动；早于 0.4 的后端没有这一项时不动。

import { describe, expect, it } from "vitest";
import type { ReviewInProgress, Snapshot, Task } from "../api/types";
import { initialWorkState, workReducer, type WorkState } from "../state/workState";

const SESSION = "s-1";

function task(): Task {
  return {
    task_id: "TASK-001", task_name: "演示任务", task_type: "演示", domain_tag: null, status: "进行中",
    started_at: "2026-09-21T10:00:00+08:00", ended_at: null,
    definition: { collections: [{ name: "用例", prefix: "UC", fields: [{ name: "名称", type: "文本", required: true, values: null }] }] },
    completion: null,
    items: [{ item_id: "UC-001", collection: "用例", title: "登录", revision_no: 1, revision_by: "executor", revision_at: "", revisions: [1],
              fields: { 名称: "登录" }, sources: [], reviews: [], confirmations: [], confirmation_stale: false }],
  };
}

/** review 不给时整份数据里没有这一项（早于 0.4 的后端）。 */
function snapshot(seq: number, review?: ReviewInProgress | null): Snapshot {
  return {
    seq, generated_at: "", executor: { state: "idle", text: "", active_session: SESSION },
    session: { session_id: SESSION, name: "会话", started_at: "", last_active_at: "" },
    task: task(), materials: [], conversation: { messages: [], has_earlier: false, earliest_id: null }, current_work: null,
    ...(review === undefined ? {} : { review_in_progress: review }),
  };
}

const progress = (seq: number, done: number, op = "ui-op-1") => ({
  type: "sse" as const, event: "review_progress",
  data: { seq, at: "", task_id: "TASK-001", op_id: op, done, total: 2, current: ["UC-001"], item_id: null, completion: null },
});
const finished = (seq: number) => ({
  type: "sse" as const, event: "review_finished",
  data: { seq, at: "", task_id: "TASK-001", op_id: "ui-op-1", total: 2, passed: 2, failed: 0, unfinished: 0, results: [], error: null, completion: null },
});

const run = (state: WorkState, ...actions: Parameters<typeof workReducer>[1][]) => actions.reduce(workReducer, state);
const fresh = () => initialWorkState(SESSION);
const running = (s: WorkState) => !!s.review && !s.review.finished;
const IN_PROGRESS: ReviewInProgress = { op_id: "ui-op-1", done: 1, total: 2, current: ["UC-001"] };

describe("整份数据里的进行中的评审", () => {
  it("刷新页面：整份数据里有进行中的评审，立刻显示评审中，进度照它", () => {
    const s = run(fresh(), { type: "snapshot", snapshot: snapshot(5, IN_PROGRESS) });
    expect(s.review).toEqual({ op_id: "ui-op-1", done: 1, total: 2, current: ["UC-001"], finished: null });
    expect(running(s)).toBe(true);
  });

  it("之后的进度与结束照常接上", () => {
    let s = run(fresh(), { type: "snapshot", snapshot: snapshot(5, IN_PROGRESS) });
    s = run(s, progress(6, 2));
    expect(s.review?.done).toBe(2);
    s = run(s, finished(7));
    expect(s.review?.finished).toEqual({ passed: 2, failed: 0, unfinished: 0, error: null });
    expect(running(s)).toBe(false);
  });

  it("为 null 而页面上的评审还没结束：清掉（例如助手在评审中途退出了）", () => {
    let s = run(fresh(), { type: "snapshot", snapshot: snapshot(5, IN_PROGRESS) });
    s = run(s, { type: "resync" }, { type: "snapshot", snapshot: snapshot(5, null) });
    expect(s.review).toBeNull();
  });

  it("为 null 而页面上的评审已经结束：保持不动，评审完了的提示照常", () => {
    let s = run(fresh(), { type: "snapshot", snapshot: snapshot(5, IN_PROGRESS) }, finished(6));
    s = run(s, { type: "resync" }, { type: "snapshot", snapshot: snapshot(6, null) });
    expect(s.review?.finished).toEqual({ passed: 2, failed: 0, unfinished: 0, error: null });
  });

  it("序号有缺口：攒着的开始进度被整份数据覆盖，照整份数据里的进度（比攒着的新）", () => {
    let s = run(fresh(), { type: "snapshot", snapshot: snapshot(3, null) }, progress(5, 0));
    expect(s.phase).toBe("waiting_snapshot");
    s = run(s, { type: "snapshot", snapshot: snapshot(6, IN_PROGRESS) });
    expect(s.review?.done).toBe(1);
    expect(running(s)).toBe(true);
  });

  it("序号有缺口：攒着进度与结束，整份数据为 null，停在结束上", () => {
    let s = run(fresh(), { type: "snapshot", snapshot: snapshot(3, null) }, finished(6), progress(5, 0));
    s = run(s, { type: "snapshot", snapshot: snapshot(6, null) });
    expect(s.review?.finished).not.toBeNull();
  });

  it("快照之后的进度照旧按一般规则应用，盖过整份数据里的", () => {
    let s = run(fresh(), { type: "snapshot", snapshot: snapshot(3, null) }, progress(5, 0), progress(7, 2));
    s = run(s, { type: "snapshot", snapshot: snapshot(6, IN_PROGRESS) });
    expect(s.seq).toBe(7);
    expect(s.review?.done).toBe(2);
  });

  it("整份数据里没有这一项（早于 0.4 的后端）：评审状态不动", () => {
    let s = run(fresh(), { type: "snapshot", snapshot: snapshot(5, IN_PROGRESS) });
    s = run(s, { type: "resync" }, { type: "snapshot", snapshot: snapshot(5) });
    expect(running(s)).toBe(true);
  });
});
