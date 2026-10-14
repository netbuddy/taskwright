/**
 * 从产品自带的定义文件里读出全部活动与流程的头（lib/activity_def.ts）。只读文件，不读库。
 *
 * 活动的定义在 agent/prompts/stages/ 下以活动的键命名（七份：六个工作阶段加发布），流程的定义在 agent/prompts/flows/ 下以流程的键命名。
 * 头里写的键要与文件名相同。任何一份不在、头缺栏、取值不认，都抛错（DefinitionHeadError），调用方据此不出活动目录。
 * 进程里记着上一次读的结果与各份文件的修改时刻和大小，文件没变就不重读。
 */

import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { ACTIVITIES, type ActivityDef, DefinitionHeadError, FLOW_KEYS, type FlowDef, parseActivityDef, parseFlowDef } from "./activity_def.ts";
import { PLATFORM_FLOWS_DIR, PLATFORM_STAGES_DIR } from "./stage_prompt.ts";

/** 全部活动与流程的头，按 ACTIVITIES 与 FLOW_KEYS 的次序。 */
export interface Definitions {
  activities: ActivityDef[];
  flows: FlowDef[];
}

/** 读一遍，不用记着的结果。两个目录缺省是产品自带的，测试里换成别的。 */
export function readDefinitions(stagesDir: string = PLATFORM_STAGES_DIR, flowsDir: string = PLATFORM_FLOWS_DIR): Definitions {
  const read = (path: string): string => {
    try {
      return readFileSync(path, "utf-8");
    } catch {
      throw new DefinitionHeadError(`定义文件不在：${path}`);
    }
  };
  const activities = ACTIVITIES.map((key) => {
    const file = `${key}.md`;
    const found = parseActivityDef(read(join(stagesDir, file)), file);
    if (found.key !== key) throw new DefinitionHeadError(`${file} 的头里「activity」写的是「${found.key}」，应当与文件名相同。`);
    return found;
  });
  const flows = FLOW_KEYS.map((key) => {
    const file = `${key}.md`;
    const found = parseFlowDef(read(join(flowsDir, file)), file);
    if (found.key !== key) throw new DefinitionHeadError(`${file} 的头里「flow」写的是「${found.key}」，应当与文件名相同。`);
    return found;
  });
  return { activities, flows };
}

let last: { stamp: string; value: Definitions } | null = null;

/** 产品自带的全部活动与流程的头。文件没变时用记着的那一份。 */
export function definitions(): Definitions {
  const paths = [...ACTIVITIES.map((key) => join(PLATFORM_STAGES_DIR, `${key}.md`)), ...FLOW_KEYS.map((key) => join(PLATFORM_FLOWS_DIR, `${key}.md`))];
  const stamp = paths.map((path) => {
    const found = statSync(path, { throwIfNoEntry: false });
    return found ? `${found.mtimeMs}:${found.size}` : "-";
  }).join("|");
  if (last === null || last.stamp !== stamp) last = { stamp, value: readDefinitions() };
  return last.value;
}
