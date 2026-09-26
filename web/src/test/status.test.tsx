// 条目的主状态徽标：先后顺序（评审不通过 → 未读 → 待评审 → 已保留 → 问题未解决）、什么都不缺时不挂、
// 前四件之一加未解决问题时另挂「问题 N」（每行有色徽标最多两枚）、不评审的集合只可能是未读或问题、问题条目只写自己的状态、
// 其余信息降为灰色小字；条目详情头部用同一组徽标，下面一行灰字，横幅只剩评审不通过一条红色，助手补充改灰。
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { App as AntApp, ConfigProvider } from "antd";
import type { ReactNode } from "react";
import type { Item, Task } from "../api/types";
import { ItemStatus } from "../components/work/ItemStatus";
import { ItemDetail } from "../components/work/ItemDetail";
import { mainStatus, mainStatusText } from "../model/items";

const Wrap = ({ children }: { children: ReactNode }) => (
  <ConfigProvider button={{ autoInsertSpace: false }}><AntApp><div className="app">{children}</div></AntApp></ConfigProvider>
);
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const READ = [{ revision_no: 3, accepted: true, basis: "viewed" }];
const PROBLEM = { rule_id: "UC-R7", level: "必选", field: "基本流程", index: 1, problem: "第 2 步没有主语。", suggestion: null };
const failed = { revision_no: 3, verdict: "不合规", findings: [PROBLEM, PROBLEM] };
const passed = { revision_no: 3, verdict: "合规", findings: [] };
const kept = [{ revision_no: 3, reason: "材料原话如此", revoked: false, at: "" }];

function item(over: Partial<Item> & Pick<Item, "item_id">): Item {
  return {
    collection: "功能用例", title: "归还图书", revision_no: 3, revision_by: "executor", revision_at: "", revisions: [3],
    fields: { 用例名称: "归还图书", 基本流程: ["读者出示借书证"] }, sources: [], reviews: [], confirmations: READ, confirmation_stale: false, ...over,
  } as Item;
}
const issue = (id: string, status: string, refs: string[]) =>
  item({ item_id: id, collection: "问题", title: id, fields: { 事项: `事项 ${id}`, 种类: "待澄清", 状态: status, 关联条目: refs }, confirmations: [] });

function task(items: Item[]): Task {
  return {
    task_id: "TASK-001", task_name: "图书借阅", task_type: "软件需求规格说明编制", domain_tag: null, status: "进行中", started_at: "", ended_at: null,
    definition: { collections: [
      { name: "功能用例", prefix: "UC", needs_review: true, review_rules: [], fields: [
        { name: "用例名称", type: "文本", required: true, values: null },
        { name: "基本流程", type: "文本列表", required: true, values: null }] },
      { name: "问题", prefix: "TBD", needs_review: false, review_rules: null, fields: [
        { name: "事项", type: "文本", required: true, values: null },
        { name: "种类", type: "枚举", required: true, values: ["待澄清", "后续迭代"] },
        { name: "状态", type: "枚举", required: true, values: ["未解决", "已解决", "用户决定保留"] },
        { name: "关联条目", type: "条目引用", required: false, values: null }] },
      { name: "领域说明", prefix: "DN", needs_review: false, review_rules: null, display: { group_field: "类别" }, fields: [
        { name: "标题", type: "文本", required: true, values: null },
        { name: "类别", type: "枚举", required: true, values: ["术语", "规则"] }] }] },
    completion: null, items, latest_revision: 3,
  } as Task;
}

describe("主状态的先后", () => {
  const cases: [string, Partial<Item>, string][] = [
    ["评审不通过排在未读之前", { reviews: [failed], confirmations: [] }, "评审不通过 2 处"],
    ["未读排在待评审之前", { confirmations: [] }, "未读"],
    ["已读、还没评审", {}, "待评审"],
    ["问题全部保留了", { reviews: [failed], waivers: kept } as Partial<Item>, "评审不通过 2 处 · 已保留"],
  ];
  for (const [name, over, text] of cases) {
    it(name, () => {
      const it = item({ item_id: "UC-001", ...over });
      expect(mainStatusText(mainStatus(task([it]), it))).toBe(text);
    });
  }

  it("评审通过又已读：只剩未解决的问题时写「问题 N 未解决」，问题也没有时不挂徽标", () => {
    const uc = item({ item_id: "UC-001", reviews: [passed] });
    expect(mainStatus(task([uc, issue("TBD-001", "未解决", ["UC-001"])]), uc)).toMatchObject({ kind: "issues", issues: 1 });
    expect(mainStatus(task([uc, issue("TBD-001", "已解决", ["UC-001"])]), uc).kind).toBeNull();
  });
});

describe("条目行上的徽标", () => {
  it("评审不通过又有未解决的问题：两枚，主徽标红色、「问题 N」琥珀色；悬停主徽标看到全部状态", () => {
    const uc = item({ item_id: "UC-002", reviews: [failed] });
    const t = task([uc, issue("TBD-001", "未解决", ["UC-002"])]);
    render(<Wrap><div className="lrow"><ItemStatus task={t} item={uc} row /></div></Wrap>);
    expect(screen.getByTestId("state-UC-002")).toHaveTextContent("评审不通过 2 处");
    expect(screen.getByTestId("state-UC-002")).toHaveClass("sb", "failed");
    expect(screen.getByTestId("issues-UC-002")).toHaveTextContent(/^问题 1$/);
    expect(document.querySelectorAll(".sb")).toHaveLength(2);
    expect(screen.getByTestId("state-UC-002").title).toBe("评审：不通过 2 处，还没处理\n已读：你看过修订 3\n问题：牵涉这条的有 1 个还没解决");
  });

  it("只有未解决的问题时只有一枚「问题 N 未解决」；什么都不缺时一枚也没有", () => {
    const uc = item({ item_id: "UC-003", reviews: [passed] });
    render(<Wrap><ItemStatus task={task([uc, issue("TBD-001", "未解决", ["UC-003"])])} item={uc} row /></Wrap>);
    expect(screen.getByTestId("state-UC-003")).toHaveTextContent("问题 1 未解决");
    expect(screen.queryByTestId("issues-UC-003")).toBeNull();
    cleanup();
    render(<Wrap><ItemStatus task={task([uc])} item={uc} row /></Wrap>);
    expect(document.querySelectorAll(".sb")).toHaveLength(0);
  });

  it("修订、刚改、有助手补充的内容都是灰色小字，「刚改」加粗", () => {
    const uc = item({ item_id: "UC-001", revisions: [1, 3], sources: [{ kind: "执行者补充", locator: "", excerpt: "核对条形码" }] as Item["sources"] });
    render(<Wrap><ItemStatus task={task([uc])} item={uc} just row /></Wrap>);
    expect(screen.getByTestId("just-UC-001")).toHaveClass("gm", "strong");
    expect(screen.getByText("有助手补充的内容")).toHaveClass("gm");
  });

  it("领域说明不出现评审三种，只可能是未读、问题或没有徽标", () => {
    const dn = item({ item_id: "DN-001", collection: "领域说明", fields: { 标题: "借期", 类别: "规则" }, confirmations: [] });
    render(<Wrap><ItemStatus task={task([dn])} item={dn} row /></Wrap>);
    expect(screen.getByTestId("state-DN-001")).toHaveTextContent("未读");
    expect(screen.getByTestId("group-DN-001")).toHaveClass("gm");
    cleanup();
    const seen = { ...dn, confirmations: READ };
    render(<Wrap><ItemStatus task={task([seen])} item={seen} row /></Wrap>);
    expect(document.querySelectorAll(".sb")).toHaveLength(0);
  });

  it("问题条目只写它自己的状态：未解决琥珀、已解决绿、用户决定保留绿边框", () => {
    const list = [issue("TBD-001", "未解决", []), issue("TBD-002", "已解决", []), issue("TBD-003", "用户决定保留", [])];
    const t = task(list);
    render(<Wrap>{list.map((i) => <ItemStatus key={i.item_id} task={t} item={i} />)}</Wrap>);
    expect(screen.getByTestId("status-TBD-001")).toHaveClass("issues");
    expect(screen.getByTestId("status-TBD-002")).toHaveClass("ok");
    expect(screen.getByTestId("status-TBD-003")).toHaveClass("kept");
    expect(screen.queryByText("未读")).toBeNull();
  });
});

describe("条目详情头部", () => {
  const detail = (it: Item, t = task([it])) =>
    render(<Wrap><ItemDetail task={t} item={it} def={t.definition.collections[0]} readOnly={false} pending={false} submit={vi.fn(async () => null)} /></Wrap>);

  it("与行上同一组徽标，下面一行灰字写已读、修订与来源；横幅只有一条红色的评审不通过", () => {
    const uc = item({ item_id: "UC-002", reviews: [failed], sources: [{ kind: "执行者补充", locator: "", excerpt: "核对条形码" }] as Item["sources"] });
    detail(uc, task([uc, issue("TBD-001", "未解决", ["UC-002"])]));
    expect(screen.getByTestId("state-UC-002")).toHaveTextContent("评审不通过 2 处");
    expect(screen.getByTestId("issues-UC-002")).toHaveTextContent("问题 1");
    expect(screen.getByTestId("detail-sub")).toHaveTextContent("已读 · 现在是修订 3，由助手写的 · 来源 1 条");
    expect(screen.getByTestId("review-banner")).toHaveTextContent("评审不通过：2 处问题未处理，标在下面对应的字段旁。");
    expect(screen.getByTestId("supplement-banner")).not.toHaveClass("amber");
    expect(document.querySelectorAll(".banner-line.gap, .banner-line.amber")).toHaveLength(1);
  });

  it("不再有「现在的内容是修订 N 写的」横幅；「和修订 N 比对」挪到灰字行末尾", () => {
    const uc = item({ item_id: "UC-001", revisions: [1, 3], reviews: [passed] });
    detail(uc);
    expect(screen.queryByText(/现在的内容是修订/)).toBeNull();
    fireEvent.click(screen.getByTestId("compare-open"));
    expect(screen.getByTestId("compare-banner")).toHaveTextContent("正在和修订 1 比对");
  });
});
