// 右侧栏的「调试」页签：服务开着调试模式才有；四块内容（系统提示按部分列出、阶段记录、这一段的灯、被拒的工具调用）；
// 打开时取一次，助手做完一轮再取一次，点「刷新」再取一次；被拒的调用缺省只列最近一次工作里的，可以改看全部。
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { App as AntApp, ConfigProvider } from "antd";
import { api } from "../api/client";
import type { DebugStage, DebugSystemPrompt, ServiceInfo, StageView, TaskDetail } from "../api/types";
import { ServiceProvider } from "../components/ServiceControls";
import { ToastProvider } from "../components/Toasts";
import { DebugPane } from "../components/work/DebugPane";
import { WorkViewPage } from "../pages/WorkViewPage";
import { useWorkView } from "../state/useWorkView";
import { initialWorkState, type WorkState } from "../state/workState";
import { overallTask } from "./fixtures/overallTask";
import { flowName } from "../model/stage";

vi.mock("../state/useWorkView", () => ({ useWorkView: vi.fn() }));
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const STAGE: StageView = { current: "modeling", moved_by: "user", moved_at: "2026-10-10T09:00:00", reason: "", lamps: {
  reading: [], clarifying: [], writing: [], reviewing: [], document: [],
  modeling: [
    { key: "flows_have_flowchart_with_branch", ok: false, summary: "有 1 页标签为「流程」的主题还没有以「例外：」开头的例子：OA-003。", items: ["OA-003"] },
    { key: "roles_in_context_and_use_cases", ok: null, summary: "还没有标签为「角色」的主题。", items: [] },
    { key: "no_duplicate_titles", ok: true, summary: "没有两页主题用了同一个标题或别名。", items: [] },
  ] } };
const PROMPT: DebugSystemPrompt = {
  available: true, note: null, session_id: "S-1", at: "2026-10-10T09:05:00", replaced: true, stage: "modeling", stage_name: "整理建模", how: "recomposed", error: null,
  prompt_dir: "/data/prompts", notes: ["提示词目录里的 system.md 没有用上：它是一个软链接。这一部分照旧用产品自带的。"], digest: "0123456789abcdef",
  parts: [
    { part: "system", part_name: "系统提示", from: "builtin", from_name: "产品自带", file: "agent/prompts/stages/system.md", lines: 2, bytes: 30, text: "你是执行者。\n第二行。" },
    { part: "platform_stage", part_name: "平台说明里这个阶段的那一段", from: "prompt_dir", from_name: "提示词目录", file: "modeling.md", lines: 1, bytes: 20, text: "# 现在这个阶段：整理建模" },
    { part: "tail", part_name: "助手程序接在后面的工作目录等", from: "pi", from_name: "助手程序", file: null, lines: 3, bytes: 20, text: "<cwd>\n/x\n</cwd>" },
  ],
  text: "你是执行者。\n第二行。\n\n# 现在这个阶段：整理建模\n\n<cwd>\n/x\n</cwd>",
};
const FACTS: DebugStage = {
  records: [
    { from: "reading", from_name: "核读材料", to: "clarifying", to_name: "澄清", actor: "user", reason: "用户在卡片上选了「进入澄清」", run_id: null, session_id: "S-1", at: "2026-10-10T08:50:00", flow: "initial" },
    { from: "writing", from_name: "写条目", to: "clarifying", to_name: "澄清", actor: "executor", reason: "", run_id: "r3", session_id: "S-1", at: "2026-10-10T08:58:00" },
  ],
  rejections: [
    { work_id: "w-2", session_id: "S-1", call_id: "c-9", tool: "save_revision", kind: "input", fact: "任务现在在澄清阶段，这个阶段不能新增「功能用例」的条目", guidance: "进入写条目要由用户在卡片上选「开始写条目」", at: "2026-10-10T09:04:00" },
    { work_id: "w-1", session_id: "S-1", call_id: "c-3", tool: "reply", kind: "gate", fact: "这一轮还没有写理解", guidance: null, at: "2026-10-10T08:40:00" },
  ],
  latest_work_id: "w-2",
};

function pane(working = false, prompt: DebugSystemPrompt = PROMPT, facts: DebugStage = FACTS) {
  const getPrompt = vi.spyOn(api, "debugSystemPrompt").mockResolvedValue(prompt);
  const getFacts = vi.spyOn(api, "debugStage").mockResolvedValue(facts);
  const onOpenItem = vi.fn();
  const onOpenMaterial = vi.fn();
  const items = [{ item_id: "OA-003", collection: "业务说明" }] as never;
  const view = render(<DebugPane taskId="TASK-001" stage={STAGE} items={items} working={working} onOpenItem={onOpenItem} onOpenMaterial={onOpenMaterial} />);
  return { getPrompt, getFacts, onOpenItem, onOpenMaterial, view };
}

describe("右侧栏的调试页签", () => {
  it("顶上是阶段条：六个阶段的名字，当前阶段标出来；没通过的灯一盏一句，点了打开它差的第一页", async () => {
    const { onOpenItem } = pane();
    const bar = within(screen.getByTestId("debug-pane")).getByTestId("stage-bar");
    expect(screen.getByTestId("debug-pane").firstElementChild).toBe(bar);
    expect(within(bar).getByTestId("stage-modeling")).toHaveAttribute("aria-current", "step");
    fireEvent.click(within(bar).getByTestId("lamp-flows_have_flowchart_with_branch"));
    expect(onOpenItem).toHaveBeenCalledWith("OA-003");
    await screen.findByTestId("debug-prompt-meta");
  });

  it("系统提示：先说阶段、重拼还是沿用、提示词目录，再按部分列出，每一部分写出处、文件与行数，点开是原文；没有用上的文件各写一句原因", async () => {
    pane();
    const meta = await screen.findByTestId("debug-prompt-meta");
    expect(meta).toHaveTextContent("阶段：整理建模。这一次是重新读文件拼的。提示词目录：/data/prompts。");
    expect(screen.getByTestId("debug-part-system").querySelector("summary")).toHaveTextContent("系统提示 · 产品自带 · agent/prompts/stages/system.md · 2 行");
    expect(screen.getByTestId("debug-part-platform_stage").querySelector("summary")).toHaveTextContent("平台说明里这个阶段的那一段 · 提示词目录 · modeling.md · 1 行");
    expect(screen.getByTestId("debug-part-tail").querySelector("summary")).toHaveTextContent("助手程序接在后面的工作目录等 · 助手程序 · 3 行");
    expect(screen.getByTestId("debug-part-system").querySelector("pre")!.textContent).toBe("你是执行者。\n第二行。");
    expect(screen.getByTestId("debug-prompt")).toHaveTextContent("提示词目录里的 system.md 没有用上：它是一个软链接。");
  });

  it("阶段记录：每次移动一行，写谁、从哪到哪、所属流程、理由；没有写理由的写明没有写，早先的后端没有给所属流程的写明没有记", async () => {
    pane();
    const section = await screen.findByTestId("debug-records");
    expect([...section.querySelectorAll("thead th")].map((th) => th.textContent)).toEqual(["时刻", "谁", "从哪到哪", "所属流程", "理由"]);
    const rows = [...section.querySelectorAll("tbody tr")].map((row) => [...row.querySelectorAll("td")].slice(1).map((td) => td.textContent));
    expect(rows).toEqual([["用户", "核读材料 → 澄清", "需求分析", "用户在卡片上选了「进入澄清」"], ["助手", "写条目 → 澄清", "（没有记）", "（没有写）"]]);
    // 认不出的流程照原样写。
    expect([flowName("analysis"), flowName("initial"), flowName("change"), flowName(undefined), flowName(null)]).toEqual(["需求分析", "需求分析", "change", "（没有记）", "单项活动"]);
  });

  it("这一段的灯：通过、没通过、不适用三种都列出，写整句与键，列出的编号可以点开", async () => {
    const { onOpenItem } = pane();
    await screen.findByTestId("debug-prompt-meta");
    expect(screen.getByTestId("debug-lamps")).toHaveTextContent("「整理建模」这一段的灯");
    const failing = screen.getByTestId("debug-lamp-flows_have_flowchart_with_branch");
    expect(failing).toHaveClass("no");
    expect(failing).toHaveTextContent("没通过有 1 页标签为「流程」的主题还没有以「例外：」开头的例子：OA-003。");
    expect(failing.querySelector(".key")).toHaveTextContent("flows_have_flowchart_with_branch");
    fireEvent.click(failing.querySelector(".ids a")!);
    expect(onOpenItem).toHaveBeenCalledWith("OA-003");
    expect(screen.getByTestId("debug-lamp-roles_in_context_and_use_cases")).toHaveTextContent("不适用");
    expect(screen.getByTestId("debug-lamp-no_duplicate_titles")).toHaveClass("ok");
  });

  it("被拒的工具调用：缺省只列最近一次工作里的，写工具名、事实与指引；勾「看全部」列出全部", async () => {
    pane();
    await screen.findByTestId("debug-prompt-meta");
    let shown = screen.getAllByTestId("debug-rejection");
    expect(shown).toHaveLength(1);
    expect(shown[0]).toHaveTextContent("save_revision");
    expect(shown[0]).toHaveTextContent("任务现在在澄清阶段，这个阶段不能新增「功能用例」的条目");
    expect(shown[0]).toHaveTextContent("指引：进入写条目要由用户在卡片上选「开始写条目」");
    fireEvent.click(screen.getByTestId("debug-all-rejections"));
    shown = screen.getAllByTestId("debug-rejection");
    expect(shown).toHaveLength(2);
    expect(shown[1]).toHaveTextContent("这一轮还没有写理解");
    expect(shown[1]).not.toHaveTextContent("指引：");
  });

  it("打开时取一次；助手从工作中变为不在工作时再取一次；点「刷新」再取一次", async () => {
    const { getPrompt, getFacts, view } = pane(true);
    await screen.findByTestId("debug-prompt-meta");
    expect([getPrompt.mock.calls.length, getFacts.mock.calls.length]).toEqual([1, 1]);
    view.rerender(<DebugPane taskId="TASK-001" stage={STAGE} working={false} onOpenItem={() => {}} />);
    await waitFor(() => expect(getPrompt).toHaveBeenCalledTimes(2));
    expect(getFacts).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByTestId("debug-refresh"));
    await waitFor(() => expect(getPrompt).toHaveBeenCalledTimes(3));
  });

  it("还没有运行过、没有移动过、没有被拒过：各写一句；取不到时写出原因", async () => {
    pane(false, { available: false, note: "服务这次启动以来，这个任务还没有运行过，所以还没有可看的系统提示。对助手说一句话之后再来看。", parts: [], text: "" },
      { records: [], rejections: [], latest_work_id: null });
    expect(await screen.findByText(/这个任务还没有运行过/)).toBeInTheDocument();
    expect(screen.getByTestId("debug-records")).toHaveTextContent("还没有人移动过阶段。");
    expect(screen.getByTestId("debug-rejections")).toHaveTextContent("还没有被拒的调用。");
    expect(screen.queryByTestId("debug-all-rejections")).toBeNull();
    cleanup();
    vi.restoreAllMocks();
    vi.spyOn(api, "debugSystemPrompt").mockRejectedValue(new Error("这个接口只在调试模式下可用：启动服务时加上 --debug。"));
    vi.spyOn(api, "debugStage").mockResolvedValue(FACTS);
    render(<DebugPane taskId="TASK-001" stage={STAGE} working={false} onOpenItem={() => {}} />);
    expect(await screen.findByTestId("debug-error")).toHaveTextContent("没有取到：这个接口只在调试模式下可用");
  });
});

describe("工作视图里的调试页签", () => {
  const info = (debug: boolean | undefined): ServiceInfo => ({ ok: true, app: "taskwright", version: "0.5.0", mode: "server", pid: 1, port: 8940,
    ...(debug === undefined ? {} : { debug }), capabilities: { exit: false, model: true, model_config: true } });
  async function page(debug: boolean | undefined) {
    const task = overallTask({ stage: STAGE });
    const state: WorkState = { ...initialWorkState("S-1"), phase: "ready", task, executor: { state: "idle", text: "", active_session: null } as WorkState["executor"] };
    (useWorkView as Mock).mockReturnValue({ state, log: [], dispatch: vi.fn(), stream: "open", loadError: null, loadErrorCode: null, reload: vi.fn() });
    vi.spyOn(api, "getTask").mockResolvedValue({ ...task, sessions: [], materials: [] } as unknown as TaskDetail);
    vi.spyOn(api, "listSessions").mockResolvedValue([]);
    const service = vi.spyOn(api, "serviceInfo").mockResolvedValue(info(debug));
    const getPrompt = vi.spyOn(api, "debugSystemPrompt").mockResolvedValue(PROMPT);
    vi.spyOn(api, "debugStage").mockResolvedValue(FACTS);
    render(
      <ConfigProvider button={{ autoInsertSpace: false }}><AntApp><ToastProvider><ServiceProvider>
        <WorkViewPage taskId="TASK-001" sessionId="S-1" />
      </ServiceProvider></ToastProvider></AntApp></ConfigProvider>,
    );
    await waitFor(() => expect(service).toHaveBeenCalled());
    return { getPrompt };
  }

  it("服务开着调试模式：右侧栏多一个「调试」页签，点开才去取数据", async () => {
    const { getPrompt } = await page(true);
    const tab = await screen.findByTestId("side-tab-debug");
    expect(tab).toHaveTextContent("调试");
    expect(getPrompt).not.toHaveBeenCalled();
    // 阶段条平常不在页面上，点开调试页签才看得到。
    expect(screen.queryByTestId("stage-bar")).toBeNull();
    fireEvent.click(tab);
    expect(await screen.findByTestId("debug-pane")).toBeInTheDocument();
    expect(screen.getByTestId("stage-bar")).toBeInTheDocument();
    await waitFor(() => expect(getPrompt).toHaveBeenCalledWith("TASK-001"));
  });

  it("服务没有开调试模式（或者是较早的后端、没有这一项）：没有这个页签，也不发调试的请求", async () => {
    for (const debug of [false, undefined]) {
      const { getPrompt } = await page(debug);
      await screen.findByTestId("side-tab-material");
      expect(screen.queryByTestId("side-tab-debug")).toBeNull();
      expect(getPrompt).not.toHaveBeenCalled();
      cleanup();
      vi.restoreAllMocks();
    }
  });
});
