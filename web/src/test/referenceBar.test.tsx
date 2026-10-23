// 右侧栏是参照栏：页签只有原文定位、修订、评审、调试（评审与调试给了内容才有）；原文定位显示一份输入资料的原文，
// 材料不止一份时文件名那里是下拉框，用户可以自己选一份来读。
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { api } from "../api/client";
import { SidePanel } from "../components/work/SidePanel";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const noop = () => {};
const props = {
  onSide: noop, onCollapse: noop, onExpand: noop, taskId: "TASK-1", focusPath: null, items: [], locate: null, currentItem: null, disabled: false,
  onOpenItem: noop, onSend: noop, log: [], messages: [], selectedRevision: null, onSelectRevision: noop, scrollNonce: 0, onDiff: noop, onUndo: noop,
  onGenerate: noop, writesOff: false, readOnly: false,
};
const materials = ["inputs/借阅说明.md", "inputs/续借办法.md"].map((path) => ({ path, bytes: 1, modified_at: "", derived_from: null }));

describe("参照栏", () => {
  it("页签只有原文定位、修订、评审、调试；评审与调试给了内容才有；收起后的把手照样列出这几个名字", () => {
    vi.spyOn(api, "materialContent").mockResolvedValue({ path: materials[0].path, text: "读者凭借书证借书。" } as never);
    const view = render(<div className="app"><SidePanel side="material" materials={materials} {...props} /></div>);
    expect([...document.querySelectorAll(".sw-stab")].map((one) => one.textContent)).toEqual(["原文定位", "修订"]);
    view.rerender(<div className="app"><SidePanel side="material" materials={materials} {...props} review={<div />} reviewCount={2} debug={<div />} /></div>);
    expect([...document.querySelectorAll(".sw-stab")].map((one) => one.textContent)).toEqual(["原文定位", "修订", "评审2", "调试"]);
  });

  it("材料不止一份：原文定位的文件名那里是下拉框，列出各份，选一份就读那一份；中栏点「查看」带来的材料也换到这一份", async () => {
    vi.spyOn(api, "materialContent").mockImplementation(async (_t, path) => ({ path, text: `${path} 的原文` }) as never);
    const view = render(<div className="app"><SidePanel side="material" materials={materials} {...props} /></div>);
    const select = screen.getByTestId("material-select") as HTMLSelectElement;
    expect([...select.options].map((one) => one.textContent)).toEqual(["借阅说明.md", "续借办法.md"]);
    expect(select.value).toBe("inputs/借阅说明.md");
    expect(screen.queryByTestId("material-name")).toBeNull();
    fireEvent.change(select, { target: { value: "inputs/续借办法.md" } });
    expect(await screen.findByText("inputs/续借办法.md 的原文")).toBeTruthy();
    view.rerender(<div className="app"><SidePanel side="material" materials={materials} {...props} focusPath="inputs/借阅说明.md" /></div>);
    expect((screen.getByTestId("material-select") as HTMLSelectElement).value).toBe("inputs/借阅说明.md");
  });

  it("从条目来源跳到另一份之后，下拉框跟着换；再从下拉框选回原来那一份照样换回去", async () => {
    vi.spyOn(api, "materialContent").mockImplementation(async (_t, path) => ({ path, text: `${path} 的原文` }) as never);
    const view = render(<div className="app"><SidePanel side="material" materials={materials} {...props} /></div>);
    const select = () => screen.getByTestId("material-select") as HTMLSelectElement;
    fireEvent.change(select(), { target: { value: "inputs/借阅说明.md" } });
    view.rerender(<div className="app"><SidePanel side="material" materials={materials} {...props} locate={{ locator: "inputs/续借办法.md", excerpt: "续借", nonce: 1 }} /></div>);
    expect(select().value).toBe("inputs/续借办法.md");
    fireEvent.change(select(), { target: { value: "inputs/借阅说明.md" } });
    expect(select().value).toBe("inputs/借阅说明.md");
    expect(await screen.findByText("inputs/借阅说明.md 的原文")).toBeTruthy();
  });

  it("只有一份输入资料：写它的名字，没有下拉框", () => {
    vi.spyOn(api, "materialContent").mockResolvedValue({ path: materials[0].path, text: "读者凭借书证借书。" } as never);
    render(<div className="app"><SidePanel side="material" materials={materials.slice(0, 1)} {...props} /></div>);
    expect(screen.getByTestId("material-name").textContent).toBe("借阅说明.md");
    expect(screen.queryByTestId("material-select")).toBeNull();
  });
});
