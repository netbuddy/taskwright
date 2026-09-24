// 事件应用规则：先攒着、快照到达后丢掉不大于快照序号的、同序号只应用一次、resync、缺口。

import { describe, expect, it } from "vitest";
import type { Snapshot, Task } from "../api/types";
import { initialWorkState, workReducer, type WorkState } from "../state/workState";
import { parseSseChunk } from "../api/events";
import { alignSteps } from "../model/diff";

const SESSION = "s-1";

function task(): Task {
  return {
    task_id: "TASK-001", task_name: "演示任务", task_type: "演示", domain_tag: null, status: "进行中",
    started_at: "2026-09-21T10:00:00+08:00", ended_at: null,
    definition: { collections: [{ name: "用例", prefix: "UC", fields: [
      { name: "名称", type: "文本", required: true, values: null },
      { name: "步骤", type: "文本列表", required: true, values: null }] }] },
    completion: null,
    items: [{ item_id: "UC-001", collection: "用例", title: "登录", version_no: 1, version_by: "executor", version_at: "", version_count: 1,
              fields: { 名称: "登录", 步骤: ["输入账号"] }, sources: [], reviews: [], confirmations: [], confirmation_stale: false }],
  };
}

function snapshot(seq: number): Snapshot {
  return {
    seq, generated_at: "", executor: { state: "idle", text: "", active_session: SESSION },
    session: { session_id: SESSION, name: "会话", started_at: "", last_active_at: "" },
    task: task(), materials: [], conversation: { messages: [], has_earlier: false, earliest_id: null }, current_work: null,
  };
}

const changed = (seq: number, version: number, name = `名称第${version}版`) => ({
  type: "sse" as const, event: "deliverable_changed",
  data: { seq, at: "", task_id: "TASK-001", revision_no: seq, actor: "user", op_id: `ui-op-${seq}`, undo_of_revision: null, completion: null,
          operations: [{ op: "update", collection: "用例", item_id: "UC-001", title: name, version_before: version - 1, version_after: version,
                         fields: { 名称: name, 步骤: ["输入账号"] }, sources: [] }] },
});

const run = (state: WorkState, ...actions: Parameters<typeof workReducer>[1][]) => actions.reduce(workReducer, state);

describe("事件应用规则", () => {
  it("整份数据到达之前的库事件先攒着，到达后丢掉序号不大于快照序号的，其余按序号应用", () => {
    let s = initialWorkState(SESSION);
    s = run(s, changed(6, 3), changed(5, 2));             // 乱序到达
    expect(s.phase).toBe("waiting_snapshot");
    expect(s.buffered).toHaveLength(2);
    s = run(s, { type: "snapshot", snapshot: snapshot(5) }); // 快照已含第 5 号
    expect(s.seq).toBe(6);
    expect(s.task!.items[0].version_no).toBe(3);
    expect(s.task!.items[0].title).toBe("名称第3版");
  });

  it("同一个序号的库事件只应用一次", () => {
    let s = run(initialWorkState(SESSION), { type: "snapshot", snapshot: snapshot(4) }, changed(5, 2));
    const once = s.task!.items[0].version_count;
    s = run(s, changed(5, 2), changed(4, 9));
    expect(s.task!.items[0].version_count).toBe(once);
    expect(s.task!.items[0].version_no).toBe(2);
    expect(s.seq).toBe(5);
  });

  it("收到 resync 回到等整份数据，之后的库事件重新攒着", () => {
    let s = run(initialWorkState(SESSION), { type: "snapshot", snapshot: snapshot(4) }, { type: "sse", event: "resync", data: { reason: "gap_too_large" } });
    expect(s.phase).toBe("waiting_snapshot");
    expect(s.seq).toBeNull();
    s = run(s, changed(9, 5));
    expect(s.buffered).toHaveLength(1);
    s = run(s, { type: "snapshot", snapshot: snapshot(8) });
    expect(s.seq).toBe(9);
  });

  it("库事件序号出现缺口时回到等整份数据，不在缺一段的数据上接着改", () => {
    const s = run(initialWorkState(SESSION), { type: "snapshot", snapshot: snapshot(4) }, changed(7, 2));
    expect(s.phase).toBe("waiting_snapshot");
    expect(s.task!.items[0].version_no).toBe(1);
  });

  it("直接操作的库事件到达时消去对应的「正在保存」，并记下序号与修订序号的对应", () => {
    let s = run(initialWorkState(SESSION), { type: "snapshot", snapshot: snapshot(4) },
      { type: "op_pending", op_id: "ui-op-5", label: "修改", items: ["UC-001"] });
    expect(Object.keys(s.pendingOps)).toEqual(["ui-op-5"]);
    s = run(s, changed(5, 2));
    expect(s.pendingOps).toEqual({});
    expect(s.revisionBySeq[5]).toBe(5);
  });

  it("直接操作的库事件比响应先到时，响应到了也不再挂上「正在保存」", () => {
    const s = run(initialWorkState(SESSION), { type: "snapshot", snapshot: snapshot(4) }, changed(5, 2),
      { type: "op_pending", op_id: "ui-op-5", label: "修改", items: ["UC-001"] });
    expect(s.pendingOps).toEqual({});
  });

  it("确认之后条目又改了，确认已失效；再确认当前版本就不再失效", () => {
    let s = run(initialWorkState(SESSION), { type: "snapshot", snapshot: snapshot(4) },
      { type: "sse", event: "confirmation_recorded", data: { seq: 5, at: "", task_id: "TASK-001", items: [{ item_id: "UC-001", version_no: 1, accepted: true }], basis: "ui_click", completion: null } });
    expect(s.task!.items[0].confirmation_stale).toBe(false);
    s = run(s, changed(6, 2));
    expect(s.task!.items[0].confirmation_stale).toBe(true);
    s = run(s, { type: "sse", event: "confirmation_recorded", data: { seq: 7, at: "", task_id: "TASK-001", items: [{ item_id: "UC-001", version_no: 2, accepted: true }], basis: "ui_click", completion: null } });
    expect(s.task!.items[0].confirmation_stale).toBe(false);
  });

  it("对话里的确认记下依据是用户的话；任务完成的事件把任务状态改成已完成", () => {
    const s = run(initialWorkState(SESSION), { type: "snapshot", snapshot: snapshot(4) },
      { type: "sse", event: "confirmation_recorded", data: { seq: 5, at: "", task_id: "TASK-001", items: [{ item_id: "UC-001", version_no: 1, accepted: true }], basis: "user_words", op_id: null, completion: null } },
      { type: "sse", event: "task_changed", data: { seq: 6, at: "", task_id: "TASK-001", task_name: "演示任务", status_before: "进行中", status_after: "已完成", actor: "executor", completion: null } });
    expect(s.task!.items[0].confirmations.map((c) => c.basis)).toEqual(["user_words"]);
    expect(s.task!.status).toBe("已完成");
  });

  it("删除操作把条目从列表里拿掉", () => {
    const s = run(initialWorkState(SESSION), { type: "snapshot", snapshot: snapshot(4) }, {
      type: "sse", event: "deliverable_changed",
      data: { seq: 5, at: "", task_id: "TASK-001", revision_no: 3, actor: "user", op_id: null, undo_of_revision: null, completion: null,
              operations: [{ op: "delete", collection: "用例", item_id: "UC-001", title: "登录", version_before: 1, version_after: null, fields: null, sources: [] }] },
    });
    expect(s.task!.items).toHaveLength(0);
  });

  it("过程与对话类事件不看序号，收到就应用；别的会话的忽略；不认识的事件忽略", () => {
    let s = run(initialWorkState(SESSION), { type: "snapshot", snapshot: snapshot(4) });
    s = run(s,
      { type: "sse", event: "system_note", data: { session_id: "别的会话", message_id: "n0", at: "", text: "不该出现" } },
      { type: "sse", event: "system_note", data: { session_id: SESSION, message_id: "n1", at: "", text: "任务现状" } },
      { type: "sse", event: "something_new", data: { session_id: SESSION } },
      { type: "sse", event: "work_started", data: { session_id: SESSION, work_id: "w1", at: "", triggered_by: null } },
      { type: "sse", event: "step", data: { session_id: SESSION, work_id: "w1", step_key: 0, text: "正在读材料", in_progress: true, failed: false } },
      { type: "sse", event: "step", data: { session_id: SESSION, work_id: "w1", step_key: 0, text: "读了材料", in_progress: false, failed: false } },
    );
    expect(s.messages.map((m) => m.type)).toEqual(["system_note"]);
    expect(s.currentWork!.steps).toEqual([expect.objectContaining({ text: "读了材料", in_progress: false })]);
    s = run(s,
      { type: "sse", event: "assistant_reply", data: { session_id: SESSION, message_id: "r1", at: "", work_id: "w1", via_reply_tool: true, informs: [], act: null, text: "好了" } },
      { type: "sse", event: "work_ended", data: { session_id: SESSION, work_id: "w1", at: "", seconds: 3, step_count: 1, outcome: "replied" } },
    );
    expect(s.currentWork).toBeNull();
    expect(s.messages.map((m) => m.type)).toEqual(["system_note", "work_summary", "assistant_reply"]);
  });

  it("同一句话先不带编号、并入会话后再带编号来一次，按 client_id 合成一条，并消去本地的「发送中」", () => {
    let s = run(initialWorkState(SESSION), { type: "snapshot", snapshot: snapshot(0) },
      { type: "outgoing", message: { client_id: "c1", text: "你好", state: "sending" } });
    s = run(s, { type: "sse", event: "user_message", data: { session_id: SESSION, message_id: null, at: "", text: "你好", origin: "typed", annotation: null, queued: true, client_id: "c1" } });
    expect(s.outgoing).toHaveLength(0);
    s = run(s, { type: "sse", event: "user_message", data: { session_id: SESSION, message_id: "m9", at: "", text: "你好", origin: "typed", annotation: null, queued: false, client_id: "c1" } });
    expect(s.messages).toHaveLength(1);
    expect(s.messages[0]).toMatchObject({ message_id: "m9", queued: false });
  });
});

describe("新加的材料（material_added）", () => {
  it("加进材料清单并记下要选中的路径；别的会话上传的也收（材料属于任务）；同一路径不重复", () => {
    let s = run(initialWorkState(SESSION), { type: "snapshot", snapshot: snapshot(0) },
      { type: "sse", event: "material_added", data: { session_id: "别的会话", at: "", path: "inputs/b.md", bytes: 10, modified_at: "t1" } });
    expect(s.materials.map((m) => m.path)).toEqual(["inputs/b.md"]);
    expect(s.focusMaterial).toBe("inputs/b.md");
    s = run(s,
      { type: "sse", event: "material_added", data: { session_id: SESSION, at: "", path: "inputs/a.md", bytes: 5, modified_at: "t2" } },
      { type: "sse", event: "material_added", data: { session_id: null, at: "", path: "inputs/b.md", bytes: 12, modified_at: "t3" } });
    expect(s.materials).toEqual([
      { path: "inputs/a.md", bytes: 5, modified_at: "t2" },
      { path: "inputs/b.md", bytes: 12, modified_at: "t3" },
    ]);
    expect(s.focusMaterial).toBe("inputs/b.md");
  });
});

describe("事件流的解析", () => {
  it("按空行切消息，只有库事件带 id；注释行（保活）忽略；最后不完整的一段留到下一次", () => {
    const { messages, rest } = parseSseChunk(
      ": 保活\n\nevent: deliverable_changed\nid: 12\ndata: {\"seq\":12}\n\nevent: step\ndata: {\"text\":\"读材料\"}\n\nevent: assist",
    );
    expect(messages).toEqual([
      { event: "deliverable_changed", id: "12", data: { seq: 12 } },
      { event: "step", id: null, data: { text: "读材料" } },
    ]);
    expect(rest).toBe("event: assist");
  });
});

describe("列表型字段按步骤对齐", () => {
  it("没变的步骤照列，一删一增合成「这一步改了」，末尾新加的一步单列", () => {
    const rows = alignSteps(["甲", "乙", "丙"], ["甲", "乙改", "丙", "丁"]);
    expect(rows).toEqual([
      { kind: "same", index: 0, text: "甲" },
      { kind: "changed", index: 1, before: "乙", after: "乙改" },
      { kind: "same", index: 2, text: "丙" },
      { kind: "added", index: 3, text: "丁" },
    ]);
    expect(alignSteps(["甲", "乙"], ["乙"])).toEqual([{ kind: "removed", before: "甲" }, { kind: "same", index: 0, text: "乙" }]);
  });
});
