/**
 * 操作名单的守护：lib/operations.ts 是一张数据表，lib/operations_map.ts 把工具、界面操作的种类与后端的写接口对应到表里的行。
 * 核对：表里的名字不重复、各列取值合法；每个工具文件（agent/src/tools/*.ts）、USER_OP_KINDS 的每个值、
 * 后端每个 POST 接口，在 OPERATION_MAP 与 NOT_IN_TABLE 两边合起来恰好出现一次；映射的目标都在表里；两边都没有多出来的名字。
 *
 * 后端的写接口靠静态扫描 backend/src/http.ts：路由表 ROUTES 里方法为 "POST" 的每一行取它的名字，
 * 另加数据包导入（PACK_IMPORTS，不经路由表）的两条路径。路由只认 GET 与 POST 两种方法，GET 都只读，不列。
 */

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { OPERATIONS } from "../src/lib/operations.ts";
import { NOT_IN_TABLE, OPERATION_MAP } from "../src/lib/operations_map.ts";
import { USER_OP_KINDS } from "../src/lib/user_ops.ts";

const ROOT = join(import.meta.dirname, "..", "..");

/** 路由表与数据包导入里的写接口；路由表里方法的种类另外返回，好核对只有 GET 与 POST。 */
function scanBackend(src: string): { posts: string[]; methods: string[] } {
  const table = /export const ROUTES[\s\S]*?\n\]/.exec(src)?.[0] ?? "";
  const rows = [...table.matchAll(/\[\s*"([A-Z]+)",\s*(?:"[^"]*"|`[^`]*`),\s*"([\w-]+)"\s*\]/g)];
  const packs = /const PACK_IMPORTS[^=]*=\s*\{([^}]*)\}/.exec(src)?.[1] ?? "";
  return {
    posts: [...rows.filter((row) => row[1] === "POST").map((row) => row[2]), ...[...packs.matchAll(/"(\/[^"]+)"\s*:/g)].map((m) => m[1])],
    methods: [...new Set(rows.map((row) => row[1]))].sort(),
  };
}

const BACKEND = scanBackend(readFileSync(join(ROOT, "backend", "src", "http.ts"), "utf-8"));
const TOOLS = readdirSync(join(ROOT, "agent", "src", "tools")).filter((name) => name.endsWith(".ts")).map((name) => name.replace(/\.ts$/, ""));
const GROUPS = {
  tools: TOOLS,
  user_op_kinds: [...USER_OP_KINDS] as string[],
  backend: BACKEND.posts,
} as const;

test("the operation table has unique names and legal values", () => {
  const names = OPERATIONS.map((one) => one.name);
  assert.deepEqual(names.filter((name, i) => names.indexOf(name) !== i), []);
  for (const one of OPERATIONS) {
    assert.ok(["user", "assistant", "program"].includes(one.initiator), one.name);
    assert.ok(["decision", "revision", "event"].includes(one.record), one.name);
    assert.ok(["anywhere", "activity-bound", "user-only"].includes(one.place), one.name);
    assert.ok(one.acts_on.length > 0, one.name);
    // 决策记录的发起者只能是用户。
    if (one.record === "decision") assert.equal(one.initiator, "user", one.name);
  }
});

test("the backend scan finds the write endpoints", () => {
  assert.deepEqual(BACKEND.methods, ["GET", "POST"], "路由表里出现了 GET 与 POST 以外的方法，扫描规则要跟着改");
  assert.ok(BACKEND.posts.includes("actions") && BACKEND.posts.includes("/api/v1/tasks/import"), "扫不出路由表或数据包导入了");
});

for (const group of Object.keys(GROUPS) as (keyof typeof GROUPS)[]) {
  test(`every name in ${group} is mapped to one operation or listed as not in the table, exactly once`, () => {
    const mapped = Object.keys(OPERATION_MAP[group]);
    const unmapped = Object.keys(NOT_IN_TABLE[group]);
    const want = GROUPS[group];
    assert.deepEqual(mapped.filter((name) => unmapped.includes(name)), [], "这些名字两边都有，只留一边");
    assert.deepEqual(want.filter((name) => !mapped.includes(name) && !unmapped.includes(name)), [],
      "这些名字没有对应到操作名单，在 lib/operations_map.ts 里补上");
    assert.deepEqual([...mapped, ...unmapped].filter((name) => !want.includes(name)), [], "这些名字已经不存在了，从 lib/operations_map.ts 里删掉");
  });
}

test("every mapping target is a row of the operation table", () => {
  const names = new Set<string>(OPERATIONS.map((one) => one.name));
  const wrong = Object.values(OPERATION_MAP).flatMap((map) => Object.entries(map).filter(([, one]) => !names.has(one!.operation)).map(([key]) => key));
  assert.deepEqual(wrong, []);
});

test("the backend scanner reads both route forms and the pack imports", () => {
  const src = [
    "export const ROUTES: [string, RegExp, string][] = ([",
    '  ["GET", "/api/v1/a", "a"],',
    '  ["POST", "/api/v1/b", "b"],',
    '  ["POST", `/api/v1/tasks/${T}/c`, "c"],',
    "] as const)",
    'const PACK_IMPORTS: Record<string, "task"> = { "/api/v1/d": "task" };',
  ].join("\n");
  assert.deepEqual(scanBackend(src), { posts: ["b", "c", "/api/v1/d"], methods: ["GET", "POST"] });
});
