// 设置页面的「模型」一栏：只读、添加时被拒、删除被占用的模型服务、更换时的可选范围、添加之后随即获取模型列表、模型很多时的收法。
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { App as AntApp, ConfigProvider } from "antd";
import { api, ApiError } from "../api/client";
import type { ModelConfig, Provider, ServiceInfo } from "../api/types";
import { ServiceProvider } from "../components/ServiceControls";
import { ToastProvider } from "../components/Toasts";
import { SettingsPage } from "../pages/SettingsPage";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const service: ServiceInfo = { ok: true, app: "taskwright", version: "0.4.1", mode: "server", pid: 1, port: 8940, capabilities: { exit: false, model: true, model_config: true } };

const deepseek = (over: Partial<Provider> = {}): Provider => ({
  id: "taskwright-deepseek", managed: true, kind: "deepseek", name: "DeepSeek", base_url: "https://api.deepseek.com",
  key: { set: true, last4: "3f9c" }, status: { checked_at: "2026-09-29T10:40:00Z", ok: true, message: "" },
  models: [{ id: "deepseek-chat", type: "language", enabled: true, context_window: 65536, context_source: "service" }],
  models_fetched_at: "2026-09-29T10:41:00Z", in_use: [], ...over,
});
const ollama = (over: Partial<Provider> = {}): Provider => ({
  id: "taskwright-ollama", managed: true, kind: "ollama", name: "本机的 ollama", base_url: "http://127.0.0.1:11434", key: { set: false, last4: null },
  status: { checked_at: "2026-09-29T10:40:00Z", ok: true, message: "" },
  models: [
    { id: "qianwen:14b", type: "language", enabled: true, context_window: null, context_source: null },
    { id: "embed:large", type: "embedding", enabled: true, context_window: null, context_source: null },
  ],
  models_fetched_at: null, in_use: [], ...over,
});
const handWritten: Provider = {
  id: "my-gateway", managed: false, kind: null, name: "我的网关", base_url: null, key: null, status: null,
  models: [{ id: "gateway-chat", type: "language", enabled: true, context_window: null, context_source: null }], models_fetched_at: null, in_use: [],
};
const config = (over: Partial<ModelConfig> = {}): ModelConfig => ({
  ok: true, editable: true, notice: null, selection: { language: null, embedding: null }, fallback: { model: "fake/fake-model", from: "启动配置" },
  providers: [deepseek(), ollama(), handWritten], ...over,
});

function page(cfg: ModelConfig) {
  vi.spyOn(api, "serviceInfo").mockResolvedValue(service);
  const load = vi.spyOn(api, "modelConfig").mockResolvedValue(cfg);
  render(
    <ConfigProvider button={{ autoInsertSpace: false }}><AntApp><ToastProvider><ServiceProvider>
      <SettingsPage />
    </ServiceProvider></ToastProvider></AntApp></ConfigProvider>,
  );
  return load;
}

describe("设置页面的「模型」一栏", () => {
  it("后端给 editable 为假时整栏仍只读：顶上是后端的说明，没有更换、添加、获取、删除的按钮，勾选框与输入框是灰的，密钥只写「已设置」", async () => {
    // 现在的后端 editable 恒为 true；页面的只读分支留着，这里照后端给假时的样子测。
    const notice = "这里只能看，不能改。";
    page(config({ editable: false, notice, providers: [deepseek({ base_url: null, key: { set: true, last4: null } }), handWritten],
      selection: { language: { provider_id: "taskwright-deepseek", model_id: "deepseek-chat" }, embedding: null } }));
    expect(await screen.findByTestId("readonly-notice")).toHaveTextContent(notice);
    for (const name of ["更换", "选择", "添加模型服务", "获取模型列表", "删除这个模型服务", "保存改动"]) {
      expect(screen.queryByRole("button", { name })).toBeNull();
    }
    const detail = screen.getByTestId("provider-detail");
    expect(within(detail).getByRole("checkbox")).toBeDisabled();
    expect(within(detail).getByRole("spinbutton")).toBeDisabled();
    expect(detail).toHaveTextContent("已设置");
    expect(detail).not.toHaveTextContent("3f9c");
    expect(detail).not.toHaveTextContent("接口地址");
    expect(screen.queryByTestId("rekey")).toBeNull();
    expect(screen.queryByText("手工添加一个模型")).toBeNull();
  });

  it("没有选语言模型时写出现在用的模型与来源，来源照后端给的原样写；没有选嵌入模型时写只能按字面查找", async () => {
    page(config({ fallback: { model: "local/qwen", from: "助手程序的设置" } }));
    expect(await screen.findByTestId("current-language")).toHaveTextContent("还没有选。现在用的是：local/qwen（来自助手程序的设置）。");
    expect(screen.getByTestId("current-embedding")).toHaveTextContent("还没有选。知识库只能按字面查找。");
    expect(screen.getByTestId("current-language")).not.toHaveTextContent("pi");
  });

  it("添加时后端回 rejected：停在添加的画面，按 data.field 把后端那句话写在接口地址下面", async () => {
    page(config());
    const text = "连不上这个地址。请确认模型服务已经启动，地址与端口没有写错。";
    const add = vi.spyOn(api, "addProvider").mockRejectedValue(new ApiError("rejected", text, 422, { field: "base_url" }));
    fireEvent.click(await screen.findByTestId("add-provider"));
    fireEvent.click(await screen.findByTestId("add-save"));
    expect(await screen.findByTestId("err-base_url")).toHaveTextContent(text);
    expect(add).toHaveBeenCalledWith({ kind: "ollama", base_url: "http://127.0.0.1:11434" });
    expect(screen.getByTestId("add-provider")).toBeInTheDocument();
    expect(screen.queryByTestId("err-api_key")).toBeNull();
  });

  it("添加 DeepSeek 时密钥被拒：那句话写在 API 密钥下面", async () => {
    page(config());
    vi.spyOn(api, "addProvider").mockRejectedValue(new ApiError("rejected", "模型服务拒绝了这个密钥。", 422, { field: "api_key" }));
    fireEvent.click(await screen.findByTestId("add-provider"));
    fireEvent.click(screen.getByText("DeepSeek", { selector: ".ot" }));
    fireEvent.change(screen.getByTestId("add-key"), { target: { value: "sk-wrong" } });
    fireEvent.click(screen.getByTestId("add-save"));
    expect(await screen.findByTestId("err-api_key")).toHaveTextContent("模型服务拒绝了这个密钥。");
  });

  it("添加成功之后回到「模型」一栏，右边打开新的模型服务，并随即获取一次它的模型列表", async () => {
    const added = ollama({ id: "taskwright-ollama-2", name: "ollama", models: [] });
    const load = page(config());
    vi.spyOn(api, "addProvider").mockResolvedValue({ ok: true, provider: added });
    load.mockResolvedValue(config({ providers: [deepseek(), ollama(), added, handWritten] }));
    const fetched = vi.spyOn(api, "fetchModels").mockResolvedValue({ ok: true, result: "listed", message: "",
      provider: { ...added, models: [{ id: "llama:8b", type: "language", enabled: false, context_window: null, context_source: null }] } });
    fireEvent.click(await screen.findByTestId("add-provider"));
    fireEvent.click(screen.getByTestId("add-save"));
    expect(await screen.findByTestId("model-llama:8b")).toBeInTheDocument();
    expect(fetched).toHaveBeenCalledWith("taskwright-ollama-2");
    expect(screen.getByTestId("provider-detail")).toHaveTextContent("ollama");
  });

  it("模型服务的模型正被选用（in_use）时删除按钮是灰的，旁边写明是哪一个模型", async () => {
    page(config({ providers: [deepseek({ in_use: ["language"] })], selection: { language: { provider_id: "taskwright-deepseek", model_id: "deepseek-chat" }, embedding: null } }));
    const button = await screen.findByTestId("delete-provider");
    expect(button).toBeDisabled();
    expect(screen.getByTestId("delete-blocked")).toHaveTextContent("这个模型服务的模型正在被使用（助手用的语言模型 deepseek-chat），不能删除。");
  });

  it("更换语言模型时，在这里添加的模型服务里还没有填上下文长度的模型不能选，写明原因；手工登记的那一组照样列出、可以选", async () => {
    page(config());
    fireEvent.click(await screen.findByTestId("pick-language-button"));
    const dialog = await screen.findByTestId("pick-language");
    // 每个选项的 data-testid 落在单选框上，选项的文字在包着它的那张卡片里。
    const unfilled = within(dialog).getByTestId("pick-taskwright-ollama-qianwen:14b");
    expect(unfilled).toBeDisabled();
    expect(unfilled.closest(".po")).toHaveTextContent("还没有填上下文长度。");
    const hand = within(dialog).getByTestId("pick-my-gateway-gateway-chat");
    expect(hand).not.toBeDisabled();
    expect(dialog).toHaveTextContent("我的网关");
    // 嵌入模型不出现在语言模型的列表里。
    expect(within(dialog).queryByText("embed:large")).toBeNull();
  });

  it("选定手工登记的语言模型：嵌入模型原样传回，之后「现在用的模型」换成它", async () => {
    const load = page(config());
    const embedding = null;
    const pick = vi.spyOn(api, "selectModels").mockResolvedValue({ ok: true, note: "更换之后，下一次打开或者新建会话时生效。正在进行的会话不受影响。",
      selection: { language: { provider_id: "my-gateway", model_id: "gateway-chat" }, embedding } });
    fireEvent.click(await screen.findByTestId("pick-language-button"));
    const dialog = await screen.findByTestId("pick-language");
    fireEvent.click(within(dialog).getByTestId("pick-my-gateway-gateway-chat"));
    load.mockResolvedValue(config({ selection: { language: { provider_id: "my-gateway", model_id: "gateway-chat" }, embedding } }));
    fireEvent.click(screen.getByTestId("use-model"));
    expect(await screen.findByText("gateway-chat", { selector: ".mname" })).toBeInTheDocument();
    expect(pick).toHaveBeenCalledWith({ language: { provider_id: "my-gateway", model_id: "gateway-chat" }, embedding: null });
  });

  it("手工登记的模型服务点开只能看：顶上一句说明，没有获取、删除与手工添加", async () => {
    page(config());
    fireEvent.click(await screen.findByTestId("provider-my-gateway"));
    expect(await screen.findByTestId("readonly-provider")).toHaveTextContent("这个模型服务是在配置文件里手工登记的，这里只能看，不能改。");
    expect(screen.queryByTestId("fetch-models")).toBeNull();
    expect(screen.queryByTestId("delete-provider")).toBeNull();
    expect(screen.queryByText("手工添加一个模型")).toBeNull();
    expect(screen.getByTestId("external-group")).toHaveTextContent("配置文件里手工登记的");
  });

  it("保存模型清单时后端回 rejected：把后端那句话写在保存按钮下面", async () => {
    page(config({ providers: [ollama()] }));
    const text = "模型「qianwen:14b」还没有填上下文长度，填了才能保存。";
    vi.spyOn(api, "updateProvider").mockRejectedValue(new ApiError("rejected", text, 422, { field: "models" }));
    fireEvent.click(within(await screen.findByTestId("model-embed:large")).getByRole("checkbox"));
    fireEvent.click(screen.getByTestId("save-models"));
    expect(await screen.findByTestId("save-error")).toHaveTextContent(text);
  });

  it("模型超过 10 个时平时只列勾上的，其余收成一行；点「显示全部」之后列出全部并可以按模型名筛选", async () => {
    const models = Array.from({ length: 12 }, (_, i) => ({ id: `m-${i}`, type: "language" as const, enabled: i < 2, context_window: 4096, context_source: "service" as const }));
    page(config({ providers: [ollama({ models })] }));
    await screen.findByTestId("model-m-0");
    expect(screen.queryByTestId("model-m-5")).toBeNull();
    expect(screen.getByText(/另有 10 个模型没有勾上。/)).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("show-all"));
    expect(screen.getByTestId("model-m-5")).toBeInTheDocument();
    fireEvent.change(screen.getByTestId("model-filter"), { target: { value: "m-1" } });
    expect(screen.getByTestId("model-m-11")).toBeInTheDocument();
    expect(screen.queryByTestId("model-m-5")).toBeNull();
  });
});
