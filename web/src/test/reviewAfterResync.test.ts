// 序号有缺口而重读整份数据时，攒着的评审进度与评审结束照样设置评审状态；别的攒着的事件照旧按快照序号跳过，
// 序号不往回拨，完成条件以整份数据为准。

import { describe, expect, it } from "vitest";
import type { Completion, Snapshot, Task } from "../api/types";
import { initialWorkState, workReducer, type WorkState } from "../state/workState";

const SESSION = "s-1";

function task(completion: Completion | null = null): Task {
  return {
    task_id: "TASK-001", task_name: "演示任务", task_type: "演示", domain_tag: null, status: "进行中",
    started_at: "2026-09-21T10:00:00+08:00", ended_at: null,
    definition: { collections: [{ name: "用例", prefix: "UC", fields: [{ name: "名称", type: "文本", required: true, values: null }] }] },
    completion,
    items: [{ item_id: "UC-001", collection: "用例", title: "登录", revision_no: 1, revision_by: "executor", revision_at: "", revisions: [1],
              fields: { 名称: "登录" }, sources: [], reviews: [], confirmations: [], confirmation_stale: false }],
  };
}

function snapshot(seq: number, completion: Completion | null = null): Snapshot {
  return {
    seq, generated_at: "", executor: { state: "idle", text: "", active_session: SESSION },
    session: { session_id: SESSION, name: "会话", started_at: "", last_active_at: "" },
    task: task(completion), materials: [], conversation: { messages: [], has_earlier: false, earliest_id: null }, current_work: null,
  };
}

const FRESH = { state: "unmet", conditions: [] } as unknown as Completion;
const OLD = { state: "met", conditions: [] } as unknown as Completion;

const progress = (seq: number, done: number, completion: Completion | null = null) => ({
  type: "sse" as const, event: "review_progress",
  data: { seq, at: "", task_id: "TASK-001", op_id: "ui-op-1", done, total: 1, current: done ? [] : ["UC-001"], item_id: null, completion },
});
const finished = (seq: number) => ({
  type: "sse" as const, event: "review_finished",
  data: { seq, at: "", task_id: "TASK-001", op_id: "ui-op-1", total: 1, passed: 1, failed: 0, unfinished: 0, results: [], error: null, completion: null },
});
const changed = (seq: number) => ({
  type: "sse" as const, event: "deliverable_changed",
  data: { seq, at: "", task_id: "TASK-001", revision_no: 2, actor: "user", op_id: `ui-op-${seq}`, undo_of_revision: null, completion: null,
          operations: [{ op: "update", collection: "用例", item_id: "UC-001", title: "旧的改动", revision_before: 1, revision_after: 2,
                         fields: { 名称: "旧的改动" }, sources: [] }] },
});

const run = (state: WorkState, ...actions: Parameters<typeof workReducer>[1][]) => actions.reduce(workReducer, state);
/** 页面停在第 3 号：第 4 号（回复时记下的行为）不转发，下一条就带着缺口。 */
const atThree = () => run(initialWorkState(SESSION), { type: "snapshot", snapshot: snapshot(3) });
const running = (s: WorkState) => !!s.review && !s.review.finished;

describe("重读整份数据之后，攒着的评审进度与评审结束照样应用", () => {
  it("序号有缺口：开始的那条进度（done 为 0）被攒着，重读之后评审状态是进行中", () => {
    let s = run(atThree(), progress(5, 0));
    expect(s.phase).toBe("waiting_snapshot");
    s = run(s, { type: "snapshot", snapshot: snapshot(5) });
    expect(s.phase).toBe("ready");
    expect(s.review).toEqual({ op_id: "ui-op-1", done: 0, total: 1, current: ["UC-001"], finished: null });
    expect(running(s)).toBe(true);
  });

  it("攒着进度与结束两条（乱序到达）：按序号应用，停在结束上，评审不再算进行中", () => {
    let s = run(atThree(), finished(7), progress(5, 0), progress(6, 1));
    s = run(s, { type: "snapshot", snapshot: snapshot(7) });
    expect(s.review?.finished).toEqual({ passed: 1, failed: 0, unfinished: 0, error: null });
    expect(running(s)).toBe(false);
  });

  it("攒着两条进度：停在较新的那条上", () => {
    let s = run(atThree(), progress(6, 1), progress(5, 0));
    s = run(s, { type: "snapshot", snapshot: snapshot(6) });
    expect(s.review?.done).toBe(1);
  });

  it("别的种类的攒着的事件，序号不大于快照序号的，照旧跳过", () => {
    let s = run(atThree(), changed(5), progress(6, 0));
    s = run(s, { type: "snapshot", snapshot: snapshot(6) });
    expect(s.task!.items[0].title).toBe("登录");
    expect(s.task!.items[0].revision_no).toBe(1);
    expect(running(s)).toBe(true);
  });

  it("序号不往回拨：快照序号比攒着的评审进度大时，页面的序号是快照的", () => {
    let s = run(atThree(), progress(5, 0));
    s = run(s, { type: "snapshot", snapshot: snapshot(8) });
    expect(s.seq).toBe(8);
    expect(running(s)).toBe(true);
    s = run(s, changed(9));
    expect(s.seq).toBe(9);
    expect(s.phase).toBe("ready");
  });

  it("完成条件以整份数据为准，不用攒着的评审进度带的旧值", () => {
    let s = run(atThree(), progress(5, 0, OLD));
    s = run(s, { type: "snapshot", snapshot: snapshot(5, FRESH) });
    expect(s.task!.completion).toEqual(FRESH);
    expect(running(s)).toBe(true);
  });

  it("快照序号之后的评审进度照旧按一般规则应用，带的完成条件照旧生效", () => {
    let s = run(atThree(), progress(5, 0), progress(6, 1, OLD));
    s = run(s, { type: "snapshot", snapshot: snapshot(5, FRESH) });
    expect(s.seq).toBe(6);
    expect(s.review?.done).toBe(1);
    expect(s.task!.completion).toEqual(OLD);
  });
});
