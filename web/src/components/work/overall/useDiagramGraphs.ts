// 取任务里某几种图的 Mermaid 文本并解析出节点与连线（相关角色与对象、角色与用例对照表要用）。
// 整份任务数据里图的清单不带文本，所以按需取这几张图的详情；图有了新修订就重新取。取不到的那一张不算在内。

import { useEffect, useState } from "react";
import { api } from "../../../api/client";
import type { DiagramRow, Task } from "../../../api/types";
import { type DiagramGraph, diagramGraph } from "../../../../../agent/src/lib/diagram_scan.ts";
import { prefixesOf } from "../../../model/sectionDiagrams";

export interface DrawnGraph {
  row: DiagramRow;
  mermaid: string;
  graph: DiagramGraph;
}

/** 任务里这几种图各自的节点与连线，照任务里图的先后；还没有取回来时是空的。 */
export function useDiagramGraphs(task: Task, kinds: readonly string[]): DrawnGraph[] {
  const rows = (task.diagrams ?? []).filter((row) => kinds.includes(row.kind));
  const wanted = rows.map((row) => `${row.diagram_id}:${row.revision_no}`).join(",");
  const [got, setGot] = useState<{ key: string; graphs: DrawnGraph[] }>({ key: "", graphs: [] });
  useEffect(() => {
    if (rows.length === 0) { setGot({ key: wanted, graphs: [] }); return; }
    let stale = false;
    const prefixes = prefixesOf(task);
    void Promise.all(rows.map((row) => api.diagram(task.task_id, row.diagram_id).then(
      (detail) => (detail.deleted ? null : { row, mermaid: detail.mermaid, graph: diagramGraph(detail.mermaid, prefixes) }),
      () => null,
    ))).then((all) => { if (!stale) setGot({ key: wanted, graphs: all.filter((one) => one !== null) }); });
    return () => { stale = true; };
  }, [task.task_id, wanted]);
  return got.graphs;
}
