// 工作视图地址里可选的 collection 参数：任务页的集合卡带着集合名进工作视图，条目区一打开就停在这个集合的页签。
// 路由把参数解析出来，地址的写法与解析互为逆；条目区没有选中条目时用它作页签的初值，任务里没有这个集合时照旧是第一个集合。

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { App as AntApp, ConfigProvider } from "antd";
import type { Item, Task } from "../api/types";
import { ItemsPanel } from "../components/work/ItemsPanel";
import { href, parseRoute } from "../router";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const noop = () => {};

describe("工作视图的地址", () => {
  it("不带参数时 collection 为 null，带了就解析出集合名；集合名里的汉字与空格照常编码", () => {
    const work = (collection: string | null) => ({ page: "work", taskId: "TASK-1", sessionId: "S1", collection, diagrams: false, diagram: null });
    expect(parseRoute("#/tasks/TASK-1/sessions/S1")).toEqual(work(null));
    expect(href.work("TASK-1", "S1")).toBe("#/tasks/TASK-1/sessions/S1");
    for (const name of ["功能用例", "非 功能/需求", "A&B=C"]) {
      const to = href.work("TASK-1", "S1", name);
      expect(to).toBe(`#/tasks/TASK-1/sessions/S1?collection=${encodeURIComponent(name)}`);
      expect(parseRoute(to)).toEqual(work(name));
    }
    expect(parseRoute("#/tasks/TASK-1/sessions/S1?collection=")).toEqual(work(null));
  });

  it("图表页签另用两个参数，不借用 collection：tab=diagrams 停在图表页签，diagram=D-001 直接打开那张图", () => {
    const work = (diagrams: boolean, diagram: string | null, collection: string | null = null) => ({ page: "work", taskId: "TASK-1", sessionId: "S1", collection, diagrams, diagram });
    expect(href.diagrams("TASK-1", "S1")).toBe("#/tasks/TASK-1/sessions/S1?tab=diagrams");
    expect(href.diagrams("TASK-1", "S1", "D-001")).toBe("#/tasks/TASK-1/sessions/S1?diagram=D-001");
    expect(parseRoute(href.diagrams("TASK-1", "S1"))).toEqual(work(true, null));
    expect(parseRoute(href.diagrams("TASK-1", "S1", "D-001"))).toEqual(work(false, "D-001"));
    // 任务里有一个名叫「图表」的集合时，collection=图表 指的是那个集合，不是图表页签。
    expect(parseRoute(href.work("TASK-1", "S1", "图表"))).toEqual(work(false, null, "图表"));
    expect(parseRoute("#/tasks/TASK-1/sessions/S1?tab=别的&diagram=")).toEqual(work(false, null));
  });

  it("别的页面的地址不受影响", () => {
    expect(parseRoute("#/tasks/TASK-1")).toEqual({ page: "task", taskId: "TASK-1" });
    expect(parseRoute("#/tasks")).toEqual({ page: "tasks" });
    expect(parseRoute("#/knowledge/lib-1")).toEqual({ page: "knowledge", libraryId: "lib-1" });
  });
});

describe("条目区集合页签的初值", () => {
  const field = { name: "名称", type: "文本", required: true, values: null };
  const item = (id: string, collection: string): Item => ({
    item_id: id, collection, title: id, revision_no: 1, revision_by: "executor", revision_at: "", revisions: [1],
    fields: { 名称: id }, sources: [], reviews: [], waivers: [], confirmations: [], confirmation_stale: false,
  });
  const task = {
    task_id: "TASK-1", task_name: "页签", task_type: "演示", domain_tag: null, status: "进行中", started_at: "", ended_at: null,
    definition: { collections: ["功能用例", "约束", "问题"].map((name, i) => ({ name, prefix: ["UC", "CON", "TBD"][i], needs_review: false, review_rules: null, fields: [field] })) },
    completion: null, items: [item("UC-001", "功能用例"), item("CON-001", "约束")], latest_revision: 1,
  } as unknown as Task;
  const onTab = (initialCollection?: string | null, selected: string | null = null) => {
    render(<ConfigProvider><AntApp><ItemsPanel task={task} initialCollection={initialCollection} readOnly={false} recentlyChanged={[]} pendingItems={new Set()}
      selected={selected} onSelect={noop} submit={vi.fn(async () => null)} onGenerateDoc={noop} /></AntApp></ConfigProvider>);
    const on = document.querySelector(".itab.on")?.firstChild?.textContent;
    cleanup();
    return on;
  };

  it("给了任务里有的集合名就停在它的页签；不给、或者没有这个集合时是第一个集合", () => {
    expect(onTab("约束")).toBe("约束");
    expect(onTab("问题")).toBe("问题");
    expect(onTab()).toBe("功能用例");
    expect(onTab(null)).toBe("功能用例");
    expect(onTab("没有这个集合")).toBe("功能用例");
  });

  it("已经选中了条目时以条目所在的集合为准", () => {
    expect(onTab("问题", "CON-001")).toBe("约束");
  });
});
