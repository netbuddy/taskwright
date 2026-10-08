// 对话区里的任务状况消息默认折叠成一行要点：要点取自后端随消息给的 details，取不到的项不写；点这一行展开全文，再点收起。
// 「回复」工具兜底提醒的那一句、界面操作的通知不折叠。没有 kind 的旧数据按文字的开头认。
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { App as AntApp, ConfigProvider } from "antd";
import type { ReactNode } from "react";
import type { ConversationMessage, SystemNote } from "../api/types";
import { Conversation } from "../components/work/Conversation";
import { RESUME_LINE, START_LINE, statusNoteLine } from "../model/statusNote";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const START_TEXT = "这条会话开始时（10:02:03）的任务状况：任务「退款需求走查」（类型：软件需求规格说明编制），任务编号 TASK-P，状态是进行中。交付物现有 4 个条目。";
const RESUME_TEXT = "接着这条会话继续时（11:30:00），上次之后交付物的变化：新增了功能用例 UC-004、UC-005；修改了 UC-001。";
const FALLBACK_TEXT = "助手这次没有用回复工具说话，系统自动提醒了它一句：「请用 reply 工具把要对用户说的话发出来」。这句不是你说的。";

const file = (path: string, derived_from: string | null = null) => ({ path, bytes: 1, derived_from });
/** 两份材料（一份 Word、一份 PDF）连同由它们生成的文件。 */
const FILES = [
  file("inputs/办法.pdf"), file("inputs/办法.pdf.md", "inputs/办法.pdf"), file("inputs/办法.pdf.segments.json", "inputs/办法.pdf"),
  file("inputs/需求.docx"), file("inputs/需求.docx.md", "inputs/需求.docx"), file("inputs/需求.docx.segments.json", "inputs/需求.docx"),
];
const docs = (n: number) => Array.from({ length: n }, (_, i) => ({ name: `d${i}.md`, kind: "规范", bytes: 1, locator: `knowledge/x/d${i}.md` }));
const START_DETAILS = {
  kind: "现状", task_id: "TASK-P", items: { 功能用例: 4 }, conditions_total: 6, conditions_met: 1, conditions_unmet: 2, conditions_empty: 3, unresolved: 0,
  materials: { dir: "inputs/", files: FILES, citations: [] },
  knowledge: [{ id: "general", name: "通用知识库", documents: docs(4) }, { id: "lib-cb", name: "跨境电商", documents: docs(2) }],
};
const RESUME_DETAILS = {
  kind: "变化", task_id: "TASK-P", added: ["UC-004", "UC-005"], updated: [{ item: "UC-001", from_revision: 1, to_revision: 3 }], deleted: [], event_seqs: [7, 8, 9],
  materials: { dir: "inputs/", files: FILES }, new_materials: ["inputs/办法.pdf", "inputs/办法.pdf.md", "inputs/办法.pdf.segments.json"],
};
const note = (over: Partial<SystemNote>): SystemNote => ({ type: "system_note", message_id: "n1", at: "", text: START_TEXT, kind: "task_status", ...over });

describe("折叠成的那一行写什么", () => {
  it("开始会话、有知识库：几份材料（由别的文件生成的不算）· 几个知识库几份文档 · 完成条件（分母不算暂时不用核对的）· 未解决的问题", () => {
    expect(statusNoteLine(note({ details: START_DETAILS }))).toBe("助手开始这条会话时看到的任务状况：2 份材料 · 2 个知识库 6 份文档 · 完成条件 1/3 · 问题 0 条未解决");
  });

  it("开始会话、没有知识库文档、还没有材料：不写知识库那一项", () => {
    const { knowledge: _, ...rest } = START_DETAILS;
    const details = { ...rest, materials: { dir: "inputs/", files: [] }, conditions_total: 6, conditions_met: 0, conditions_empty: 5, unresolved: 2 };
    expect(statusNoteLine(note({ details }))).toBe("助手开始这条会话时看到的任务状况：0 份材料 · 完成条件 0/1 · 问题 2 条未解决");
  });

  it("续接有变化：只写不为零的项；新材料只数用户放进来的那几份", () => {
    expect(statusNoteLine(note({ text: RESUME_TEXT, details: RESUME_DETAILS }))).toBe("助手续接这条会话时看到的变化：新增 2 条、修改 1 条、新材料 1 份");
    expect(statusNoteLine(note({ text: RESUME_TEXT, details: { ...RESUME_DETAILS, added: [], updated: [], deleted: ["UC-009"], new_materials: [] } })))
      .toBe("助手续接这条会话时看到的变化：删除 1 条");
  });

  it("续接时选用的知识库变过：末尾加一句；交付物与材料都没有变时只有这一句", () => {
    const knowledge = START_DETAILS.knowledge;
    expect(statusNoteLine(note({ text: RESUME_TEXT, details: { ...RESUME_DETAILS, knowledge } }))).toBe("助手续接这条会话时看到的变化：新增 2 条、修改 1 条、新材料 1 份、选用的知识库有变化");
    expect(statusNoteLine(note({ text: RESUME_TEXT, details: { kind: "变化", added: [], updated: [], deleted: [], new_materials: [], knowledge } })))
      .toBe("助手续接这条会话时看到的变化：选用的知识库有变化");
  });

  it("details 缺项：取不到的项不写；一项都取不到、或者根本没有 details 时只写前半句", () => {
    expect(statusNoteLine(note({ details: { kind: "现状", unresolved: 1, conditions_met: 2 } }))).toBe("助手开始这条会话时看到的任务状况：问题 1 条未解决");
    expect(statusNoteLine(note({ details: { kind: "现状", materials: { dir: "inputs/" }, knowledge: "不是清单" } }))).toBe(START_LINE);
    expect(statusNoteLine(note({ details: null }))).toBe(START_LINE);
    expect(statusNoteLine(note({ details: undefined }))).toBe(START_LINE);
    expect(statusNoteLine(note({ text: RESUME_TEXT, details: {} }))).toBe(RESUME_LINE);
    expect(statusNoteLine(note({ text: RESUME_TEXT, details: { kind: "变化", added: [], updated: [], deleted: [], new_materials: [] } }))).toBe(RESUME_LINE);
  });

  it("材料清单没有标出哪些是生成的文件时（取不到 derived_from）照清单的个数写；新材料的清单取不到材料清单时照原样数", () => {
    const bare = FILES.map(({ path, bytes }) => ({ path, bytes }));
    expect(statusNoteLine(note({ details: { kind: "现状", materials: { files: bare } } }))).toBe("助手开始这条会话时看到的任务状况：6 份材料");
    expect(statusNoteLine(note({ text: RESUME_TEXT, details: { kind: "变化", new_materials: ["inputs/a.md", "inputs/b.md"] } }))).toBe("助手续接这条会话时看到的变化：新材料 2 份");
  });

  it("哪些折叠：kind 是 task_status 的折叠，是 reply_fallback 的不折叠；没有 kind 的旧数据按文字的开头认", () => {
    expect(statusNoteLine(note({ kind: "reply_fallback", text: FALLBACK_TEXT }))).toBeNull();
    expect(statusNoteLine(note({ kind: undefined, text: FALLBACK_TEXT }))).toBeNull();
    expect(statusNoteLine(note({ kind: undefined, text: START_TEXT }))).toBe(START_LINE);
    expect(statusNoteLine(note({ kind: undefined, text: RESUME_TEXT }))).toBe(RESUME_LINE);
    expect(statusNoteLine(note({ kind: undefined, text: "别的系统说明" }))).toBeNull();
    // 有 kind 时以 kind 为准；是哪一种先看 details.kind，再看文字的开头
    expect(statusNoteLine(note({ kind: "task_status", text: "开头认不出的任务状况消息" }))).toBe(START_LINE);
    expect(statusNoteLine(note({ kind: "task_status", text: START_TEXT, details: { kind: "变化", deleted: ["UC-1"] } }))).toBe("助手续接这条会话时看到的变化：删除 1 条");
    expect(statusNoteLine(note({ kind: "reply_fallback", text: START_TEXT }))).toBeNull();
  });
});

const Wrap = ({ children }: { children: ReactNode }) => (
  <ConfigProvider button={{ autoInsertSpace: false }}><AntApp>{children}</AntApp></ConfigProvider>
);
const noop = () => {};
function show(messages: ConversationMessage[]) {
  render(<Wrap><Conversation messages={messages} currentWork={null} outgoing={[]} task={null} disabled={false} disabledReason={null}
    handlers={{ onAction: noop, onMessage: noop }} onSend={noop} onUndo={noop} onOpenItem={noop} onAttach={noop} hasEarlier={false}
    onLoadEarlier={noop} revisionOf={() => null} attachments={[]} revisionsOfWork={() => []} onRevisionTag={noop} /></Wrap>);
}

describe("对话区里的任务状况消息", () => {
  it("默认只有一行要点，行尾是 ▸，看不到全文；点这一行展开成「系统说明」加全文，行尾变 ▾；再点收起", () => {
    show([note({ details: START_DETAILS })]);
    const box = screen.getByTestId("system-note");
    const line = screen.getByTestId("system-note-line");
    expect(box.textContent).toBe("助手开始这条会话时看到的任务状况：2 份材料 · 2 个知识库 6 份文档 · 完成条件 1/3 · 问题 0 条未解决▸");
    expect(line).toHaveAttribute("role", "button");
    expect(line).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByTestId("system-note-full")).toBeNull();
    expect(screen.queryByText("系统说明")).toBeNull();
    expect(screen.queryByText(START_TEXT)).toBeNull();

    fireEvent.click(line);
    expect(line).toHaveAttribute("aria-expanded", "true");
    expect(line.textContent).toMatch(/▾$/);
    expect(screen.getByTestId("system-note-full").textContent).toBe(`系统说明${START_TEXT}`);
    expect(box).toHaveClass("open");

    fireEvent.click(line);
    expect(line).toHaveAttribute("aria-expanded", "false");
    expect(line.textContent).toMatch(/▸$/);
    expect(screen.queryByTestId("system-note-full")).toBeNull();
  });

  it("用键盘也能展开与收起：焦点在这一行上按回车或空格", () => {
    show([note({ details: START_DETAILS })]);
    const line = screen.getByTestId("system-note-line");
    expect(line).toHaveAttribute("tabindex", "0");
    fireEvent.keyDown(line, { key: "Enter" });
    expect(screen.getByTestId("system-note-full")).toBeInTheDocument();
    fireEvent.keyDown(line, { key: " " });
    expect(screen.queryByTestId("system-note-full")).toBeNull();
    fireEvent.keyDown(line, { key: "a" });
    expect(screen.queryByTestId("system-note-full")).toBeNull();
  });

  it("续接那一条同样折叠；一条会话里有两条时各自展开、互不影响", () => {
    show([note({ details: START_DETAILS }), note({ message_id: "n2", text: RESUME_TEXT, details: RESUME_DETAILS })]);
    const lines = screen.getAllByTestId("system-note-line");
    expect(lines.map((l) => l.textContent)).toEqual([
      "助手开始这条会话时看到的任务状况：2 份材料 · 2 个知识库 6 份文档 · 完成条件 1/3 · 问题 0 条未解决▸",
      "助手续接这条会话时看到的变化：新增 2 条、修改 1 条、新材料 1 份▸",
    ]);
    fireEvent.click(lines[1]);
    expect(screen.getAllByTestId("system-note-full").map((f) => f.textContent)).toEqual([`系统说明${RESUME_TEXT}`]);
    expect(lines[0]).toHaveAttribute("aria-expanded", "false");
  });

  it("不折叠的照旧：兜底提醒那一句整句显示在「系统说明」框里，界面操作的通知是一行灰字，都没有可点开的那一行", () => {
    show([
      note({ message_id: "f1", kind: "reply_fallback", text: FALLBACK_TEXT }),
      { type: "ui_action_noted", message_id: "e1", at: "", text: "【界面操作：不是用户打的字】用户在界面上把 UC-001 标为看过了。", undoable: false } as unknown as ConversationMessage,
    ]);
    expect(screen.queryByTestId("system-note-line")).toBeNull();
    expect(screen.getByTestId("system-note").textContent).toBe(`系统说明${FALLBACK_TEXT}`);
    expect(screen.getByText(/UC-001 标为看过了/)).toBeInTheDocument();
  });
});
