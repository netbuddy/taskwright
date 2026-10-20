/**
 * 六类资产给人看的名字：任务定义的「资产显示名」。早先的任务定义里没有这一项，这时回退读产品自带的任务类型里任务名相同的那份定义
 * （task-types/<类型>/docs/task-definitions/*.json）；找不到任务名相同的，取第一份写了资产显示名的；都没有时用键本身。
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { BUILTIN_TASK_TYPES_DIR } from "./activity_def_read.ts";
import { ASSETS, type AssetKey, parseAssetNames } from "./assets.ts";
import type { TaskDefinition } from "./definition.ts";

/** 产品自带的各份任务定义里的任务名与资产显示名，按目录名的次序；进程里只读一次。 */
let builtin: { taskName: string; names: Record<AssetKey, string> }[] | null = null;

function builtinDefinitions(): { taskName: string; names: Record<AssetKey, string> }[] {
  if (builtin !== null) return builtin;
  const found: { taskName: string; names: Record<AssetKey, string> }[] = [];
  const list = (dir: string): string[] => {
    try {
      return readdirSync(dir).sort();
    } catch {
      return [];
    }
  };
  for (const type of list(BUILTIN_TASK_TYPES_DIR)) {
    const dir = join(BUILTIN_TASK_TYPES_DIR, type, "docs", "task-definitions");
    for (const name of list(dir).filter((one) => one.endsWith(".json"))) {
      try {
        const raw = JSON.parse(readFileSync(join(dir, name), "utf-8")) as Record<string, unknown>;
        const names = parseAssetNames(raw["资产显示名"]);
        if (names !== null && typeof raw["任务名"] === "string") found.push({ taskName: raw["任务名"], names });
      } catch {
        // 读不出或不是 JSON 的文件不算。
      }
    }
  }
  builtin = found;
  return found;
}

/** 一个任务的资产显示名：定义里写了用它，没写按文件头的回退。 */
export function assetNamesOf(definition: Pick<TaskDefinition, "taskName" | "assetNames"> | null): Record<AssetKey, string> {
  if (definition?.assetNames) return definition.assetNames;
  const all = builtinDefinitions();
  const same = definition ? all.find((one) => one.taskName === definition.taskName) : undefined;
  return (same ?? all[0])?.names ?? (Object.fromEntries(ASSETS.map((key) => [key, key])) as Record<AssetKey, string>);
}
