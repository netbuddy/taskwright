// 数据升级页：服务信息里 upgrade_pending 为真时整屏显示，别的都不画；写明要升级什么、备份放哪、大概多久；
// 点「开始升级」后显示进度；都做成了自动进正常界面；有任务没有做成时显示报告与「继续使用」；整体没有做成时显示原因与「再试一次」。
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { App as AntApp, ConfigProvider } from "antd";
import { api } from "../api/client";
import type { ServiceInfo, UpgradeReport, UpgradeView } from "../api/types";
import { ServiceProvider } from "../components/ServiceControls";
import { ToastProvider } from "../components/Toasts";
import { UPGRADE_POLL_MS } from "../components/UpgradeScreen";

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); });

const info = (pending: boolean): ServiceInfo =>
  ({ ok: true, app: "taskwright", version: "0.5.0", mode: "desktop", pid: 1, port: 8950, upgrade_pending: pending, capabilities: { exit: true, model: true } });

const view = (over: Partial<UpgradeView> = {}): UpgradeView => ({
  state: "pending", data_dir: "/data", backup_dir: "/data/backups", service: false, knowledge: false, progress: null, report: null,
  tasks: [{ task_id: "TASK-1", name: "借阅系统" }, { task_id: "TASK-2", name: null }], ...over,
});

const report = (over: Partial<UpgradeReport> = {}): UpgradeReport => ({
  product_version: "0.5.0", started_at: "", finished_at: "", data_dir: "/data", backup: { dir: "/data/backups/20261008-120000-pre-0.5", bytes: 4096, files: 2 },
  service: "created", tasks: [], succeeded: 2, failed: 0, fatal: null, file: "/data/logs/upgrade-20261008-120000.txt",
  text: "数据升级报告（0.5.0）\n合计：2 个任务，成功 2 个，没有做成 0 个。\n", ...over,
});

function page() {
  return render(
    <ConfigProvider button={{ autoInsertSpace: false }}><AntApp><ToastProvider><ServiceProvider>
      <div data-testid="normal">正常界面</div>
    </ServiceProvider></ToastProvider></AntApp></ConfigProvider>,
  );
}
const text = (el: Element | null) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();

describe("数据升级页", () => {
  it("不用升级时照常显示界面，不取升级的接口；较早的后端没有这个字段，等于不用升级", async () => {
    const state = vi.spyOn(api, "upgradeState");
    vi.spyOn(api, "serviceInfo").mockResolvedValue(info(false));
    page();
    expect(await screen.findByTestId("normal")).toBeInTheDocument();
    expect(screen.queryByTestId("upgrade-screen")).toBeNull();
    cleanup();
    const old = info(false);
    delete old.upgrade_pending;
    vi.spyOn(api, "serviceInfo").mockResolvedValue(old);
    page();
    expect(await screen.findByTestId("normal")).toBeInTheDocument();
    expect(state).not.toHaveBeenCalled();
  });

  it("要升级时整屏换成升级页，别的不画：写明几个任务、备份放哪、大概多久；页面上没有内部用词", async () => {
    vi.spyOn(api, "serviceInfo").mockResolvedValue(info(true));
    vi.spyOn(api, "upgradeState").mockResolvedValue({ ok: true, upgrade: view() });
    page();
    const screenEl = await screen.findByTestId("upgrade-screen");
    await screen.findByTestId("upgrade-what");
    expect(screen.queryByTestId("normal")).toBeNull();
    expect(screenEl).toHaveAttribute("data-state", "pending");
    expect(text(screenEl)).toContain("数据升级这台电脑上有上一版留下的数据，要先升级到现在的格式才能接着用。升级不改动任务实例的内容。");
    expect([...screen.getByTestId("upgrade-what").querySelectorAll("li")].map(text)).toEqual([
      "要升级的任务实例有 2 个：「借阅系统」、「TASK-2」。", "知识库不需要升级。", "升级之前会先备份，备份放在 /data/backups。", "通常不到一分钟。升级的时候请不要关闭程序。"]);
    expect(screen.getByTestId("upgrade-start")).toHaveTextContent("开始升级");
    for (const word of ["迁移", "schema", "pi", "进程", "sqlite", "投影"]) expect(screenEl.textContent).not.toContain(word);
  });

  it("任务多于六个时只列六个名字，写「等 N 个」；任务登记要升级时另写一行", async () => {
    vi.spyOn(api, "serviceInfo").mockResolvedValue(info(true));
    vi.spyOn(api, "upgradeState").mockResolvedValue({ ok: true,
      upgrade: view({ service: true, tasks: Array.from({ length: 8 }, (_, i) => ({ task_id: `T${i + 1}`, name: `任务${i + 1}` })) }) });
    page();
    const lines = [...(await screen.findByTestId("upgrade-what")).querySelectorAll("li")].map(text);
    expect(lines[0]).toBe("要升级的任务实例有 8 个：「任务1」、「任务2」、「任务3」、「任务4」、「任务5」、「任务6」等 8 个。");
    expect(lines[1]).toBe("任务登记要升级。");
  });

  it("点「开始升级」后显示进度，每半秒取一次；都做成了不用人点，直接进正常界面", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const serviceInfo = vi.spyOn(api, "serviceInfo").mockResolvedValue(info(true));
    const running = (done: number, current: string | null) => view({ state: "running", progress: { total: 4, done, current } });
    const state = vi.spyOn(api, "upgradeState").mockResolvedValueOnce({ ok: true, upgrade: view() })
      .mockResolvedValueOnce({ ok: true, upgrade: running(2, "正在升级任务「借阅系统」") })
      .mockResolvedValue({ ok: true, upgrade: view({ state: "done", progress: { total: 4, done: 4, current: null }, report: report() }) });
    const start = vi.spyOn(api, "startUpgrade").mockResolvedValue({ ok: true, started: true, upgrade: running(0, "正在备份") });
    page();
    fireEvent.click(await screen.findByTestId("upgrade-start"));
    await waitFor(() => expect(screen.getByTestId("upgrade-progress")).toHaveTextContent("正在升级，请不要关闭程序。一共 4 项，做完了 0 项。"));
    expect(screen.getByTestId("upgrade-current")).toHaveTextContent("正在备份……");
    expect(start).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(UPGRADE_POLL_MS); });
    await waitFor(() => expect(screen.getByTestId("upgrade-progress")).toHaveTextContent("做完了 2 项"));
    expect(screen.getByTestId("upgrade-current")).toHaveTextContent("正在升级任务「借阅系统」……");
    // 做完：再取一次服务信息（这时已经不用升级了），回到正常界面。
    serviceInfo.mockResolvedValue(info(false));
    await act(async () => { await vi.advanceTimersByTimeAsync(UPGRADE_POLL_MS); });
    expect(await screen.findByTestId("normal")).toBeInTheDocument();
    expect(screen.queryByTestId("upgrade-screen")).toBeNull();
    expect(state.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it("有任务没有做成：停在升级页，写几个成了几个没成，显示报告，点「继续使用」才进正常界面", async () => {
    const serviceInfo = vi.spyOn(api, "serviceInfo").mockResolvedValue(info(true));
    const text2 = "数据升级报告（0.5.0）\n任务 TASK-2：格式 0，没有升级成（任务正在被另一个服务使用），用了 3 毫秒\n合计：2 个任务，成功 1 个，没有做成 1 个。\n";
    vi.spyOn(api, "upgradeState").mockResolvedValue({ ok: true, upgrade: view({ state: "done", report: report({ succeeded: 1, failed: 1, text: text2 }) }) });
    page();
    expect(await screen.findByTestId("upgrade-result")).toHaveTextContent("升级做完了：1 个任务实例做成了，1 个没有做成。没有做成的任务实例原样没动，在任务实例列表里标着「需要处理」。");
    expect(screen.getByTestId("upgrade-report").textContent).toBe(text2);
    expect(screen.queryByTestId("normal")).toBeNull();
    serviceInfo.mockResolvedValue(info(false));
    fireEvent.click(screen.getByTestId("upgrade-continue"));
    expect(await screen.findByTestId("normal")).toBeInTheDocument();
  });

  it("整体没有做成：写原因与「数据原样没动」，显示报告，点「再试一次」重新开始", async () => {
    vi.spyOn(api, "serviceInfo").mockResolvedValue(info(true));
    const failed = view({ state: "failed", report: report({ backup: null, service: null, succeeded: 0, fatal: "升级之前的备份没有做成，所以没有升级：磁盘满了", text: "数据升级报告（0.5.0）\n没有升级：升级之前的备份没有做成，所以没有升级：磁盘满了\n" }) });
    vi.spyOn(api, "upgradeState").mockResolvedValue({ ok: true, upgrade: failed });
    const start = vi.spyOn(api, "startUpgrade").mockResolvedValue({ ok: true, started: true, upgrade: view({ state: "running", progress: { total: 4, done: 0, current: "正在备份" } }) });
    page();
    expect(await screen.findByTestId("upgrade-result")).toHaveTextContent("没有升级，数据原样没动：升级之前的备份没有做成，所以没有升级：磁盘满了");
    expect(screen.getByTestId("upgrade-report")).toHaveTextContent("没有升级：升级之前的备份没有做成");
    fireEvent.click(screen.getByTestId("upgrade-retry"));
    await waitFor(() => expect(screen.getByTestId("upgrade-progress")).toBeInTheDocument());
    expect(start).toHaveBeenCalledTimes(1);
  });

  it("取不到升级的现状时写出原因，可以再看一次", async () => {
    vi.spyOn(api, "serviceInfo").mockResolvedValue(info(true));
    const state = vi.spyOn(api, "upgradeState").mockRejectedValueOnce(new Error("连不上服务")).mockResolvedValue({ ok: true, upgrade: view() });
    page();
    expect(await screen.findByTestId("upgrade-error")).toHaveTextContent("连不上服务");
    fireEvent.click(screen.getByText("再看一次"));
    expect(await screen.findByTestId("upgrade-start")).toBeInTheDocument();
    expect(state).toHaveBeenCalledTimes(2);
  });
});
