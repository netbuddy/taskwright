// 设置页面的「模型」一栏：添加时先选用途、清单按用途分组、只读、添加时被拒、删除被占用的模型服务、更换时的可选范围、添加之后随即获取模型列表、模型很多时的收法、测试语言模型、测试嵌入模型、更换嵌入模型时知识库里的文档要重新换算。
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { App as AntApp, ConfigProvider } from "antd";
import { api, ApiError } from "../api/client";
import type { ModelConfig, ModelTestResult, Provider, ServiceInfo } from "../api/types";
import { ServiceProvider } from "../components/ServiceControls";
import { ToastProvider } from "../components/Toasts";
import { SettingsPage } from "../pages/SettingsPage";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const service: ServiceInfo = { ok: true, app: "taskwright", version: "0.4.1", mode: "server", pid: 1, port: 8940, capabilities: { exit: false, model: true, model_config: true } };

const deepseek = (over: Partial<Provider> = {}): Provider => ({
  id: "taskwright-deepseek", managed: true, kind: "deepseek", purpose: "language", name: "DeepSeek", base_url: "https://api.deepseek.com",
  key: { set: true, last4: "3f9c" }, status: { checked_at: "2026-09-29T10:40:00Z", ok: true, message: "" },
  models: [{ id: "deepseek-chat", enabled: true, context_window: 65536, context_source: "service" }],
  models_fetched_at: "2026-09-29T10:41:00Z", in_use: [], ...over,
});
const ollama = (over: Partial<Provider> = {}): Provider => ({
  id: "taskwright-ollama", managed: true, kind: "ollama", purpose: "language", name: "本机的 ollama", base_url: "http://127.0.0.1:11434", key: { set: false, last4: null },
  status: { checked_at: "2026-09-29T10:40:00Z", ok: true, message: "" },
  models: [{ id: "qianwen:14b", enabled: true, context_window: null, context_source: null }],
  models_fetched_at: null, in_use: [], ...over,
});
/** 同一台 ollama 上的嵌入模型：另一个模型服务，用途是嵌入模型。 */
const embedder = (over: Partial<Provider> = {}): Provider => ({
  id: "taskwright-ollama-embedding", managed: true, kind: "ollama", purpose: "embedding", name: "本机的 ollama（嵌入模型）", base_url: "http://127.0.0.1:11434", key: { set: false, last4: null },
  status: { checked_at: "2026-09-29T10:40:00Z", ok: true, message: "" },
  models: [{ id: "embed:large", enabled: true, context_window: null, context_source: null }],
  models_fetched_at: null, in_use: [], ...over,
});
const codex = (over: Partial<Provider> = {}): Provider => ({
  id: "taskwright-codex", managed: true, kind: "codex", purpose: "language", name: "Codex 订阅", base_url: null, key: null,
  status: { checked_at: "2026-09-29T10:40:00Z", ok: false, message: "", logged_in: false }, models: [], models_fetched_at: null, in_use: [], ...over,
});
const handWritten: Provider = {
  id: "my-gateway", managed: false, kind: null, purpose: "language", name: "我的网关", base_url: null, key: null, status: null,
  models: [{ id: "gateway-chat", enabled: true, context_window: null, context_source: null }], models_fetched_at: null, in_use: [],
};
const config = (over: Partial<ModelConfig> = {}): ModelConfig => ({
  ok: true, editable: true, notice: null, selection: { language: null, embedding: null }, fallback: { model: "fake/fake-model", from: "启动配置" },
  providers: [deepseek(), ollama(), embedder(), handWritten], ...over,
});

/** 后端有测试语言模型的接口时的服务信息。 */
const withTest: ServiceInfo = { ...service, capabilities: { ...service.capabilities, model_test: true } };
const tested = (over: Partial<ModelTestResult> = {}): ModelTestResult => ({
  ok: true, result: "passed", model: "taskwright-deepseek/deepseek-chat", seconds: 3.2, tool_calls: 1,
  question: "请读当前目录下的文件 inventory.txt，然后用一句话回答：这批货一共有多少箱？", reply: "这批货一共有 42 箱。", reason: null, ...over,
});
const chosen = { selection: { language: { provider_id: "taskwright-deepseek", model_id: "deepseek-chat" }, embedding: null } };
/** 两种模型都选定了；嵌入模型的查询前缀里有换行。 */
const PREFIX = "Instruct: 找相关段落\nQuery:";
const bothChosen = { selection: { ...chosen.selection, embedding: { provider_id: "taskwright-ollama-embedding", model_id: "embed:large", query_prefix: PREFIX } } };
const embedded = (over: Partial<ModelTestResult> = {}): ModelTestResult => ({
  ok: true, result: "passed", model: "taskwright-ollama-embedding/embed:large", seconds: 0.4, question: `${PREFIX}这批货一共有 42 箱。`, dimensions: 1024, reason: null, ...over,
});

function page(cfg: ModelConfig, info: ServiceInfo = service) {
  vi.spyOn(api, "serviceInfo").mockResolvedValue(info);
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

  it("没有选语言模型时写出现在用的模型与来源，来源照后端给的原样写；没有选嵌入模型时写助手查知识库只按字面找", async () => {
    page(config({ fallback: { model: "local/qwen", from: "助手程序的设置" } }));
    expect(await screen.findByTestId("current-language")).toHaveTextContent("还没有选。现在用的是：local/qwen（来自助手程序的设置）。");
    expect(screen.getByTestId("current-embedding")).toHaveTextContent("还没有选。助手查知识库只按字面找，用词不同的找不到。");
    expect(screen.getByTestId("current-language")).not.toHaveTextContent("pi");
  });

  it("Codex 订阅还没有登录时给出两行：第一行是启动的命令，第二行是启动之后要输入的指令与一句说明；「复制」只复制第一行", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    try {
      page(config({ providers: [codex()] }));
      const login = await screen.findByTestId("codex-login");
      expect(within(login).getByTestId("login-command")).toHaveTextContent(/^pi$/);
      const second = within(login).getByTestId("login-instruction");
      expect(second).toHaveTextContent(/^\/login$/);
      expect(second.parentElement).toHaveTextContent("/login输入后在列表里选 OpenAI，按提示用 ChatGPT 订阅登录。");
      expect(login).not.toHaveTextContent("登录的命令");
      fireEvent.click(within(login).getByRole("button", { name: /复制/ }));
      expect(writeText).toHaveBeenCalledTimes(1);
      expect(writeText).toHaveBeenCalledWith("pi");
    } finally {
      delete (navigator as { clipboard?: unknown }).clipboard;
    }
  });

  it("Codex 订阅的详情里有「更新模型目录」，别的模型服务没有；点了先问一句，写明会访问一次外网；点取消不发请求", async () => {
    page(config({ providers: [codex(), deepseek()] }));
    const refresh = vi.spyOn(api, "refreshCatalog").mockResolvedValue({ ok: true, result: "refreshed", message: "" });
    const button = await screen.findByTestId("refresh-catalog");
    expect(button).toHaveTextContent(/^更新模型目录$/);
    fireEvent.click(button);
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("更新模型目录");
    expect(dialog).toHaveTextContent("会访问一次外网，更新可选模型的目录。");
    fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
    expect(refresh).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("provider-taskwright-deepseek"));
    await waitFor(() => expect(screen.getByTestId("provider-detail")).toHaveTextContent("DeepSeek"));
    expect(screen.getByTestId("fetch-models")).toBeInTheDocument();
    expect(screen.queryByTestId("refresh-catalog")).toBeNull();
  });

  it("更新模型目录当中按钮写「正在更新……」，「获取模型列表」不能点；更新好之后提示一句，并随即重新获取一次模型列表", async () => {
    const fresh = codex({ models: [{ id: "gpt-new", enabled: false, context_window: 272000, context_source: "service" }] });
    page(config({ providers: [codex()] }));
    let finish: (r: { ok: true; result: "refreshed" | "failed"; message: string }) => void = () => {};
    const refresh = vi.spyOn(api, "refreshCatalog").mockReturnValue(new Promise((ok) => { finish = ok; }));
    const fetched = vi.spyOn(api, "fetchModels").mockResolvedValue({ ok: true, result: "listed", message: "", provider: fresh });
    fireEvent.click(await screen.findByTestId("refresh-catalog"));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "更新" }));
    await waitFor(() => expect(screen.getByTestId("refresh-catalog")).toHaveTextContent("正在更新……"));
    expect(refresh).toHaveBeenCalledWith("taskwright-codex");
    expect(screen.getByTestId("fetch-models")).toBeDisabled();
    expect(fetched).not.toHaveBeenCalled();
    finish({ ok: true, result: "refreshed", message: "" });
    expect(await screen.findByText("模型目录已更新。")).toBeInTheDocument();
    await waitFor(() => expect(fetched).toHaveBeenCalledWith("taskwright-codex"));
    expect(await screen.findByTestId("model-gpt-new")).toBeInTheDocument();
    expect(screen.getByTestId("refresh-catalog")).toHaveTextContent(/^更新模型目录$/);
    expect(screen.queryByTestId("refresh-note")).toBeNull();
  });

  it("更新模型目录没有成功时把后端给的原因写在下面，不重新获取模型列表", async () => {
    page(config({ providers: [codex()] }));
    const text = "更新模型目录没有成功：没能从外网取回新的模型目录。请检查这台电脑能不能访问外网，稍后再试。";
    vi.spyOn(api, "refreshCatalog").mockResolvedValue({ ok: true, result: "failed", message: text });
    const fetched = vi.spyOn(api, "fetchModels");
    fireEvent.click(await screen.findByTestId("refresh-catalog"));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "更新" }));
    expect(await screen.findByTestId("refresh-note")).toHaveTextContent(text);
    expect(fetched).not.toHaveBeenCalled();
    expect(screen.queryByText("模型目录已更新。")).toBeNull();
    expect(screen.getByTestId("refresh-catalog")).toHaveTextContent(/^更新模型目录$/);
  });

  it("更新模型目录的接口报错（例如已经在更新）时把那句话提示出来，下面不写原因，也不重新获取模型列表", async () => {
    page(config({ providers: [codex()] }));
    vi.spyOn(api, "refreshCatalog").mockRejectedValue(new ApiError("busy", "正在更新模型目录，请等它结束。", 409));
    const fetched = vi.spyOn(api, "fetchModels");
    fireEvent.click(await screen.findByTestId("refresh-catalog"));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "更新" }));
    expect(await screen.findByText("正在更新模型目录，请等它结束。")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId("refresh-catalog")).toHaveTextContent(/^更新模型目录$/));
    expect(screen.queryByTestId("refresh-note")).toBeNull();
    expect(fetched).not.toHaveBeenCalled();
  });

  it("Codex 订阅只在更早的入口登录过时，「还没有登录」下面写明这一版改用新的登录入口、要重新登录一次；平时没有这一句", async () => {
    const status = { checked_at: "2026-09-29T10:40:00Z", ok: false, message: "还没有登录 Codex 订阅。这一版改用新的登录入口，请重新登录一次。", logged_in: false, relogin: true };
    page(config({ providers: [codex({ status })] }));
    const login = await screen.findByTestId("codex-login");
    expect(login).toHaveTextContent("还没有登录。");
    expect(within(login).getByTestId("codex-relogin")).toHaveTextContent(/^这一版改用新的登录入口，请重新登录一次。$/);
    expect(within(login).getByTestId("login-instruction").parentElement).toHaveTextContent("/login输入后在列表里选 OpenAI，按提示用 ChatGPT 订阅登录。");
    cleanup();
    page(config({ providers: [codex()] }));
    expect(await screen.findByTestId("codex-login")).toHaveTextContent("还没有登录。");
    expect(screen.queryByTestId("codex-relogin")).toBeNull();
  });

  it("Codex 订阅的登录说明只指向页面上做得到的事：到任务里让助手说一句话，不提还没有的按钮", async () => {
    page(config({ providers: [codex()] }));
    const login = await screen.findByTestId("codex-login");
    expect(login).toHaveTextContent("这里只能看出登录凭据在不在，看不出它是否还有效。要确认能用，请选定模型后到任务里试着让助手说一句话。");
    expect(login).not.toHaveTextContent("测试");
  });

  it("添加模型服务先选它提供哪一类模型：两项各有一句说明；选嵌入模型时种类里没有 Codex 订阅，原来选着它就回到头一个种类；请求里带着用途", async () => {
    page(config());
    const added = embedder({ id: "taskwright-vllm-embedding", kind: "vllm", name: "vLLM（嵌入模型）", base_url: "http://127.0.0.1:8000", models: [] });
    const add = vi.spyOn(api, "addProvider").mockResolvedValue({ ok: true, provider: added });
    vi.spyOn(api, "fetchModels").mockResolvedValue({ ok: true, result: "listed", message: "", provider: added });
    fireEvent.click(await screen.findByTestId("add-provider"));
    const form = await screen.findByTestId("add-provider");
    expect(form).toHaveTextContent("第一步：选它提供哪一类模型");
    expect(screen.getByTestId("purpose-language").closest(".opt")).toHaveTextContent("语言模型助手靠它工作。");
    expect(screen.getByTestId("purpose-embedding").closest(".opt")).toHaveTextContent("嵌入模型知识库按意思查找时用它。");
    expect(form).toHaveTextContent("一个模型服务只提供一类模型。同一个地址两类模型都有时，添加两次。");
    expect(screen.getByTestId("purpose-language")).toBeChecked();
    // 语言模型有七个种类，Codex 订阅在里面；先选上它
    expect(within(screen.getByTestId("add-kind")).getAllByRole("radio")).toHaveLength(7);
    fireEvent.click(screen.getByTestId("kind-codex"));
    expect(form).toHaveTextContent("第三步：填写 （Codex 订阅，语言模型）");
    // 改选嵌入模型：种类剩六个，没有 Codex 订阅，选着的种类回到 ollama，接口地址跟着换成它的默认地址
    fireEvent.click(screen.getByTestId("purpose-embedding"));
    expect(within(screen.getByTestId("add-kind")).getAllByRole("radio")).toHaveLength(6);
    expect(screen.queryByTestId("kind-codex")).toBeNull();
    expect(screen.getByTestId("kind-ollama")).toBeChecked();
    expect(screen.getByTestId("add-url")).toHaveValue("http://127.0.0.1:11434");
    fireEvent.click(screen.getByTestId("kind-vllm"));
    expect(form).toHaveTextContent("第三步：填写 （vLLM，嵌入模型）");
    fireEvent.click(screen.getByTestId("add-save"));
    await waitFor(() => expect(add).toHaveBeenCalledWith({ purpose: "embedding", kind: "vllm", base_url: "http://127.0.0.1:8000" }));
  });

  it("模型服务的清单按用途分组：语言模型一组，嵌入模型一组，手工登记的在最后；每个服务第二行只写种类；详情里有「用途」一行", async () => {
    page(config());
    const list = await screen.findByTestId("provider-list");
    const order = Array.from(list.querySelectorAll("[data-testid^='group-'], [data-testid='external-group'], [data-testid^='provider-taskwright'], [data-testid='provider-my-gateway']"))
      .map((el) => el.getAttribute("data-testid"));
    expect(order).toEqual(["group-language", "provider-taskwright-deepseek", "provider-taskwright-ollama", "group-embedding", "provider-taskwright-ollama-embedding", "external-group", "provider-my-gateway"]);
    expect(screen.getByTestId("group-language")).toHaveTextContent(/^语言模型$/);
    expect(screen.getByTestId("group-embedding")).toHaveTextContent(/^嵌入模型$/);
    expect(screen.getByTestId("provider-taskwright-ollama-embedding").querySelector(".sk")).toHaveTextContent(/^ollama$/);
    // 平时打开的是头一组的头一个；它的详情里写着用途
    expect(screen.getByTestId("provider-purpose")).toHaveTextContent(/^语言模型$/);
    fireEvent.click(screen.getByTestId("provider-taskwright-ollama-embedding"));
    await waitFor(() => expect(screen.getByTestId("provider-purpose")).toHaveTextContent(/^嵌入模型$/));
    // 只有一组有模型服务时，另一组的标题不出现
    cleanup();
    page(config({ providers: [embedder()] }));
    await screen.findByTestId("group-embedding");
    expect(screen.queryByTestId("group-language")).toBeNull();
    expect(screen.getByTestId("provider-purpose")).toHaveTextContent(/^嵌入模型$/);
  });

  it("模型清单不再逐个标种类：语言模型的模型服务有上下文长度一栏，嵌入模型的没有；手工添加时不用选种类，保存的请求里模型不带种类", async () => {
    page(config({ providers: [ollama(), embedder()] }));
    const table = await screen.findByTestId("model-table");
    expect(within(table).getAllByRole("columnheader").map((th) => th.textContent)).toEqual(["", "模型名", "上下文长度"]);
    // ollama 分辨得出模型是哪一类，不出现「清单里是全部模型」的提醒
    expect(screen.queryByTestId("all-models-listed")).toBeNull();
    fireEvent.click(screen.getByTestId("provider-taskwright-ollama-embedding"));
    await screen.findByTestId("model-embed:large");
    expect(within(screen.getByTestId("model-table")).getAllByRole("columnheader").map((th) => th.textContent)).toEqual(["", "模型名"]);
    expect(screen.queryByTestId("add-model-ctx")).toBeNull();
    expect(screen.getByTestId("provider-detail").querySelector(".ant-select")).toBeNull();
    const update = vi.spyOn(api, "updateProvider").mockResolvedValue({ ok: true, provider: embedder() });
    fireEvent.change(screen.getByTestId("add-model-name"), { target: { value: "bge-m3" } });
    fireEvent.click(screen.getByTestId("add-model"));
    fireEvent.click(screen.getByTestId("save-models"));
    await waitFor(() => expect(update).toHaveBeenCalledWith("taskwright-ollama-embedding", { models: [
      { id: "embed:large", enabled: true, context_window: null }, { id: "bge-m3", enabled: true, context_window: null },
    ] }));
  });

  it("分辨不出模型是哪一类的模型服务，清单上面提醒清单里是它的全部模型、只勾这一类", async () => {
    page(config({ providers: [embedder({ id: "taskwright-vllm-embedding", kind: "vllm", name: "vLLM（嵌入模型）" })] }));
    expect(await screen.findByTestId("all-models-listed")).toHaveTextContent("这个模型服务分辨不出哪些是嵌入模型，清单里列的是它的全部模型，请只勾嵌入模型。");
  });

  it("选择嵌入模型时只列嵌入模型的模型服务：语言模型的模型服务与手工登记的都不出现；没有嵌入模型的模型服务时「选择」是灰的", async () => {
    page(config());
    fireEvent.click(await screen.findByTestId("pick-embedding-button"));
    const dialog = await screen.findByTestId("pick-embedding");
    expect(within(dialog).getByTestId("pick-taskwright-ollama-embedding-embed:large")).not.toBeDisabled();
    expect(Array.from(dialog.querySelectorAll(".pg")).map((el) => el.textContent)).toEqual(["本机的 ollama（嵌入模型）"]);
    expect(within(dialog).queryByText("qianwen:14b")).toBeNull();
    expect(within(dialog).queryByText("gateway-chat")).toBeNull();
    cleanup();
    page(config({ providers: [deepseek(), ollama(), handWritten] }));
    expect(await screen.findByTestId("pick-embedding-button")).toBeDisabled();
    expect(screen.getByTestId("pick-language-button")).not.toBeDisabled();
  });

  it("添加时后端回 rejected：停在添加的画面，按 data.field 把后端那句话写在接口地址下面", async () => {
    page(config());
    const text = "连不上这个地址。请确认模型服务已经启动，地址与端口没有写错。";
    const add = vi.spyOn(api, "addProvider").mockRejectedValue(new ApiError("rejected", text, 422, { field: "base_url" }));
    fireEvent.click(await screen.findByTestId("add-provider"));
    fireEvent.click(await screen.findByTestId("add-save"));
    expect(await screen.findByTestId("err-base_url")).toHaveTextContent(text);
    expect(add).toHaveBeenCalledWith({ purpose: "language", kind: "ollama", base_url: "http://127.0.0.1:11434" });
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
    load.mockResolvedValue(config({ providers: [deepseek(), ollama(), added, embedder(), handWritten] }));
    const fetched = vi.spyOn(api, "fetchModels").mockResolvedValue({ ok: true, result: "listed", message: "",
      provider: { ...added, models: [{ id: "llama:8b", enabled: false, context_window: null, context_source: null }] } });
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
    // 嵌入模型的模型服务不出现在语言模型的列表里。
    expect(within(dialog).queryByText("embed:large")).toBeNull();
    expect(dialog).not.toHaveTextContent("本机的 ollama（嵌入模型）");
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
    fireEvent.click(within(await screen.findByTestId("model-qianwen:14b")).getByRole("checkbox"));
    fireEvent.click(screen.getByTestId("save-models"));
    expect(await screen.findByTestId("save-error")).toHaveTextContent(text);
  });

  it("模型超过 10 个时平时只列勾上的，其余收成一行；点「显示全部」之后列出全部并可以按模型名筛选", async () => {
    const models = Array.from({ length: 12 }, (_, i) => ({ id: `m-${i}`, enabled: i < 2, context_window: 4096, context_source: "service" as const }));
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

  it("后端没有测试接口时两行都不显示「测试」；有接口时两行都有，没有模型可测时是灰的：嵌入模型没有选定就没有可测的，不拿语言模型的那一个顶替", async () => {
    page(config(bothChosen));
    await screen.findByTestId("current-language");
    expect(screen.queryByTestId("test-language-button")).toBeNull();
    expect(screen.queryByTestId("test-embedding-button")).toBeNull();
    cleanup();
    page(config({ fallback: null }), withTest);
    expect(await screen.findByTestId("test-language-button")).toBeDisabled();
    expect(screen.getByTestId("test-embedding-button")).toBeDisabled();
    cleanup();
    page(config(), withTest);
    expect(await screen.findByTestId("test-language-button")).not.toBeDisabled();
    expect(screen.getByTestId("test-embedding-button")).toBeDisabled();
    cleanup();
    page(config(bothChosen), withTest);
    expect(await screen.findByTestId("test-embedding-button")).not.toBeDisabled();
  });

  it("点「测试」先问一句，写明会发一次真实的请求与可能的费用；点取消不发请求", async () => {
    page(config(chosen), withTest);
    const run = vi.spyOn(api, "testModel").mockResolvedValue(tested());
    fireEvent.click(await screen.findByTestId("test-language-button"));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("测试语言模型");
    expect(dialog).toHaveTextContent("会用「deepseek-chat」发一次真实的请求：让模型读一个小文件并回一句话。商业接口可能产生很少的费用。");
    expect(within(dialog).getByRole("button", { name: "开始测试" })).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
    expect(run).not.toHaveBeenCalled();
    expect(screen.queryByTestId("test-language-result")).toBeNull();
  });

  it("测试当中按钮写「正在测试……」、不能再点，「更换」也不能点；通过之后在这一行下面写这一次通过与用时，再写问了模型什么、模型答了什么", async () => {
    page(config(chosen), withTest);
    let finish: (r: ModelTestResult) => void = () => {};
    const run = vi.spyOn(api, "testModel").mockReturnValue(new Promise((ok) => { finish = ok; }));
    fireEvent.click(await screen.findByTestId("test-language-button"));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "开始测试" }));
    await waitFor(() => expect(screen.getByTestId("test-language-button")).toHaveTextContent("正在测试……"));
    expect(run).toHaveBeenCalledWith("language");
    expect(screen.getByTestId("pick-language-button")).toBeDisabled();
    fireEvent.click(screen.getByTestId("test-language-button"));
    expect(run).toHaveBeenCalledTimes(1);
    finish(tested());
    const result = await screen.findByTestId("test-language-result");
    expect(result.querySelector(".th")).toHaveTextContent(/^这一次测试通过，用时 3.2 秒。$/);
    expect(screen.getByTestId("test-language-question")).toHaveTextContent(/^问模型：请读当前目录下的文件 inventory.txt，然后用一句话回答：这批货一共有多少箱？$/);
    expect(screen.getByTestId("test-language-reply")).toHaveTextContent(/^模型回答：这批货一共有 42 箱。$/);
    expect(result).toHaveClass("ok");
    expect(result).not.toHaveTextContent("可以用");
    expect(screen.getByTestId("test-language-button")).toHaveTextContent(/^测试$/);
    expect(screen.getByTestId("pick-language-button")).not.toBeDisabled();
  });

  it("没有通过时写这一次没有通过与原因，后面照样写问与答，模型没有回答时照实说；没有选定语言模型时测的是现在实际用的那一个", async () => {
    page(config({ fallback: { model: "local/qwen", from: "启动配置" } }), withTest);
    vi.spyOn(api, "testModel").mockResolvedValue(tested({ result: "failed", model: "local/qwen", reply: "", tool_calls: 0, reason: "模型没有调用读文件的工具。" }));
    fireEvent.click(await screen.findByTestId("test-language-button"));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("会用「local/qwen」发一次真实的请求");
    fireEvent.click(within(dialog).getByRole("button", { name: "开始测试" }));
    const result = await screen.findByTestId("test-language-result");
    expect(result.querySelector(".th")).toHaveTextContent(/^这一次测试没有通过：模型没有调用读文件的工具。$/);
    expect(screen.getByTestId("test-language-question")).toHaveTextContent("问模型：请读当前目录下的文件 inventory.txt，然后用一句话回答：这批货一共有多少箱？");
    expect(screen.getByTestId("test-language-reply")).toHaveTextContent(/^模型没有回答$/);
    expect(result).toHaveClass("bad");
  });

  it("接口报错（例如已经有一个测试在跑）时把那句话提示出来，不写结果；换了模型之后上一次的结果清掉", async () => {
    const load = page(config(chosen), withTest);
    const run = vi.spyOn(api, "testModel").mockRejectedValueOnce(new ApiError("busy", "正在测试，请等它结束。", 409));
    // 确认框关掉之后在测试环境里不会从页面上摘掉，所以第二次点的是最后出现的那个「开始测试」。
    const start = async () => fireEvent.click((await screen.findAllByRole("button", { name: "开始测试" })).at(-1)!);
    fireEvent.click(await screen.findByTestId("test-language-button"));
    await start();
    expect(await screen.findByText("正在测试，请等它结束。")).toBeInTheDocument();
    expect(screen.queryByTestId("test-language-result")).toBeNull();
    await waitFor(() => expect(screen.getByTestId("test-language-button")).toHaveTextContent(/^测试$/));
    run.mockResolvedValue(tested());
    fireEvent.click(screen.getByTestId("test-language-button"));
    await waitFor(() => expect(screen.getAllByRole("button", { name: "开始测试" })).toHaveLength(2));
    await start();
    expect(await screen.findByTestId("test-language-result")).toBeInTheDocument();
    const next = { language: { provider_id: "my-gateway", model_id: "gateway-chat" }, embedding: null };
    vi.spyOn(api, "selectModels").mockResolvedValue({ ok: true, note: "更换之后，下一次打开或者新建会话时生效。正在进行的会话不受影响。", selection: next });
    fireEvent.click(screen.getByTestId("pick-language-button"));
    fireEvent.click(within(await screen.findByTestId("pick-language")).getByTestId("pick-my-gateway-gateway-chat"));
    load.mockResolvedValue(config({ selection: next }));
    fireEvent.click(screen.getByTestId("use-model"));
    expect(await screen.findByText("gateway-chat", { selector: ".mname" })).toBeInTheDocument();
    expect(screen.queryByTestId("test-language-result")).toBeNull();
  });

  it("嵌入模型点「测试」先问一句，写明是把一句话换算成一串数字、会发一次真实的请求与可能的费用；点取消不发请求", async () => {
    page(config(bothChosen), withTest);
    const run = vi.spyOn(api, "testModel").mockResolvedValue(embedded());
    fireEvent.click(await screen.findByTestId("test-embedding-button"));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("测试嵌入模型");
    expect(dialog).toHaveTextContent("会用「embed:large」发一次真实的请求：把一句话换算成一串数字。商业接口可能产生很少的费用。");
    expect(within(dialog).getByRole("button", { name: "开始测试" })).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
    expect(run).not.toHaveBeenCalled();
    expect(screen.queryByTestId("test-embedding-result")).toBeNull();
  });

  it("嵌入模型测试当中按钮写「正在测试……」，两行的「测试」与「更换」都不能点；通过之后写这一次通过与用时、送去换算的话（前缀里的换行保留）、数字串的长度", async () => {
    page(config(bothChosen), withTest);
    let finish: (r: ModelTestResult) => void = () => {};
    const run = vi.spyOn(api, "testModel").mockReturnValue(new Promise((ok) => { finish = ok; }));
    fireEvent.click(await screen.findByTestId("test-embedding-button"));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "开始测试" }));
    await waitFor(() => expect(screen.getByTestId("test-embedding-button")).toHaveTextContent("正在测试……"));
    expect(run).toHaveBeenCalledWith("embedding");
    expect(screen.getByTestId("test-language-button")).toBeDisabled();
    expect(screen.getByTestId("test-language-button")).toHaveTextContent(/^测试$/);
    expect(screen.getByTestId("pick-language-button")).toBeDisabled();
    expect(screen.getByTestId("pick-embedding-button")).toBeDisabled();
    fireEvent.click(screen.getByTestId("test-embedding-button"));
    fireEvent.click(screen.getByTestId("test-language-button"));
    expect(run).toHaveBeenCalledTimes(1);
    finish(embedded());
    const result = await screen.findByTestId("test-embedding-result");
    expect(result.querySelector(".th")).toHaveTextContent(/^这一次测试通过，用时 0.4 秒。$/);
    const sent = screen.getByTestId("test-embedding-question");
    expect(sent.textContent).toBe("送去换算的话：Instruct: 找相关段落\nQuery:这批货一共有 42 箱。");
    expect(sent).toHaveClass("sent");
    expect(screen.getByTestId("test-embedding-dimensions")).toHaveTextContent(/^算出来的数字串长度：1024$/);
    expect(result).toHaveClass("ok");
    expect(result).not.toHaveTextContent("可以用");
    expect(screen.queryByTestId("test-language-result")).toBeNull();
    for (const id of ["test-embedding-button", "test-language-button", "pick-language-button", "pick-embedding-button"]) expect(screen.getByTestId(id)).not.toBeDisabled();
  });

  it("语言模型测试当中，嵌入模型那一行的「测试」与「更换」也不能点", async () => {
    page(config(bothChosen), withTest);
    let finish: (r: ModelTestResult) => void = () => {};
    const run = vi.spyOn(api, "testModel").mockReturnValue(new Promise((ok) => { finish = ok; }));
    fireEvent.click(await screen.findByTestId("test-language-button"));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "开始测试" }));
    await waitFor(() => expect(screen.getByTestId("test-language-button")).toHaveTextContent("正在测试……"));
    expect(screen.getByTestId("test-embedding-button")).toBeDisabled();
    expect(screen.getByTestId("pick-embedding-button")).toBeDisabled();
    fireEvent.click(screen.getByTestId("test-embedding-button"));
    expect(run).toHaveBeenCalledTimes(1);
    finish(tested());
    await screen.findByTestId("test-language-result");
    expect(screen.getByTestId("test-embedding-button")).not.toBeDisabled();
    expect(screen.getByTestId("pick-embedding-button")).not.toBeDisabled();
  });

  it("嵌入模型没有通过时只写这一次没有通过与原因，不写送去的话与长度", async () => {
    page(config(bothChosen), withTest);
    vi.spyOn(api, "testModel").mockResolvedValue(embedded({ result: "failed", dimensions: null, reason: "送去 1 段文字，拿回 0 条数字串。" }));
    fireEvent.click(await screen.findByTestId("test-embedding-button"));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "开始测试" }));
    const result = await screen.findByTestId("test-embedding-result");
    expect(result).toHaveTextContent(/^这一次测试没有通过：送去 1 段文字，拿回 0 条数字串。$/);
    expect(result).toHaveClass("bad");
    expect(screen.queryByTestId("test-embedding-question")).toBeNull();
    expect(screen.queryByTestId("test-embedding-dimensions")).toBeNull();
  });

  it("更换了哪一种模型就清掉哪一种的测试结果，另一种的留着；只改嵌入模型的查询前缀也算更换", async () => {
    const load = page(config(bothChosen), withTest);
    const run = vi.spyOn(api, "testModel").mockImplementation(async (type) => (type === "language" ? tested() : embedded()));
    const start = async () => fireEvent.click((await screen.findAllByRole("button", { name: "开始测试" })).at(-1)!);
    fireEvent.click(await screen.findByTestId("test-language-button"));
    await start();
    await screen.findByTestId("test-language-result");
    fireEvent.click(screen.getByTestId("test-embedding-button"));
    await waitFor(() => expect(screen.getAllByRole("button", { name: "开始测试" })).toHaveLength(2));
    await start();
    await screen.findByTestId("test-embedding-result");
    expect(run).toHaveBeenCalledTimes(2);
    // 测嵌入模型不清语言模型的结果。
    expect(screen.getByTestId("test-language-result")).toBeInTheDocument();
    // 只改查询前缀。
    const next = { ...bothChosen.selection, embedding: { ...bothChosen.selection.embedding, query_prefix: "查询：" } };
    const select = vi.spyOn(api, "selectModels").mockResolvedValue({ ok: true, note: "更换之后，下一次打开或者新建会话时生效。正在进行的会话不受影响。", selection: next });
    fireEvent.click(screen.getByTestId("pick-embedding-button"));
    fireEvent.click(within(await screen.findByTestId("pick-embedding")).getByText("高级"));
    fireEvent.change(screen.getByTestId("query-prefix"), { target: { value: "查询：" } });
    load.mockResolvedValue(config({ selection: next }));
    fireEvent.click(screen.getByTestId("use-model"));
    await waitFor(() => expect(select).toHaveBeenCalledWith(next));
    await waitFor(() => expect(screen.queryByTestId("test-embedding-result")).toBeNull());
    expect(screen.getByTestId("test-language-result")).toBeInTheDocument();
    // 再测一次嵌入模型，然后更换语言模型：清掉的是语言模型的结果。
    fireEvent.click(screen.getByTestId("test-embedding-button"));
    await waitFor(() => expect(screen.getAllByRole("button", { name: "开始测试" })).toHaveLength(3));
    await start();
    await screen.findByTestId("test-embedding-result");
    const other = { ...next, language: { provider_id: "my-gateway", model_id: "gateway-chat" } };
    select.mockResolvedValue({ ok: true, note: "更换之后，下一次打开或者新建会话时生效。正在进行的会话不受影响。", selection: other });
    fireEvent.click(screen.getByTestId("pick-language-button"));
    fireEvent.click(within(await screen.findByTestId("pick-language")).getByTestId("pick-my-gateway-gateway-chat"));
    load.mockResolvedValue(config({ selection: other }));
    fireEvent.click(screen.getByTestId("use-model"));
    expect(await screen.findByText("gateway-chat", { selector: ".mname" })).toBeInTheDocument();
    expect(screen.queryByTestId("test-language-result")).toBeNull();
    expect(screen.getByTestId("test-embedding-result")).toBeInTheDocument();
  });

  it("测试语言模型的请求等 120 秒：后端到 90 秒之后还要停助手，119 秒时还在等，到 120 秒才报等了太久", async () => {
    vi.useFakeTimers();
    try {
      // 一直不回答的后端：只在请求被放弃时照浏览器的办法报 AbortError。
      const fetched = vi.spyOn(globalThis, "fetch").mockImplementation((_url, init) => new Promise((_ok, fail) => {
        init!.signal!.addEventListener("abort", () => fail(Object.assign(new Error("aborted"), { name: "AbortError" })));
      }));
      let outcome: unknown = "还在等";
      api.testModel("language").then((r) => { outcome = r; }, (e) => { outcome = e; });
      await vi.advanceTimersByTimeAsync(119_000);
      expect(outcome).toBe("还在等");
      await vi.advanceTimersByTimeAsync(1_000);
      expect(outcome).toBeInstanceOf(ApiError);
      expect([(outcome as ApiError).code, (outcome as ApiError).message]).toEqual(["timeout", "等了太久没有得到回应。"]);
      expect(fetched).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  describe("更换嵌入模型时知识库里的文档要重新换算", () => {
    const NOTE = "更换之后，下一次打开或者新建会话时生效。正在进行的会话不受影响。";
    const withKnowledge: ServiceInfo = { ...service, capabilities: { ...service.capabilities, knowledge: true } };
    const two = embedder({ models: ["embed:large", "embed:small"].map((id) => ({ id, enabled: true, context_window: null, context_source: null })) });
    const large = { provider_id: "taskwright-ollama-embedding", model_id: "embed:large", query_prefix: "" };
    const small = { ...large, model_id: "embed:small" };
    const cfg = (embedding: typeof large | null) => config({ providers: [deepseek(), two], selection: { language: chosen.selection.language, embedding } });

    /** 打开设置页并点开选嵌入模型的对话框；documents 是知识库里文档的份数，null 是取不到。 */
    async function open(embedding: typeof large | null, documents: number | null, info: ServiceInfo = withKnowledge) {
      const load = page(cfg(embedding), info);
      const overview = vi.spyOn(api, "knowledgeOverview");
      if (documents === null) overview.mockRejectedValue(new ApiError("not_found", "这个服务没有配置知识库。", 404));
      else overview.mockResolvedValue({ libraries: [], embedding: { model: null, running: false, ready: false, pending: documents, total: documents, stopped_reason: null } });
      const select = vi.spyOn(api, "selectModels").mockImplementation(async (body) => ({ ok: true, note: NOTE, selection: body }));
      const embed = vi.spyOn(api, "embedKnowledge").mockResolvedValue({ queued: documents ?? 0, embedding: { model: null, running: true, ready: false, pending: 0, total: 0, stopped_reason: null } });
      fireEvent.click(await screen.findByTestId("pick-embedding-button"));
      const dialog = await screen.findByTestId("pick-embedding");
      // 等对话框把知识库里文档的份数取回来。
      await act(async () => { await Promise.resolve(); await Promise.resolve(); });
      return { load, overview, select, embed, dialog };
    }

    it("换成另一个嵌入模型：点「用这个模型」先问一句，写明几份文档要重新换算与可能的费用；取消不保存；确定之后先保存选择，再开始换算并提示", async () => {
      const { overview, select, embed, dialog } = await open(large, 3);
      expect(overview).toHaveBeenCalledTimes(1);
      fireEvent.click(within(dialog).getByTestId("pick-taskwright-ollama-embedding-embed:small"));
      fireEvent.click(screen.getByTestId("use-model"));
      // 只弹出一个确认框，但界面库把它的标题写在两处（标题栏与那句话上方），所以按「至少有一处」看。
      expect((await screen.findAllByText("更换嵌入模型？")).length).toBeGreaterThan(0);
      expect(screen.getByText("换了嵌入模型后，知识库里的 3 份文档要重新换算，换算完成前按意思查找暂时不可用。商业接口可能产生费用。")).toBeInTheDocument();
      expect(select).not.toHaveBeenCalled();
      fireEvent.click(screen.getAllByRole("button", { name: "取消" }).at(-1)!);
      await new Promise((r) => setTimeout(r, 20));
      expect(select).not.toHaveBeenCalled();
      expect(embed).not.toHaveBeenCalled();

      fireEvent.click(screen.getByTestId("use-model"));
      await waitFor(() => expect(screen.getAllByRole("button", { name: "更换并重新换算" }).length).toBeGreaterThan(0));
      fireEvent.click(screen.getAllByRole("button", { name: "更换并重新换算" }).at(-1)!);
      await waitFor(() => expect(select).toHaveBeenCalledWith({ language: chosen.selection.language, embedding: small }));
      await waitFor(() => expect(embed).toHaveBeenCalledWith());
      expect(select.mock.invocationCallOrder[0]).toBeLessThan(embed.mock.invocationCallOrder[0]);
      expect(await screen.findByText("已开始换算知识库里的 3 份文档，进度在知识库页面上看。")).toBeInTheDocument();
    });

    it("第一次选定嵌入模型、知识库里已经有文档：同样先问，那句话写的是要先换算，也写明可能的费用", async () => {
      const { select, embed, dialog } = await open(null, 2);
      fireEvent.click(within(dialog).getByTestId("pick-taskwright-ollama-embedding-embed:large"));
      fireEvent.click(screen.getByTestId("use-model"));
      expect((await screen.findAllByText("选定嵌入模型？")).length).toBeGreaterThan(0);
      expect(screen.getByText("选定嵌入模型后，知识库里的 2 份文档要先换算，换算完成后才能按意思查找。商业接口可能产生费用。")).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "选定并开始换算" }));
      await waitFor(() => expect(select).toHaveBeenCalledWith({ language: chosen.selection.language, embedding: large }));
      await waitFor(() => expect(embed).toHaveBeenCalledTimes(1));
    });

    it("不问的几种：知识库里没有文档、取不到文档的份数、只改查询前缀、改成不用嵌入模型，都直接保存，不开始换算", async () => {
      for (const [documents, change, saved] of [
        [0, (d: HTMLElement) => fireEvent.click(within(d).getByTestId("pick-taskwright-ollama-embedding-embed:small")), small],
        [null, (d: HTMLElement) => fireEvent.click(within(d).getByTestId("pick-taskwright-ollama-embedding-embed:small")), small],
        [3, (d: HTMLElement) => { fireEvent.click(within(d).getByText("高级")); fireEvent.change(screen.getByTestId("query-prefix"), { target: { value: "查询：" } }); }, { ...large, query_prefix: "查询：" }],
        [3, (d: HTMLElement) => fireEvent.click(within(d).getByTestId("pick-no-embedding")), null],
      ] as const) {
        const { select, embed, dialog } = await open(large, documents);
        change(dialog);
        fireEvent.click(screen.getByTestId("use-model"));
        await waitFor(() => expect(select).toHaveBeenCalledWith({ language: chosen.selection.language, embedding: saved }));
        expect(screen.queryByText("更换嵌入模型？")).toBeNull();
        expect(embed).not.toHaveBeenCalled();
        cleanup();
        vi.restoreAllMocks();
      }
    });

    it("服务没有知识库时不取文档的份数，也不问", async () => {
      const { overview, select, embed, dialog } = await open(large, 3, service);
      expect(overview).not.toHaveBeenCalled();
      fireEvent.click(within(dialog).getByTestId("pick-taskwright-ollama-embedding-embed:small"));
      fireEvent.click(screen.getByTestId("use-model"));
      await waitFor(() => expect(select).toHaveBeenCalledTimes(1));
      expect(embed).not.toHaveBeenCalled();
    });

    it("选择保存了、换算却没能开始：提示一句，选择照样算数", async () => {
      const { load, select, embed, dialog } = await open(large, 3);
      embed.mockRejectedValue(new ApiError("rejected", "还没有选嵌入模型。", 422));
      fireEvent.click(within(dialog).getByTestId("pick-taskwright-ollama-embedding-embed:small"));
      load.mockResolvedValue(cfg(small));
      fireEvent.click(screen.getByTestId("use-model"));
      fireEvent.click(await screen.findByRole("button", { name: "更换并重新换算" }));
      await waitFor(() => expect(select).toHaveBeenCalledTimes(1));
      expect(await screen.findByText("没能开始换算知识库里的文档：还没有选嵌入模型。")).toBeInTheDocument();
      expect(await screen.findByText("embed:small", { selector: ".mname" })).toBeInTheDocument();
    });
  });
});
