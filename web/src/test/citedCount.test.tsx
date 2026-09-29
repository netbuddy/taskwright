// 材料页签文件名旁的「被 N 个条目引用过」：摘录在原文里找得到的条目都算。两个条目的摘录互相重叠时两个都计入；
// 点来源标签高亮某一段的那两秒里，数字不变。
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import type { Item } from "../api/types";
import { api } from "../api/client";
import { MaterialPane } from "../components/work/MaterialPane";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const PATH = "inputs/规则.md";
const TEXT = "借期三十天。逾期每天罚款一角，罚款最多不超过这本书的定价。罚款怎样缴纳后续再定。续借一次。";

const item = (id: string, excerpt: string) =>
  ({ item_id: id, collection: "功能用例", fields: {}, sources: [{ kind: "文档原文", locator: PATH, excerpt }] }) as unknown as Item;

// UC-002 与 TBD-002 的摘录重叠在「罚款最多不超过这本书的定价。」；UC-001 与它们不重叠。
const ITEMS = [
  item("UC-001", "借期三十天。"),
  item("UC-002", "逾期每天罚款一角，罚款最多不超过这本书的定价。"),
  item("TBD-002", "罚款最多不超过这本书的定价。罚款怎样缴纳后续再定。"),
];
const materials = [{ path: PATH, bytes: 1, modified_at: "" }];

describe("材料页签的引用计数", () => {
  it("摘录重叠的两个条目都计入；高亮某一段时计数不变", async () => {
    vi.spyOn(api, "materialContent").mockResolvedValue({ path: PATH, text: TEXT });
    const { rerender } = render(<MaterialPane taskId="TASK-001" materials={materials} items={ITEMS} />);
    expect(await screen.findByText("被 3 个条目引用过")).toBeInTheDocument();
    // 高亮一段盖住 UC-001 与 UC-002 的分段。
    rerender(<MaterialPane taskId="TASK-001" materials={materials} items={ITEMS}
      locate={{ excerpt: "借期三十天。逾期每天罚款一角", locator: PATH, nonce: 1 }} />);
    await waitFor(() => expect(document.querySelector("mark.hit")).not.toBeNull());
    expect(screen.getByText("被 3 个条目引用过")).toBeInTheDocument();
  });

  it("摘录在原文里找不到的条目不算", async () => {
    vi.spyOn(api, "materialContent").mockResolvedValue({ path: PATH, text: TEXT });
    render(<MaterialPane taskId="TASK-001" materials={materials} items={[ITEMS[0], item("UC-009", "材料里没有的一句话。")]} />);
    expect(await screen.findByText("被 1 个条目引用过")).toBeInTheDocument();
  });
});
