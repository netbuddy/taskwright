// 右侧栏是参照栏：页签只有原文定位、修订、评审、调试（评审与调试给了内容才有）；原文定位只显示一份材料的原文，不列材料清单。
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
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

  it("原文定位只写正在看的那一份的名字，不列材料清单；中栏点「查看」带来的材料换到这一份", async () => {
    vi.spyOn(api, "materialContent").mockImplementation(async (_t, path) => ({ path, text: `${path} 的原文` }) as never);
    const view = render(<div className="app"><SidePanel side="material" materials={materials} {...props} /></div>);
    expect(screen.getByTestId("material-name").textContent).toBe("借阅说明.md");
    expect(screen.queryByTestId("material-select")).toBeNull();
    view.rerender(<div className="app"><SidePanel side="material" materials={materials} {...props} focusPath="inputs/续借办法.md" /></div>);
    expect(screen.getByTestId("material-name").textContent).toBe("续借办法.md");
  });
});
