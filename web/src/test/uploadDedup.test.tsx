// 上传被拒绝时的页面：内容与已有材料相同（duplicate_content）、同名不同内容（name_taken）两种拒绝，都用现有的红色提示照写后端的原话，
// 材料清单不变（任务页不重读任务、工作视图不添附件）。类型不符的文件在发送之前就拦下，显示服务信息里后端给的那句话；
// 还没取到服务信息时不拦，照常发给后端。任务页上传框与对话区的「附一份材料」两处入口都这样。

import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { App as AntApp, ConfigProvider } from "antd";
import { ApiError, api } from "../api/client";
import type { ServiceInfo, Task, TaskDetail } from "../api/types";
import { ServiceProvider } from "../components/ServiceControls";
import { ToastProvider } from "../components/Toasts";
import { unsupportedTypeText } from "../model/upload";
import { TaskPage } from "../pages/TaskPage";
import { WorkViewPage } from "../pages/WorkViewPage";
import { useWorkView } from "../state/useWorkView";
import { initialWorkState } from "../state/workState";

vi.mock("../state/useWorkView", () => ({ useWorkView: vi.fn() }));
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const TYPE_TEXT = "只接受 .md、.txt 与 Word 的 .docx 文件。";
const DUPLICATE = "这份文件与已有的材料《需求.md》内容完全相同，没有重复保存。";
const NAME_TAKEN = "这个任务里已经有一份叫《需求.md》的材料，内容与这份不同。请给文件换一个名字再上传。";
const info: ServiceInfo = {
  ok: true, app: "taskwright", version: "0.3.0", mode: "server", pid: 1, port: 8940, capabilities: { exit: false, model: true },
  upload: { max_bytes: 5 * 1024 * 1024, too_large_text: "单个文件不能超过 5 MB。", extensions: [".md", ".txt", ".docx"],
    types_text: ".md、.txt 与 Word 的 .docx", unsupported_type_text: TYPE_TEXT },
};
const refusals = [
  ["内容与已有材料相同", new ApiError("duplicate_content", DUPLICATE, 409, { path: "inputs/需求.md" }), DUPLICATE],
  ["同名不同内容", new ApiError("name_taken", NAME_TAKEN, 409, { path: "inputs/需求.md" }), NAME_TAKEN],
] as const;
const file = (name: string) => new File(["买家可以申请退货。"], name, { type: "text/plain" });
const Wrap = ({ children }: { children: ReactNode }) => (
  <ConfigProvider button={{ autoInsertSpace: false }}><AntApp><ToastProvider><ServiceProvider>{children}</ServiceProvider></ToastProvider></AntApp></ConfigProvider>
);

describe("unsupportedTypeText", () => {
  it("扩展名不在后端给的清单里时给后端那句话，大小写不论；类型对、没有服务信息、缺扩展名或缺那句话时为 null", () => {
    expect(unsupportedTypeText(info, { name: "图.png" })).toBe(TYPE_TEXT);
    expect(unsupportedTypeText(info, { name: "没有扩展名" })).toBe(TYPE_TEXT);
    expect(unsupportedTypeText(info, { name: "需求.md.png" })).toBe(TYPE_TEXT);
    expect(unsupportedTypeText(info, { name: "需求.MD" })).toBeNull();
    expect(unsupportedTypeText(info, { name: "规则.docx" })).toBeNull();
    expect(unsupportedTypeText(null, { name: "图.png" })).toBeNull();
    expect(unsupportedTypeText({ ...info, upload: { ...info.upload!, unsupported_type_text: undefined } }, { name: "图.png" })).toBeNull();
    expect(unsupportedTypeText({ ...info, upload: { ...info.upload!, extensions: undefined } }, { name: "图.png" })).toBeNull();
  });
});

describe("任务页的上传框", () => {
  const detail = {
    task_id: "TASK-D", task_name: "去重", task_type: "演示", domain_tag: null, status: "进行中", started_at: "", ended_at: null,
    definition: { collections: [] }, items: [], completion: null, sessions: [],
    materials: [{ path: "inputs/需求.md", bytes: 27, modified_at: "2026-09-27T10:00:00+08:00", derived_from: null }],
  } as unknown as TaskDetail;

  function page(serviceInfo: Promise<ServiceInfo>, upload: () => Promise<{ path: string }>) {
    vi.spyOn(api, "getTask").mockResolvedValue(detail);
    vi.spyOn(api, "listTasks").mockResolvedValue([]);
    vi.spyOn(api, "serviceInfo").mockReturnValue(serviceInfo);
    const sent = vi.spyOn(api, "uploadMaterial").mockImplementation(upload);
    render(<Wrap><TaskPage taskId="TASK-D" /></Wrap>);
    return sent;
  }
  const choose = async (f: File) => {
    const input = await waitFor(() => document.querySelector("input[type=file]") as HTMLInputElement);
    fireEvent.change(input, { target: { files: [f] } });
  };

  for (const [label, error, text] of refusals) {
    it(`${label}：红色提示照写后端的原话，材料清单不变，不重读任务`, async () => {
      const sent = page(Promise.resolve(info), () => Promise.reject(error));
      await screen.findByText(/把文件拖到这里/);
      await choose(file("需求.md"));
      expect(await screen.findByText(text)).toBeInTheDocument();
      expect(sent).toHaveBeenCalledTimes(1);
      expect(screen.getAllByTestId("material-row")).toHaveLength(1);
      expect(api.getTask).toHaveBeenCalledTimes(1);
    });
  }

  it("类型不符（经文件选择框选了「所有文件」）：不发请求，红色提示写服务信息里后端给的那句话", async () => {
    const sent = page(Promise.resolve(info), () => Promise.resolve({ path: "inputs/图.png" }));
    await waitFor(() => expect(api.serviceInfo).toHaveBeenCalled());
    await screen.findByText(/只收 \.md/);
    await choose(file("图.png"));
    expect(await screen.findByText(TYPE_TEXT)).toBeInTheDocument();
    expect(sent).not.toHaveBeenCalled();
  });

  it("类型不符的文件拖进来（拖放不经文件选择框的过滤）：同样显示那句话、不发请求", async () => {
    const sent = page(Promise.resolve(info), () => Promise.resolve({ path: "inputs/图.png" }));
    await screen.findByText(/只收 \.md/);
    const zone = document.querySelector(".ant-upload-drag input[type=file]")!.parentElement!;
    fireEvent.drop(zone, { dataTransfer: { files: [file("图.png")], items: [] } });
    expect(await screen.findByText(TYPE_TEXT)).toBeInTheDocument();
    expect(sent).not.toHaveBeenCalled();
  });

  it("取不到服务信息时不按类型拦：照常发给后端", async () => {
    const sent = page(Promise.reject(new Error("没有这个接口")), () => Promise.reject(new ApiError("unsupported_type", TYPE_TEXT, 415)));
    await waitFor(() => expect(api.serviceInfo).toHaveBeenCalled());
    await screen.findByText(/把文件拖到这里/);
    await choose(file("图.png"));
    await waitFor(() => expect(sent).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(TYPE_TEXT)).toBeInTheDocument();
  });
});

describe("对话区的「附一份材料」", () => {
  const task = {
    task_id: "TASK-D", task_name: "去重", task_type: "演示", domain_tag: null, status: "进行中", started_at: "", ended_at: null,
    definition: { collections: [] }, completion: null, items: [],
  } as unknown as Task;

  function page(upload: () => Promise<{ path: string }>) {
    vi.spyOn(api, "listSessions").mockResolvedValue([]);
    vi.spyOn(api, "serviceInfo").mockResolvedValue(info);
    const sent = vi.spyOn(api, "uploadMaterial").mockImplementation(upload);
    const dispatch = vi.fn();
    (useWorkView as Mock).mockReturnValue({
      state: { ...initialWorkState("S1"), phase: "ready", task, executor: { state: "idle", text: "", active_session: "S1" } },
      log: [], dispatch, stream: "open", loadError: null, reload: vi.fn(),
    });
    render(<Wrap><WorkViewPage taskId="TASK-D" sessionId="S1" /></Wrap>);
    return { sent, dispatch };
  }
  const attach = async (f: File) => {
    const input = await waitFor(() => document.querySelector(".chat-in input[type=file]") as HTMLInputElement);
    fireEvent.change(input, { target: { files: [f] } });
  };

  for (const [label, error, text] of refusals) {
    it(`${label}：红色提示照写后端的原话，不添附件，不改页面状态`, async () => {
      const { sent, dispatch } = page(() => Promise.reject(error));
      await attach(file("需求.md"));
      expect(await screen.findByText(text)).toBeInTheDocument();
      expect(sent).toHaveBeenCalledWith("TASK-D", expect.any(File), "S1");
      expect(document.body.textContent).not.toContain("附件：");
      expect(dispatch).not.toHaveBeenCalled();
    });
  }

  it("类型不符：不发请求，红色提示写服务信息里后端给的那句话", async () => {
    const { sent } = page(() => Promise.resolve({ path: "inputs/图.png" }));
    await waitFor(() => expect(document.querySelector(".chat-in input[type=file]")).toHaveAttribute("accept", ".md,.txt,.docx"));
    await attach(file("图.png"));
    expect(await screen.findByText(TYPE_TEXT)).toBeInTheDocument();
    expect(sent).not.toHaveBeenCalled();
  });
});
