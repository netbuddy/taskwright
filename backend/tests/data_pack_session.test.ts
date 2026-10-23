/**
 * 按会话的诊断包（data_pack.ts 的 diagnostic.sessionId，session_groups.ts）：一个任务里造三条会话与几组归档，按其中一条导出，核对：
 * - 会话文件只带这一条（连同它续接前留下的备份）；归档组整组带，只带涉及它的；
 * - 判断次序：有「会话起点」记录的组照它；没有的旧归档照事件流里 get_state 回应的会话编号；都没有的按时刻区间重叠；
 * - 判不出的三种组不带，列进 omitted_groups，原因是固定的三句；
 * - 清单文件的 granularity、session_id、log_range（按会话首尾时刻取日志）；文件名带会话编号前 8 位；说明写明按会话；
 * - 与脱敏叠加；没有这条会话时拒绝；按会话的诊断包不能导入。
 */

import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import { after, test } from "node:test";
import { PackError, README_NAME, SESSION_IMPORT_TEXT, diagnosticPackName, exportPack, exportText, importPack } from "../src/data_pack.ts";
import { OMITTED_AT_EDGE, OMITTED_NO_SESSION_TIMES, OMITTED_NO_TIMES } from "../src/session_groups.ts";
import { captureConsole, tempDir } from "./helpers.ts";
import { dataWith, locations, put, readPack } from "./pack_stack.ts";

captureConsole();

const tmp = tempDir();
after(() => rmSync(tmp, { recursive: true, force: true }));
let n = 0;
const fresh = (name: string) => join(tmp, `${name}-${++n}`);
/** 一个新建的空目录里的包文件路径。 */
function outFile(name: string): string {
  const dir = fresh("out");
  mkdirSync(dir, { recursive: true });
  return join(dir, name);
}

const S1 = "01a11a9d-0000-7000-8000-000000000001";
const S2 = "01a11a9d-0000-7000-8000-000000000002";
const S3 = "01a11a9d-0000-7000-8000-000000000003";
const SETTINGS = { version: 2, selection: { language: null, embedding: null }, providers: {} };

const at = (iso: string) => Date.parse(iso) / 1000;
const jsonl = (rows: unknown[]) => rows.map((row) => JSON.stringify(row)).join("\n") + "\n";

/** 一条会话文件：会话头与几条消息，时刻是世界时。 */
function sessionFile(id: string, times: string[], name: string | null = null): string {
  return jsonl([
    { type: "session", version: 3, id, timestamp: times[0] ?? undefined, cwd: "/elsewhere/task" },
    ...times.map((t, i) => ({ type: "message", id: `m${i}`, timestamp: t, message: { role: "user", content: `第 ${i} 句` } })),
    ...(name ? [{ type: "session_info", id: "n1", name }] : []),
  ]);
}

/** 一组归档：原始事件流里每个 get_state 回应报一个会话编号，后端补记里可以有「会话起点」，收到时刻文件给首尾两个时刻。 */
function putGroup(archive: string, group: string, opts: { reported?: string[]; starts?: string[]; span?: [string, string] | null; noTimes?: boolean }) {
  const raw = [{ type: "agent_start" }, ...(opts.reported ?? []).map((sid, i) => ({ id: `service-${i}`, type: "response", command: "get_state", success: true, data: { sessionId: sid } })),
    { type: "agent_end" }];
  put(join(archive, "pi-events", `${group}.jsonl`), jsonl(raw));
  put(join(archive, "pi-events", `${group}.backend.jsonl`), jsonl([{ 记录: "启动", 时刻: "2026-09-20T10:00:00" },
    ...(opts.starts ?? []).map((sid, i) => ({ 记录: "会话起点", 时刻: "2026-09-20T10:00:00", 会话编号: sid, 本组文件名: `${group}.jsonl`, 起始行号: i + 1, 进入方式: i ? "switch" : "start" }))]));
  if (opts.noTimes) return;
  const span = opts.span ?? null;
  put(join(archive, "pi-events", `${group}.times.jsonl`), span ? jsonl(raw.map((_, i) => ({ 行号: i + 1, 收到时刻: i === raw.length - 1 ? at(span[1]) : at(span[0]) }))) : "");
}

/**
 * 一个任务，三条会话：S1（10:00 到 10:05）、S2（11:00 到 11:05）、S3（12:00）。归档组：
 * g1 新归档，会话起点只有 S1；g2 新归档，会话起点 S1 与 S2；g3 旧归档，get_state 报 S2；g4 旧归档，get_state 报 S3；
 * g5 旧归档没有 get_state，时段 10:59 到 11:10（S2 落在里面）；g6 同样，时段 13:00 到 13:10（与 S2 无关）；
 * g7 同样，没有收到时刻文件；g8 同样，时段 11:05:00.5 到 11:06（S2 最后一条 11:05 只落在容差里）。
 */
async function sampleTask() {
  const where = await dataWith(fresh("data"), ["甲"]);
  const [taskId] = where.ids;
  const archive = join(where.runsDir, taskId);
  const s2Name = `2026-09-20T11-00-00-000Z_${S2}.jsonl`;
  put(join(archive, "pi-sessions", "service", `2026-09-20T10-00-00-000Z_${S1}.jsonl`), sessionFile(S1, ["2026-09-20T10:00:00.000Z", "2026-09-20T10:05:00.000Z"]));
  put(join(archive, "pi-sessions", "service", s2Name), sessionFile(S2, ["2026-09-20T11:00:00.000Z", "2026-09-20T11:05:00.000Z"], "退款核读"));
  put(join(archive, "pi-sessions", "service", `${s2Name}.cwd-20260920-110000.bak`), sessionFile(S2, ["2026-09-20T11:00:00.000Z"]));
  put(join(archive, "pi-sessions", "service", `2026-09-20T12-00-00-000Z_${S3}.jsonl`), sessionFile(S3, ["2026-09-20T12:00:00.000Z"]));
  putGroup(archive, "service-20260920-100000", { starts: [S1], reported: [S1], span: ["2026-09-20T10:00:00Z", "2026-09-20T10:06:00Z"] });
  putGroup(archive, "service-20260920-103000", { starts: [S1, S2], reported: [S1, S2], span: ["2026-09-20T10:30:00Z", "2026-09-20T11:06:00Z"] });
  putGroup(archive, "service-20260920-110000", { reported: [S2], span: ["2026-09-20T11:00:00Z", "2026-09-20T11:06:00Z"] });
  putGroup(archive, "service-20260920-120000", { reported: [S3], span: ["2026-09-20T12:00:00Z", "2026-09-20T12:01:00Z"] });
  putGroup(archive, "service-20260920-105900", { span: ["2026-09-20T10:59:00Z", "2026-09-20T11:10:00Z"] });
  putGroup(archive, "service-20260920-130000", { span: ["2026-09-20T13:00:00Z", "2026-09-20T13:10:00Z"] });
  putGroup(archive, "service-20260920-140000", { noTimes: true });
  putGroup(archive, "service-20260920-110500", { span: ["2026-09-20T11:05:00.500Z", "2026-09-20T11:06:00Z"] });
  return { where, taskId, archive };
}

const diagnostic = (where: { dataDir: string }, sessionId: string, redact = false) => ({ settings: SETTINGS as any, logsDir: join(where.dataDir, "logs"), sessionId, redact });

test("按会话导出：会话文件只带这一条（连同备份）；归档组按会话起点、get_state、时刻依次判断，整组带；判不出的列进 omitted_groups", async () => {
  const { where, taskId } = await sampleTask();
  const to = outFile(diagnosticPackName(taskId, new Date(2026, 9, 22, 9, 5), false, S2));
  assert.equal(basename(to), `diag-${taskId}-01a11a9d-20261022-0905.taskwright.zip`);
  const result = await exportPack(where, { scope: "task", taskId, to, diagnostic: diagnostic(where, S2) });
  const { manifest, names, content } = readPack(to);
  const runs = names.filter((one) => one.startsWith(`runs/${taskId}/`)).map((one) => one.slice(`runs/${taskId}/`.length)).sort();
  const groups = ["service-20260920-103000", "service-20260920-105900", "service-20260920-110000"];
  assert.deepEqual(runs, [
    ...groups.flatMap((g) => [`pi-events/${g}.backend.jsonl`, `pi-events/${g}.jsonl`, `pi-events/${g}.times.jsonl`]),
    `pi-sessions/service/2026-09-20T11-00-00-000Z_${S2}.jsonl`, `pi-sessions/service/2026-09-20T11-00-00-000Z_${S2}.jsonl.cwd-20260920-110000.bak`,
  ].sort());
  assert.equal(manifest.diagnostic!.granularity, "session");
  assert.equal(manifest.diagnostic!.session_id, S2);
  assert.deepEqual(manifest.diagnostic!.omitted_groups, [
    { group: "service-20260920-110500", reason: OMITTED_AT_EDGE },
    { group: "service-20260920-140000", reason: OMITTED_NO_TIMES },
  ]);
  const readme = content(README_NAME).toString("utf-8");
  for (const part of ["这是诊断包", `包里的会话：\n  ${S2}「退款核读」`, "整组带，所以同一组里也可能有同一时段别的会话的记录", "对话记录：只有这一条会话",
    "别的会话的对话记录", "有 2 组运行轨迹判断不了是否属于这条会话", "它只带一条会话的对话记录，不能导入。"]) assert.ok(readme.includes(part), part);
  assert.deepEqual(result.diagnostic!.session, { id: S2, groups: 3, omitted: 2 });
  assert.match(exportText(result), /按会话导出：只带会话 01a11a9d-0000-7000-8000-000000000002 的对话记录与涉及它的 3 组运行轨迹（整组带）。另有 2 组判断不了/);
});

test("新归档只看会话起点：S1 带它出现过的两组；会话文件里没有带时刻的条目时，没有会话起点与 get_state 的组都判不出", async () => {
  const { where, taskId, archive } = await sampleTask();
  const to = outFile("s1.taskwright.zip");
  await exportPack(where, { scope: "task", taskId, to, diagnostic: diagnostic(where, S1) });
  const events = readPack(to).names.filter((one) => one.includes("/pi-events/") && one.endsWith(".times.jsonl")).map((one) => basename(one, ".times.jsonl")).sort();
  // g5、g6、g8 的时段都不含 S1 的条目（10:00 到 10:05），也不在容差里：不属于，不列；g7 没有收到时刻文件：判不出。
  assert.deepEqual(events, ["service-20260920-100000", "service-20260920-103000"]);
  assert.deepEqual(readPack(to).manifest.diagnostic!.omitted_groups, [{ group: "service-20260920-140000", reason: OMITTED_NO_TIMES }]);
  // 会话文件里没有带时刻的条目。
  put(join(archive, "pi-sessions", "service", `2026-09-20T12-00-00-000Z_${S3}.jsonl`), jsonl([{ type: "session", id: S3 }]));
  const bare = outFile("s3.taskwright.zip");
  await exportPack(where, { scope: "task", taskId, to: bare, diagnostic: diagnostic(where, S3) });
  const pack = readPack(bare);
  assert.deepEqual(pack.names.filter((one) => one.endsWith(".times.jsonl")).map((one) => basename(one, ".times.jsonl")), ["service-20260920-120000"]);
  assert.deepEqual(pack.manifest.diagnostic!.omitted_groups!.map((one) => [one.group, one.reason]), [
    ["service-20260920-105900", OMITTED_NO_SESSION_TIMES], ["service-20260920-110500", OMITTED_NO_SESSION_TIMES],
    ["service-20260920-130000", OMITTED_NO_SESSION_TIMES], ["service-20260920-140000", OMITTED_NO_TIMES],
  ]);
  assert.equal(pack.manifest.diagnostic!.log_range, null);
});

test("按会话的后端日志：文件名日期不晚于会话最后一条的那天、最后修改不早于会话第一条；log_range 写会话首尾", async () => {
  const { where, taskId } = await sampleTask();
  const logs = join(where.dataDir, "logs");
  put(join(logs, "backend-20260919.log"), "早先停了的\n", Date.parse("2026-09-20T09:00:00Z"));
  put(join(logs, "backend-20260920.log"), "当天的\n", Date.parse("2026-09-20T11:30:00Z"));
  put(join(logs, "backend-20260921.log"), "之后起的\n", Date.parse("2026-09-21T10:00:00Z"));
  const to = outFile("logs.taskwright.zip");
  await exportPack(where, { scope: "task", taskId, to, diagnostic: diagnostic(where, S2) });
  const { manifest, names, content } = readPack(to);
  assert.deepEqual(names.filter((one) => one.startsWith("logs/")), ["logs/backend-20260920.log"]);
  assert.deepEqual([Date.parse(manifest.diagnostic!.log_range!.from), Date.parse(manifest.diagnostic!.log_range!.to)],
    [Date.parse("2026-09-20T11:00:00Z"), Date.parse("2026-09-20T11:05:00Z")]);
  assert.match(content(README_NAME).toString("utf-8"), /- 后端日志：这条会话（.* 到 .*）期间写过的后端日志文件，整份（logs\/）。/);
});

test("与脱敏叠加：purpose 是 redacted、granularity 是 session，说明是脱敏诊断包并写明按会话；文件名带会话前 8 位与 -redacted", async () => {
  const { where, taskId } = await sampleTask();
  assert.equal(diagnosticPackName(taskId, new Date(2026, 9, 22, 9, 5), true, S2), `diag-${taskId}-01a11a9d-20261022-0905-redacted.taskwright.zip`);
  const to = outFile("red.taskwright.zip");
  const result = await exportPack(where, { scope: "task", taskId, to, diagnostic: diagnostic(where, S2, true) });
  const { manifest, names, content } = readPack(to);
  assert.deepEqual([manifest.diagnostic!.purpose, manifest.diagnostic!.granularity, manifest.diagnostic!.session_id], ["redacted", "session", S2]);
  assert.equal(names.filter((one) => one.includes("/pi-sessions/") && one.endsWith(".jsonl")).length, 1);
  const readme = content(README_NAME).toString("utf-8");
  assert.ok(readme.startsWith("这是脱敏诊断包"), readme);
  assert.ok(readme.includes(`包里的会话：\n  ${S2}「退款核读」`) && readme.includes("对话记录：只有这一条会话"), readme);
  assert.deepEqual(result.diagnostic!.redacted, true);
});

test("任务里没有这条会话时拒绝；按会话的诊断包不能导入", async () => {
  const { where, taskId } = await sampleTask();
  await assert.rejects(exportPack(where, { scope: "task", taskId, to: outFile("x.zip"), diagnostic: diagnostic(where, "01a11a9d-ffff-7000-8000-000000000009") }),
    (error: unknown) => error instanceof PackError && error.code === "not_found" && error.message === "这个任务实例里没有会话 01a11a9d-ffff-7000-8000-000000000009。");
  const to = outFile("s2.taskwright.zip");
  await exportPack(where, { scope: "task", taskId, to, diagnostic: diagnostic(where, S2) });
  const report = await importPack(locations(fresh("target")), { file: to });
  assert.deepEqual([report.fatal, report.tasks], [SESSION_IMPORT_TEXT, []]);
});
