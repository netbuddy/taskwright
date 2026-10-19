// 助手提议进入下一个阶段的卡片（请选择，其中一个选项的键是 enter_clarify、enter_consolidate、start_items、enter_review 之一）：
// 按键认出；标题写「进入下一阶段 · 请决定」；进入的那个选项是主按钮，另一个是普通按钮；点名的条目前面写「请先看：」并且可以点开；
// 点进入的那一项照现有的做法替用户发一句与选项相同的话，带上选项的键；留在这一步的那一项（stay，早先的固定键也认）一律写成「继续本步」，
// 点了怎样见 stayCard.test.tsx。别的请选择卡片与复述的卡片照旧。
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { App as AntApp, ConfigProvider } from "antd";
import type { ReactNode } from "react";
import type { Act } from "../api/types";
import { ReplyCard, STAGE_CARD_TITLE } from "../components/work/ReplyCard";
import { overallTask } from "./fixtures/overallTask";

afterEach(cleanup);
const Wrap = ({ children }: { children: ReactNode }) => (
  <ConfigProvider button={{ autoInsertSpace: false }}><AntApp>{children}</AntApp></ConfigProvider>
);
function card(act: Act, over: Record<string, unknown> = {}) {
  const handlers = { onAction: vi.fn(), onMessage: vi.fn() };
  const onOpenItem = vi.fn();
  render(<Wrap><ReplyCard act={act} replyMessageId="msg-1" task={overallTask()} handlers={handlers} onOpenItem={onOpenItem} {...over} /></Wrap>);
  return { handlers, onOpenItem };
}
const PAGE = overallTask().items.find((i) => i.collection === "业务说明")!;
const CARDS: [string, string, string, string][] = [
  ["next_step", "进入下一步：澄清", "stay", "再核读一遍"],
  ["goto:writing", "转到：写条目", "stay", "先不转"],
  // 早先的键照样认。
  ["enter_clarify", "进入澄清", "continue_reading", "再核读一遍"],
  ["enter_consolidate", "进入整理建模", "continue_clarify", "继续澄清"],
  ["start_items", "开始写条目", "continue_consolidate", "再整理一遍"],
  ["enter_review", "进入评审确认", "continue_writing", "继续写条目"],
];

describe("提议进入下一个阶段的卡片", () => {
  it.each(CARDS)("选项键 %s：标题是「进入下一阶段 · 请决定」，「%s」是主按钮；键是 %s 的那一项不管助手写成「%s」还是别的，都显示成「继续本步」", (enterKey, enterText, stayKey, stayText) => {
    card({ kind: "choose", text: "这一段做完了，接下来做下一段。", options: [{ key: enterKey, text: enterText }, { key: stayKey, text: stayText }] });
    const act = screen.getByTestId("act-choose");
    expect(act.querySelector(".tt")).toHaveTextContent(STAGE_CARD_TITLE);
    expect(STAGE_CARD_TITLE).toBe("进入下一阶段 · 请决定");
    expect(act).toHaveAttribute("data-stage-card", "true");
    expect(screen.getByTestId(`card-option-${enterKey}`)).toHaveTextContent(enterText);
    expect(screen.getByTestId(`card-option-${enterKey}`)).toHaveClass("pri");
    expect(screen.getByTestId(`card-option-${stayKey}`)).toHaveTextContent(/^继续本步$/);
    expect(screen.getByTestId(`card-option-${stayKey}`)).not.toHaveClass("pri");
  });

  it("点名的页前面写「请先看：」，点了打开那一页；没有点名条目时不写这一句", () => {
    const { onOpenItem } = card({ kind: "choose", text: "这几页你看过之后，现在开始写条目吗？", items: [{ item_id: PAGE.item_id, revision_no: PAGE.revision_no }],
      options: [{ key: "start_items", text: "开始写条目" }, { key: "continue_consolidate", text: "再整理一遍" }] });
    expect(screen.getByTestId("card-look-first")).toHaveTextContent("请先看：");
    fireEvent.click(screen.getByTestId(`card-context-${PAGE.item_id}`));
    expect(onOpenItem).toHaveBeenCalledWith(PAGE.item_id);
    cleanup();
    card({ kind: "choose", text: "现在进入澄清吗？", options: [{ key: "enter_clarify", text: "进入澄清" }, { key: "continue_reading", text: "再核读一遍" }] });
    expect(screen.queryByTestId("card-look-first")).toBeNull();
  });

  it("点「进入」的那一项：替用户发一句与选项相同的话，带着选项的键；点了之后卡片收成一句", () => {
    const { handlers } = card({ kind: "choose", text: "现在进入评审确认吗？", options: [{ key: "enter_review", text: "进入评审确认" }, { key: "continue_writing", text: "继续写条目" }] });
    fireEvent.click(screen.getByTestId("card-option-enter_review"));
    expect(handlers.onMessage.mock.calls[0]).toEqual(["我选：进入评审确认", { reply_message_id: "msg-1", kind: "choose", choice: "enter_review" }]);
    expect(screen.queryByTestId("card-option-enter_review")).toBeNull();
    expect(screen.getByTestId("act-choose")).toHaveTextContent("你选了「进入评审确认」");
  });

  it("助手把留在这一段的选项写成了别的键与文字，照样认作这种卡片", () => {
    card({ kind: "choose", text: "现在进入整理建模吗？", options: [{ key: "later", text: "先不" }, { key: "enter_consolidate", text: "进入整理建模" }] });
    expect(screen.getByTestId("act-choose").querySelector(".tt")).toHaveTextContent(STAGE_CARD_TITLE);
    expect(screen.getByTestId("card-option-enter_consolidate")).toHaveClass("pri");
    expect(screen.getByTestId("card-option-later")).not.toHaveClass("pri");
  });

  it("助手正在工作时两个选项都点不了", () => {
    card({ kind: "choose", text: "现在进入澄清吗？", options: [{ key: "enter_clarify", text: "进入澄清" }, { key: "continue_reading", text: "再核读一遍" }] }, { writesOff: true });
    expect(screen.getByTestId("card-option-enter_clarify")).toBeDisabled();
    expect(screen.getByTestId("card-option-continue_reading")).toBeDisabled();
  });

  it("别的请选择卡片照旧：标题是「请选择」，没有主按钮，不写「请先看：」；复述的卡片也照旧", () => {
    card({ kind: "choose", text: "逾期未还的读者能不能续借？", items: [{ item_id: PAGE.item_id, revision_no: PAGE.revision_no }],
      options: [{ key: "a", text: "允许" }, { key: "b", text: "不允许" }] });
    const act = screen.getByTestId("act-choose");
    expect(act.querySelector(".tt")).toHaveTextContent("请选择");
    expect(act).not.toHaveAttribute("data-stage-card");
    expect(screen.getByTestId("card-option-a")).not.toHaveClass("pri");
    expect(screen.queryByTestId("card-look-first")).toBeNull();
    cleanup();
    card({ kind: "choose", text: "周六上午，小王预约了一本书。", options: [{ key: "story_ok", text: "采纳为例子" }, { key: "story_fix", text: "有误，需修改" }, { key: "story_again", text: "换一个例子重述" }] });
    expect(screen.getByTestId("act-choose").querySelector(".tt")).toHaveTextContent("复述 · 请核对");
  });

  it("卡片里的小标签与后面的值之间有空隙：四个字的标签（「要定的事」）不与问话挤在一起", () => {
    // 样式不在测试环境里生效，这里只核对那条规则写了右边的内边距。
    // 基准地址先放进变量：Vite 会改写 new URL(字面量, import.meta.url) 这种写法，测试里就读不到文件了。
    const here = import.meta.url;
    const css = readFileSync(decodeURIComponent(new URL("../styles/workview.css", here).pathname), "utf-8");
    const rule = /\.app \.act \.fk\{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(rule).toMatch(/min-width:3rem/);
    expect(rule).toMatch(/padding-right:\.5rem/);
  });
});
