// 一份带总体分析集合的任务快照，照图书馆借阅的例子：11 页主题、14 条已定、3 条待问、2 处待核实，另有三个用例与四个问题。
// 数据在 overall-analysis.json 里（字段名照任务定义：标题、别名、它是什么、例子、已经定下的、标签、上级主题、状态、改看），
// 这里只把它装成页面用的任务对象；每次调用给一份新的，测试里可以随便改。
import type { Item, Task } from "../../api/types";
import data from "./overall-analysis.json";

export function overallTask(over: Partial<Task> = {}): Task {
  const copy = structuredClone(data) as unknown as { definition: Task["definition"]; items: Item[] };
  return {
    task_id: "TASK-001", task_name: "图书馆借阅系统", task_type: "软件需求规格说明编制", domain_tag: null, started_at: "",
    definition: copy.definition, completion: null, items: copy.items, latest_revision: 12, diagrams: [], ...over,
  };
}

/** 按编号取一页（或一个条目），取不到就让测试当场失败。 */
export function itemOf(task: Task, id: string): Item {
  const item = task.items.find((i) => i.item_id === id);
  if (!item) throw new Error(`夹具里没有 ${id}`);
  return item;
}

/** 就地改一个条目，返回同一个任务，方便连着写。 */
export function change(task: Task, id: string, patch: (item: Item) => void): Task {
  patch(itemOf(task, id));
  return task;
}
