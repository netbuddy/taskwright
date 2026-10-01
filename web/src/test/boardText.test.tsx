// 任务页交付物一块的集合卡：空的集合降成灰阶，只写条目个数 0 与「还没有条目。」，不写「评审通过 0/0」「已读 0/0」；
// 详细的说明在悬停提示里，称「你」不称「用户」。

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { App as AntApp, ConfigProvider } from "antd";
import { api } from "../api/client";
import type { Item, TaskDetail } from "../api/types";
import { ServiceProvider } from "../components/ServiceControls";
import { ToastProvider } from "../components/Toasts";
import { TaskPage } from "../pages/TaskPage";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const ok = { revision_no: 2, verdict: "合规", findings: [], rules_hash: "h1", seq: 5 };

function item(id: string, collection: string, over: Partial<Item> = {}): Item {
  return {
    item_id: id, collection, title: id, revision_no: 2, revision_by: "executor", revision_at: "", revisions: [2],
    fields: {}, sources: [], reviews: [], waivers: [], confirmations: [{ revision_no: 2, accepted: true, basis: "viewed" }],
    confirmation_stale: false, ...over,
  };
}

function detail(items: Item[]): TaskDetail {
  const field = { name: "名称", type: "文本", required: true, values: null };
  return {
    task_id: "TASK-B", task_name: "看板", task_type: "演示", domain_tag: null, status: "进行中", started_at: "", ended_at: null,
    definition: { collections: [
      { name: "功能用例", prefix: "UC", needs_review: true, rules_hash: "h1", review_rules: [], fields: [field] },
      { name: "约束", prefix: "CON", needs_review: true, rules_hash: "h1", review_rules: [], fields: [field] },
      { name: "领域说明", prefix: "DN", needs_review: false, review_rules: null, fields: [field] }] },
    completion: null, items, latest_revision: 2, sessions: [], materials: [],
  } as unknown as TaskDetail;
}

async function open(items: Item[]) {
  vi.spyOn(api, "getTask").mockResolvedValue(detail(items));
  vi.spyOn(api, "listTasks").mockResolvedValue([]);
  vi.spyOn(api, "serviceInfo").mockRejectedValue(new Error("没有这个接口"));
  render(<ConfigProvider><AntApp><ToastProvider><ServiceProvider><TaskPage taskId="TASK-B" /></ServiceProvider></ToastProvider></AntApp></ConfigProvider>);
  await screen.findByTestId("board-功能用例");
}

describe("交付物的集合卡", () => {
  it("空的集合（要评审的与不评审的）降成灰阶，只写条目个数 0 与「还没有条目。」，不写评审通过与已读", async () => {
    await open([item("UC-001", "功能用例", { reviews: [ok] })]);
    for (const name of ["约束", "领域说明"]) {
      const card = screen.getByTestId(`board-${name}`);
      expect(card).toHaveClass("empty");
      expect(screen.getByTestId(`board-count-${name}`)).toHaveTextContent(/^0$/);
      expect(card).toHaveTextContent("还没有条目。");
      expect(card).not.toHaveTextContent("评审通过");
      expect(card).not.toHaveTextContent("已读");
      expect(card.getAttribute("title")).toContain(`${name}还没有条目。`);
    }
    // 有条目的集合不是灰阶，写评审通过与已读两项。
    expect(screen.getByTestId("board-功能用例")).not.toHaveClass("empty");
    expect(screen.getByTestId("board-count-功能用例")).toHaveTextContent(/^1$/);
    expect(screen.getByTestId("board-review-功能用例")).toHaveTextContent("评审通过 1/1");
    expect(screen.getByTestId("board-read-功能用例")).toHaveTextContent("已读 1/1");
  });

  it("悬停提示里的说明称「你」，不称「用户」；不评审的集合只写已读，不写评审通过", async () => {
    const unread = { confirmations: [] };
    await open([item("UC-001", "功能用例", { reviews: [ok] }), item("UC-002", "功能用例", unread),
      item("DN-001", "领域说明"), item("DN-002", "领域说明", unread)]);
    const uc = screen.getByTestId("board-功能用例");
    const dn = screen.getByTestId("board-领域说明");
    expect(uc.getAttribute("title")).toContain("这 2 个条目里，1 个在当前所在的修订上评审通过，你已经看过其中 1 个。");
    expect(uc).toHaveTextContent("评审通过 1/2 · 已读 1/2");
    expect(dn.getAttribute("title")).toContain("这 2 个条目里，你已经看过 1 个。这个集合不评审。");
    expect(dn).toHaveTextContent("已读 1/2");
    expect(dn).not.toHaveTextContent("评审通过");
    for (const card of document.querySelectorAll(".tp-coll")) expect(`${card.textContent}${card.getAttribute("title")}`).not.toContain("用户");
  });
});
