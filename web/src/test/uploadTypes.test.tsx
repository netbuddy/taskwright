// 允许上传的类型取自服务信息：文件选择框的过滤（任务页上传框与对话区附件按钮）按 upload.extensions，上传框说明里「只收……」
// 那半句按 upload.types_text（叫法与连法都在后端，前端不另存一份）。还没取到服务信息时不过滤、不写这半句。

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { App as AntApp, ConfigProvider } from "antd";
import { api } from "../api/client";
import type { ServiceInfo, TaskDetail } from "../api/types";
import { ServiceProvider } from "../components/ServiceControls";
import { ToastProvider } from "../components/Toasts";
import { Conversation } from "../components/work/Conversation";
import { uploadAccept, uploadTypesText } from "../model/upload";
import { TaskPage } from "../pages/TaskPage";
import { settled } from "./settled";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const info = (extensions?: string[], typesText?: string): ServiceInfo => ({
  ok: true, app: "taskwright", version: "0.3.0", mode: "server", pid: 1, port: 8940, capabilities: { exit: false, model: true },
  upload: { max_bytes: 5 * 1024 * 1024, too_large_text: "单个文件不能超过 5 MB。", ...(extensions ? { extensions } : {}), ...(typesText ? { types_text: typesText } : {}) },
});
const noop = () => undefined;

describe("类型的叫法与文件过滤", () => {
  it("「只收……」之后照写后端给的 types_text；没有这一项或没有服务信息时为 null", () => {
    expect(uploadTypesText(info([".md", ".txt", ".docx"], ".md、.txt 与 Word 的 .docx"))).toBe("只收 .md、.txt 与 Word 的 .docx");
    expect(uploadTypesText(info([".md", ".pdf"], ".md 与 .pdf"))).toBe("只收 .md 与 .pdf");
    expect(uploadTypesText(info([".md", ".txt", ".docx"]))).toBeNull();
    expect(uploadTypesText(info())).toBeNull();
    expect(uploadTypesText(null)).toBeNull();
  });

  it("文件选择框的过滤是后端给的扩展名；没有时不过滤", () => {
    expect(uploadAccept(info([".md", ".txt", ".docx"]))).toBe(".md,.txt,.docx");
    expect(uploadAccept(info())).toBeUndefined();
    expect(uploadAccept(null)).toBeUndefined();
  });
});

describe("两处入口", () => {
  const detail = {
    task_id: "TASK-T", task_name: "类型", task_type: "演示", domain_tag: null, status: "进行中", started_at: "", ended_at: null,
    definition: { collections: [] }, items: [], completion: null, sessions: [], materials: [],
  } as unknown as TaskDetail;

  it("任务页上传框：说明与过滤都按后端给的类型", async () => {
    vi.spyOn(api, "getTask").mockResolvedValue(detail);
    vi.spyOn(api, "listTasks").mockResolvedValue([]);
    vi.spyOn(api, "serviceInfo").mockResolvedValue(info([".md", ".pdf"], ".md 与 .pdf"));
    render(<ConfigProvider><AntApp><ToastProvider><ServiceProvider><TaskPage taskId="TASK-T" /></ServiceProvider></ToastProvider></AntApp></ConfigProvider>);
    const hint = await screen.findByTestId("upload-hint");
    await waitFor(() => expect(hint).toHaveTextContent("（只收 .md 与 .pdf，单个不超过 5 MB）"));
    expect(document.querySelector("input[type=file]")).toHaveAttribute("accept", ".md,.pdf");
  });

  it("对话区附件按钮：过滤按后端给的类型；取不到服务信息时不过滤", async () => {
    const chat = () => render(<ConfigProvider><AntApp><ToastProvider><ServiceProvider>
      <Conversation messages={[]} currentWork={null} outgoing={[]} task={null} disabled={false} disabledReason={null}
        handlers={{ onAction: noop, onMessage: noop }} onSend={noop} onUndo={noop} onOpenItem={noop} onAttach={noop}
        hasEarlier={false} onLoadEarlier={noop} revisionOf={() => null} attachments={[]} />
    </ServiceProvider></ToastProvider></AntApp></ConfigProvider>);
    vi.spyOn(api, "serviceInfo").mockResolvedValue(info([".md", ".txt", ".docx"]));
    chat();
    await waitFor(() => expect(document.querySelector("input[type=file]")).toHaveAttribute("accept", ".md,.txt,.docx"));
    cleanup();
    const failed = vi.spyOn(api, "serviceInfo").mockRejectedValue(new Error("没有这个接口"));
    chat();
    // 取不到时页面上不留痕迹；上一次渲染已经调用过这个接口，只等「被调用」一开始就成立。等这次失败处理完再看。
    await settled(failed);
    expect(document.querySelector("input[type=file]")).not.toHaveAttribute("accept");
  });
});
