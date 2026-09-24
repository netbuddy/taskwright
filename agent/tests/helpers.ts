/**
 * 单元测试共用的小夹具：在临时目录里建一个任务目录，放一份小的任务定义。
 * 夹具是测试自己写的，与真实任务的起始文件无关。
 */

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { databasePath } from "../src/lib/db.ts";

export const DEFINITION_PATH = "docs/task-definitions/demo.json";

/** 一份覆盖四种字段类型的小任务定义。 */
export function demoDefinition(): Record<string, unknown> {
  return {
    任务名: "演示任务",
    交付物: {
      名称: "演示交付物",
      文档模板: "docs/templates/demo.md",
      条目集合: [
        {
          名称: "用例",
          编号前缀: "UC",
          字段: [
            { 名: "名称", 类型: "文本", 必填: true },
            { 名: "步骤", 类型: "文本列表", 必填: true },
            { 名: "备注", 类型: "文本", 必填: false },
          ],
        },
        {
          名称: "待定事项",
          编号前缀: "TBD",
          字段: [
            { 名: "事项", 类型: "文本", 必填: true },
            { 名: "状态", 类型: "枚举", 必填: true, 取值: ["未解决", "已解决"] },
            { 名: "关联条目", 类型: "条目引用", 必填: false },
          ],
        },
      ],
      每个条目附带: "来源",
    },
    完成条件: {
      用例: ["至少一个条目", "每个条目评审通过", "每个条目用户确认"],
      待定事项: ["没有状态为未解决的条目"],
    },
    执行方法: ".pi/skills/demo/SKILL.md",
    领域规矩: ["docs/domain-knowledge/demo.md"],
  };
}

/** 建一个临时任务目录，写好任务定义文件，返回任务目录。 */
export function makeWorkspace(definition: unknown = demoDefinition()): string {
  const dir = mkdtempSync(join(tmpdir(), "taskwright-agent-test-"));
  mkdirSync(join(dir, "docs/task-definitions"), { recursive: true });
  writeFileSync(join(dir, DEFINITION_PATH), JSON.stringify(definition, null, 2), "utf-8");
  return dir;
}

let counter = 0;
/** 一次调用的上下文：会话编号固定，调用编号每次不同，模仿 pi 给的样子。 */
export function callIn(workspaceDir: string, sessionId = "session-test") {
  counter += 1;
  return { workspaceDir, sessionId, callId: `call-${counter}` };
}

/** 以只读方式打开任务目录的库，查完自己关掉。 */
export function query<T = Record<string, unknown>>(workspaceDir: string, sql: string, ...args: unknown[]): T[] {
  const db = new DatabaseSync(databasePath(workspaceDir), { readOnly: true });
  try {
    return db.prepare(sql).all(...(args as never[])) as T[];
  } finally {
    db.close();
  }
}

/** 数一张表有几行。 */
export function count(workspaceDir: string, table: string): number {
  return Number(query<{ n: number }>(workspaceDir, `SELECT COUNT(*) AS n FROM ${table}`)[0].n);
}

/** 一条合格的来源。 */
export const SOURCE = { kind: "文档原文", locator: "inputs/材料.md", excerpt: "用户可以登录。" };
