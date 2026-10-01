// Word 文件读到了、但排版库画不出来：材料区与任务页材料的「查看」显示一句固定的中文说明，排版库的错误原文只写进浏览器的控制台；
// 读不到文件（接口出错）时照旧显示后端的说明；来源标签照写「文件名 · 章节」（章节取自位置表，不依赖排版结果）。
// 排版库出错用模拟触发：让画的那一步抛出一个错误，不依赖某种具体的文件结构。缓存那一遍画在页面外的元素里，显示那一遍画在页面里，
// 按目标元素在不在页面里区分两遍。

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { App as AntApp, ConfigProvider } from "antd";
import { ApiError, api } from "../api/client";
import type { TaskDetail } from "../api/types";
import { DOCX_UNRENDERABLE } from "../components/work/DocxPaper";
import { SourceBox } from "../components/work/ItemDetail";
import { MaterialPane } from "../components/work/MaterialPane";
import { TaskPage } from "../pages/TaskPage";
import { resetDocxStore, TaskIdContext } from "../state/docxStore";
import SAMPLE_DATA_URL from "../../../examples/library-lending/requirements-styled.docx?inline";
import MARKDOWN_PROJECTION from "./fixtures/requirements-styled.docx.md?raw";
import LOCATIONS_TEXT from "./fixtures/requirements-styled.docx.locations.json?raw";

/** 哪一遍画的时候抛错：store 是缓存那一遍（页面外），view 是显示那一遍（页面里），none 是都不抛。 */
const fail = vi.hoisted(() => ({ on: "store" as "store" | "view" | "none" }));
const ERROR_TEXT = "Cannot read properties of undefined (reading 'beginChar')";
vi.mock("../model/docx", async (importOriginal) => {
  const real = await importOriginal<typeof import("../model/docx")>();
  return {
    ...real,
    renderDocx: async (data: ArrayBuffer | Uint8Array, into: HTMLElement) => {
      if (fail.on === (into.isConnected ? "view" : "store")) throw new TypeError(ERROR_TEXT);
      return real.renderDocx(data, into);
    },
  };
});

const SAMPLE = Uint8Array.from(atob(SAMPLE_DATA_URL.slice(SAMPLE_DATA_URL.indexOf(",") + 1)), (c) => c.charCodeAt(0));
const PATH = "inputs/requirements-styled.docx";
const content = async (_task: string, path: string) =>
  ({ path, text: path.endsWith(".locations.json") ? LOCATIONS_TEXT : MARKDOWN_PROJECTION });
const materials = [{ path: PATH, bytes: 1, modified_at: "", derived_from: null }, { path: `${PATH}.md`, bytes: 1, modified_at: "", derived_from: PATH }];
const SLOW = { timeout: 20_000 };
vi.setConfig({ testTimeout: 40_000 });

let logged: ReturnType<typeof vi.spyOn>;
function mockApi() {
  vi.spyOn(api, "materialRaw").mockResolvedValue(SAMPLE.slice().buffer);
  vi.spyOn(api, "materialContent").mockImplementation(content);
  logged = vi.spyOn(console, "error").mockImplementation(() => {});
}
/** 页面上没有英文的错误原文。 */
const noRawError = () => {
  expect(document.body.textContent).not.toContain(ERROR_TEXT);
  expect(document.body.textContent).not.toMatch(/TypeError|beginChar|undefined/);
};
/** 错误原文连同文件路径写进了控制台。 */
const loggedToConsole = () => {
  expect(logged).toHaveBeenCalledWith(expect.stringContaining(PATH), expect.objectContaining({ message: ERROR_TEXT }));
};

afterEach(() => { cleanup(); document.body.innerHTML = ""; resetDocxStore(); vi.restoreAllMocks(); fail.on = "store"; });

describe("排版库画不出来", () => {
  it("材料区：显示固定的中文说明，不显示错误原文；错误原文写进控制台", async () => {
    mockApi();
    render(<MaterialPane taskId="TASK-U" materials={materials} locate={null} />);
    expect(await screen.findByTestId("docx-unrenderable", undefined, SLOW)).toHaveTextContent(DOCX_UNRENDERABLE);
    noRawError();
    loggedToConsole();
  });

  it("任务页材料的「查看」：显示同一句说明，不显示错误原文", async () => {
    mockApi();
    vi.spyOn(api, "listTasks").mockResolvedValue([]);
    vi.spyOn(api, "getTask").mockResolvedValue({
      task_id: "TASK-U", task_name: "Word 任务", task_type: "演示", domain_tag: null, status: "进行中", started_at: "", ended_at: null,
      definition: { collections: [] }, items: [], completion: null, sessions: [], materials,
    } as unknown as TaskDetail);
    render(<ConfigProvider><AntApp><TaskPage taskId="TASK-U" /></AntApp></ConfigProvider>);
    fireEvent.click((await screen.findAllByTestId("material-view"))[0]);
    await waitFor(() => expect(document.querySelector(".docx-view [data-testid=docx-unrenderable]")).toHaveTextContent(DOCX_UNRENDERABLE), SLOW);
    noRawError();
    loggedToConsole();
  });

  it("缓存那一遍画好了、显示那一遍出错：材料区同样显示这句说明，不显示错误原文", async () => {
    fail.on = "view";
    mockApi();
    render(<MaterialPane taskId="TASK-U" materials={materials} locate={null} />);
    expect(await screen.findByTestId("docx-unrenderable", undefined, SLOW)).toHaveTextContent(DOCX_UNRENDERABLE);
    noRawError();
    loggedToConsole();
  });

  it("来源的出处照写「文件名 · 章节」，照带表格位置", async () => {
    mockApi();
    render(
      <TaskIdContext.Provider value="TASK-U">
        <SourceBox source={{ kind: "文档原文", locator: `${PATH}#p91`, excerpt: "系统要能每分钟处理至少 100 笔借还" }} />
      </TaskIdContext.Provider>,
    );
    await waitFor(() => expect(screen.getByRole("button").textContent).toBe("出处：requirements-styled.docx · 4 非功能需求，表 3 第 2 行第 2 列（点一下看原文）"), SLOW);
  });
});

describe("读不到文件", () => {
  it("照旧显示后端的说明，不显示画不出来的那句；来源的出处照写章节", async () => {
    fail.on = "none";
    vi.spyOn(api, "materialRaw").mockRejectedValue(new ApiError("not_found", "这个任务没有这份材料。", 404));
    vi.spyOn(api, "materialContent").mockImplementation(content);
    render(
      <TaskIdContext.Provider value="TASK-U">
        <MaterialPane taskId="TASK-U" materials={materials} locate={null} />
        <SourceBox source={{ kind: "文档原文", locator: `${PATH}#p91`, excerpt: "系统要能每分钟处理至少 100 笔借还" }} />
      </TaskIdContext.Provider>,
    );
    expect(await screen.findByText("这个任务没有这份材料。")).toBeInTheDocument();
    expect(screen.queryByTestId("docx-unrenderable")).toBeNull();
    await waitFor(() => expect(screen.getByText(/^出处：/).textContent).toBe("出处：requirements-styled.docx · 4 非功能需求（点一下看原文）"));
  });
});

describe("文件显示不出来时，材料区上方「Word 文件按原版式分页显示」那句说明不显示", () => {
  const HINT = /Word 文件按原版式分页显示/;
  it("缓存那一遍画不出来", async () => {
    mockApi();
    render(<MaterialPane taskId="TASK-U" materials={materials} locate={null} />);
    await screen.findByTestId("docx-unrenderable", undefined, SLOW);
    expect(screen.queryByText(HINT)).toBeNull();
  });

  it("缓存那一遍画好了、显示那一遍画不出来", async () => {
    fail.on = "view";
    mockApi();
    render(<MaterialPane taskId="TASK-U" materials={materials} locate={null} />);
    await screen.findByTestId("docx-unrenderable", undefined, SLOW);
    // 这种情形下「显示不出来」那块先出现，DocxPaper 随后才在副作用里报给材料区，那句说明晚一步才收起：等它消失，不是立刻查。
    await waitFor(() => expect(screen.queryByText(HINT)).toBeNull(), SLOW);
  });

  it("读不到文件（接口出错）", async () => {
    fail.on = "none";
    vi.spyOn(api, "materialRaw").mockRejectedValue(new ApiError("not_found", "这个任务没有这份材料。", 404));
    vi.spyOn(api, "materialContent").mockImplementation(content);
    render(<MaterialPane taskId="TASK-U" materials={materials} locate={null} />);
    await screen.findByText("这个任务没有这份材料。");
    expect(screen.queryByText(HINT)).toBeNull();
  });

  it("画得出来时照旧显示", async () => {
    fail.on = "none";
    mockApi();
    render(<MaterialPane taskId="TASK-U" materials={materials} locate={null} />);
    await waitFor(() => expect(document.querySelector("[data-testid=docx-paper] section.docx")).toBeTruthy(), SLOW);
    expect(screen.getByText(HINT)).toBeInTheDocument();
  });
});

describe("在两份 Word 文件之间切换", () => {
  it("从画得出来的切到已经知道画不出来的：说明收起；切回来：说明照旧显示", async () => {
    fail.on = "none";
    const OTHER = "inputs/other.docx";
    vi.spyOn(api, "materialRaw").mockImplementation(async (_t, p) => {
      if (p === OTHER) throw new ApiError("not_found", "这个任务没有这份材料。", 404);
      return SAMPLE.slice().buffer;
    });
    vi.spyOn(api, "materialContent").mockImplementation(content);
    const two = [...materials, { path: OTHER, bytes: 1, modified_at: "", derived_from: null }];
    render(<MaterialPane taskId="TASK-U" materials={two} locate={null} />);
    const select = await screen.findByTestId("material-select");
    await waitFor(() => expect(document.querySelector("[data-testid=docx-paper] section.docx")).toBeTruthy(), SLOW);
    fireEvent.change(select, { target: { value: OTHER } });
    await screen.findByText("这个任务没有这份材料。");
    expect(screen.queryByText(/Word 文件按原版式分页显示/)).toBeNull();
    fireEvent.change(select, { target: { value: PATH } });
    await waitFor(() => expect(screen.getByText(/Word 文件按原版式分页显示/)).toBeInTheDocument());
    fireEvent.change(select, { target: { value: OTHER } });
    await screen.findByText("这个任务没有这份材料。");
    expect(screen.queryByText(/Word 文件按原版式分页显示/)).toBeNull();
  });
});
