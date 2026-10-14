// 工作视图里发布一个版本：点提示条上的「发布版本」、写发布说明、点「发布」之后，先照「下载 Word」的做法取这一修订的文档、把用到的图画成 PNG，
// 再带着页面看到的修订号、发布说明与图请任务服务发布（POST …/versions，带会话）；成了提示一句，被拒时把原因写在提示条上。
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { App as AntApp, ConfigProvider } from "antd";
import type { ReactNode } from "react";
import { api, ApiError } from "../api/client";
import type { Completion, Item, Task, TaskDetail } from "../api/types";
import { ToastProvider } from "../components/Toasts";
import { WorkViewPage } from "../pages/WorkViewPage";
import { useWorkView } from "../state/useWorkView";
import { initialWorkState } from "../state/workState";

vi.mock("../state/useWorkView", () => ({ useWorkView: vi.fn() }));
vi.mock("../components/diagram/mermaid", async (original) => ({
  ...(await original<typeof import("../components/diagram/mermaid")>()),
  figurePngs: vi.fn(async (figures: { diagram_id: string }[]) => figures.map((one) => ({ diagram_id: one.diagram_id, png: "iVBORw0KGgo=", width: 100, height: 60 }))),
}));
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const Wrap = ({ children }: { children: ReactNode }) => (
  <ConfigProvider button={{ autoInsertSpace: false }}><AntApp><ToastProvider>{children}</ToastProvider></AntApp></ConfigProvider>
);
const MET: Completion = { all_met: true, unmet_count: 0, brief: "", hints: [], conditions: [] } as unknown as Completion;
const UC = { item_id: "UC-001", collection: "功能用例", title: "借书", revision_no: 4, revision_by: "executor", revision_at: "", revisions: [4], fields: { 用例名称: "借书" },
  sources: [], reviews: [], confirmations: [{ revision_no: 4, accepted: true, basis: "viewed" }], confirmation_stale: false } as unknown as Item;
const task = {
  task_id: "TASK-001", task_name: "图书借阅", task_type: "演示", domain_tag: null, started_at: "",
  definition: { collections: [{ name: "功能用例", prefix: "UC", needs_review: false, review_rules: null, fields: [{ name: "用例名称", type: "文本", required: true, values: null }] }] },
  completion: MET, items: [UC], latest_revision: 4, versions: [],
} as unknown as Task;

function page() {
  (useWorkView as Mock).mockReturnValue({
    state: { ...initialWorkState("S1"), phase: "ready", task, latestRevision: 4, executor: { state: "idle", text: "", active_session: "S1" } },
    log: [], dispatch: vi.fn(), stream: "open", loadError: null, reload: vi.fn(),
  });
  vi.spyOn(api, "getTask").mockResolvedValue({ ...task, sessions: [], materials: [] } as unknown as TaskDetail);
  vi.spyOn(api, "listSessions").mockResolvedValue([]);
  const preview = vi.spyOn(api, "previewDocument").mockResolvedValue({ text: "# 文档\n\n```mermaid D-001\nflowchart TD\n  a --> b\n```\n" });
  const publish = vi.spyOn(api, "publishVersion").mockResolvedValue({ ok: true, op_id: "ui-op-1", version_no: 1, revision_no: 4, figure_count: null, figure_pictures: null });
  render(<Wrap><WorkViewPage taskId="TASK-001" sessionId="S1" /></Wrap>);
  return { preview, publish };
}

describe("工作视图里发布一个版本", () => {
  it("先取修订 4 的文档、把图画成 PNG，再带着修订号、发布说明与图、会话发布；成了提示「第 1 版已发布」", async () => {
    const { preview, publish } = page();
    fireEvent.click(await screen.findByTestId("submit-deliverable"));
    fireEvent.change(await screen.findByTestId("publish-note"), { target: { value: "  首版  " } });
    fireEvent.click(screen.getByRole("button", { name: "发布" }));
    await waitFor(() => expect(publish).toHaveBeenCalledTimes(1));
    expect(preview).toHaveBeenCalledWith("TASK-001", { revision_no: 4 });
    expect(publish).toHaveBeenCalledWith("TASK-001", "S1", { revision_no: 4, note: "首版", images: [{ diagram_id: "D-001", png: "iVBORw0KGgo=", width: 100, height: 60 }] });
    expect(await screen.findByText("第 1 版已发布。")).toBeInTheDocument();
  });

  it("被拒：照任务服务的原话写在提示条上", async () => {
    const { publish } = page();
    publish.mockRejectedValue(new ApiError("rejected", "这次没有发布：你看到的是修订 4，交付物现在已经是修订 5。请看过现在的内容再发布。", 422));
    fireEvent.click(await screen.findByTestId("submit-deliverable"));
    fireEvent.click(await screen.findByRole("button", { name: "发布" }));
    expect(await screen.findByTestId("submit-error")).toHaveTextContent("这次没有发布：你看到的是修订 4，交付物现在已经是修订 5。");
  });
});
