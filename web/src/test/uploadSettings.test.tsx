// 设置页面的「上传」一栏：两种上传单个文件的上限各一个数（MB）。进来时取现在的值；改了才能保存，不是 1 到最大值的整数时不能保存并说明；
// 保存成功后重新取服务信息（上传框的说明与发送前的检查随之换成新的上限）；后端拒绝时把原话显示出来。
// 起点页的材料拖放框可以一次选几份文件。
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { App as AntApp, ConfigProvider } from "antd";
import { ApiError, api } from "../api/client";
import type { ModelConfig, ServiceInfo, UploadLimitsView } from "../api/types";
import { ServiceProvider } from "../components/ServiceControls";
import { ToastProvider } from "../components/Toasts";
import { MaterialsCard } from "../components/task/MaterialsCard";
import { SettingsPage } from "../pages/SettingsPage";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const info: ServiceInfo = { ok: true, app: "taskwright", version: "0.5.0", mode: "server", pid: 1, port: 8790, capabilities: { exit: false, model: true, model_config: true, model_test: true } };
const limits = (material_mb: number, knowledge_mb: number): UploadLimitsView => ({ material_mb, knowledge_mb, cap_mb: 50, defaults: { material_mb: 10, knowledge_mb: 20 } });

async function open(current: UploadLimitsView) {
  vi.spyOn(api, "serviceInfo").mockResolvedValue(info);
  vi.spyOn(api, "modelConfig").mockResolvedValue({ ok: true, providers: [], selection: { language: null, embedding: null } } as unknown as ModelConfig);
  vi.spyOn(api, "uploadLimits").mockResolvedValue(current);
  render(
    <ConfigProvider button={{ autoInsertSpace: false }}><AntApp><ToastProvider><ServiceProvider>
      <SettingsPage />
    </ServiceProvider></ToastProvider></AntApp></ConfigProvider>,
  );
  fireEvent.click(await screen.findByTestId("settings-nav-upload"));
  await waitFor(() => expect(screen.getByTestId("upload-material-input")).toHaveValue("10"));
}

const input = (testid: string) => screen.getByTestId(`${testid}-input`);
const type = (testid: string, value: string) => {
  fireEvent.change(input(testid), { target: { value } });
  fireEvent.blur(input(testid));
};

describe("设置页面的「上传」一栏", () => {
  it("进来时写着现在的两个上限与没有改过时的值；没有改时「保存」点不了", async () => {
    await open(limits(10, 20));
    expect(input("upload-knowledge")).toHaveValue("20");
    expect(screen.getByTestId("upload-material")).toHaveTextContent("没有改过时是 10 MB");
    expect(screen.getByTestId("upload-knowledge")).toHaveTextContent("没有改过时是 20 MB");
    expect(screen.getByTestId("upload-settings")).toHaveTextContent("都不能超过 50 MB");
    expect(screen.getByTestId("upload-save")).toBeDisabled();
  });

  it("改了之后保存：把两个数发给后端，写上新的值，再取一次服务信息", async () => {
    await open(limits(10, 20));
    const set = vi.spyOn(api, "setUploadLimits").mockResolvedValue(limits(30, 50));
    const before = vi.mocked(api.serviceInfo).mock.calls.length;
    type("upload-material", "30");
    type("upload-knowledge", "50");
    fireEvent.click(screen.getByTestId("upload-save"));
    await waitFor(() => expect(set).toHaveBeenCalledWith(30, 50));
    await waitFor(() => expect(vi.mocked(api.serviceInfo).mock.calls.length).toBeGreaterThan(before));
    expect(input("upload-material")).toHaveValue("30");
    expect(screen.getByTestId("upload-save")).toBeDisabled();
  });

  it("清空了一个数：说明要填 1 到 50 的整数，「保存」点不了", async () => {
    await open(limits(10, 20));
    type("upload-material", "");
    expect(await screen.findByTestId("upload-invalid")).toHaveTextContent("请填 1 到 50 的整数。");
    expect(screen.getByTestId("upload-save")).toBeDisabled();
  });

  it("后端拒绝时把原话写在下面", async () => {
    await open(limits(10, 20));
    vi.spyOn(api, "setUploadLimits").mockRejectedValue(new ApiError("bad_request", "material_mb 要写 1 到 50 的整数。", 400));
    type("upload-material", "12");
    fireEvent.click(screen.getByTestId("upload-save"));
    expect(await screen.findByTestId("upload-error")).toHaveTextContent("material_mb 要写 1 到 50 的整数。");
  });
});

describe("起点页的材料拖放框", () => {
  it("可以一次选几份文件", () => {
    render(<AntApp><ToastProvider><MaterialsCard taskId="T" materials={[]} info={null} onView={() => {}} onChanged={() => {}} /></ToastProvider></AntApp>);
    const picker = screen.getByTestId("materials-card").querySelector(".tp-drop input[type=file]");
    expect(picker).not.toBeNull();
    expect(picker).toHaveAttribute("multiple");
  });

  it("一次拖进来三份、其中一份类型不符：另两份各发一个上传请求，类型不符的那一份不发、报那句话", async () => {
    const withUpload: ServiceInfo = { ...info, upload: { max_bytes: 10 * 1024 * 1024, too_large_text: "单个文件不能超过 10 MB。", extensions: [".md", ".txt"], types_text: ".md 与 .txt", unsupported_type_text: "只接受 .md 与 .txt 文件。" } };
    const sent = vi.spyOn(api, "uploadMaterial").mockImplementation(async (_t, f) => ({ ok: true, path: `inputs/${f.name}` }));
    const changed = vi.fn();
    render(<AntApp><ToastProvider><MaterialsCard taskId="T" materials={[]} info={withUpload} onView={() => {}} onChanged={changed} /></ToastProvider></AntApp>);
    const zone = screen.getByTestId("materials-card").querySelector(".ant-upload-drag input[type=file]")!.parentElement!;
    const files = ["甲.md", "图.png", "乙.txt"].map((name) => new File(["x"], name));
    fireEvent.drop(zone, { dataTransfer: { files, items: [] } });
    expect(await screen.findByText("只接受 .md 与 .txt 文件。")).toBeInTheDocument();
    await waitFor(() => expect(sent).toHaveBeenCalledTimes(2));
    expect(sent.mock.calls.map(([, f]) => f.name).sort()).toEqual(["乙.txt", "甲.md"]);
    await waitFor(() => expect(changed).toHaveBeenCalledTimes(2));
  });
});
