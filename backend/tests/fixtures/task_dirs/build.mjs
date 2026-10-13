// Builds the sample task directories of earlier releases that the data upgrade tests use.
//
// Usage (from the repository root): node backend/tests/fixtures/task_dirs/build.mjs [version ...]
// Without arguments it rebuilds all five: 0.4.0 0.4.1 0.4.2 0.4.3 0.5.0.
//
// Each sample is written by the code of that release itself, not by today's code: the script takes the release's
// agent/, backend/ and task-types/ out of git (`git archive v<version>`) into a temporary directory and runs a small
// seed script there, which creates a requirements task with that release's own functions, puts one material in it
// and saves three revisions (two use cases; a domain note added by the assistant; a use case that cites the note).
// The 0.5.0 sample is seeded differently (SEED_STAGES): that release has working stages, so its seed moves the task
// through stages the way a user does (four moves: to clarifying, modeling and writing, then back to clarifying) and
// saves one topic page on the way. It is the sample for the upgrade that turns stage records into
// activity records.
// What is kept is what a task directory of that release holds apart from run archives and session files:
// task.sqlite, docs/ and inputs/. The directory of each sample is replaced as a whole.
//
// The repository must have the release tags (v0.4.0 ... v0.5.0). Times and operation ids differ from run to run,
// so a rebuilt task.sqlite is not byte for byte the one committed; the tests check counts and content, not bytes.
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..", "..", "..");
const ALL = ["0.4.0", "0.4.1", "0.4.2", "0.4.3", "0.5.0"];
// Releases with working stages: seeded with SEED_STAGES.
const STAGED = ["0.5.0"];
const KEPT = ["task.sqlite", "docs", "inputs"];

// Runs inside the extracted release. The names of two kinds of sources changed in 0.4.2 (see the changelog), so the
// seed asks the release which names it knows: `renamed` is true from 0.4.2 on.
const SEED = `
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createTaskDir } from "./backend/src/workspace.ts";
import { saveRevision } from "./agent/src/lib/save_revision.ts";

const [dir, taskId, renamed] = [process.argv[2], process.argv[3], process.argv[4] === "renamed"];
createTaskDir(dir, "srs-authoring", "图书借阅（样本）", null, taskId);
const material = "读者凭借书证在自助机上借书。\\n每位读者最多同时借五本。\\n逾期不还的，按馆里的规定罚款。\\n";
writeFileSync(join(dir, "inputs", "材料.md"), material, "utf-8");
const call = (callId) => ({ workspaceDir: dir, sessionId: "session-sample", callId });
const quote = (excerpt) => ({ kind: "文档原文", locator: "inputs/材料.md", excerpt });
const useCase = (name, purpose, flow, sources) => ({ op: "add", collection: "功能用例", sources,
  fields: { 用例名称: name, 用例功能: purpose, 参与者: ["读者"], 基本流程: flow } });
const must = (result) => {
  if (result.isError || result.details?.rejected) throw new Error("the seed was refused: " + JSON.stringify(result.details ?? result));
  return result;
};
must(saveRevision(call("call-1"), { operations: [
  useCase("借书", "读者在自助机上借书。", ["读者在自助机上刷借书证", "系统记下借阅"], [quote("读者凭借书证在自助机上借书。")]),
  useCase("查看可借数量", "读者查看自己还能借几本。", ["读者打开借阅记录", "系统显示还能借几本"], [quote("每位读者最多同时借五本。")]),
] }));
must(saveRevision(call("call-2"), { operations: [{ op: "add", collection: "领域说明",
  fields: { 标题: "借书证", 内容: "借书证是读者在本馆借书的凭证。", 类别: "术语" },
  sources: [renamed ? { kind: "助手补充", excerpt: "按常识解释这个词" } : { kind: "执行者补充", locator: "执行者补充", excerpt: "按常识解释这个词" }] }] }));
must(saveRevision(call("call-3"), { operations: [useCase("挂失借书证", "读者挂失借书证。", ["读者提出挂失", "系统停用这张借书证"],
  [{ kind: renamed ? "条目" : "领域说明", locator: "DN-001", excerpt: "借书证是读者在本馆借书的凭证。" }])] }));
`;

// Runs inside the extracted release, for releases with working stages. The moves are the user's (the release lets only
// the user move the task); the page is saved while clarifying, as the assistant would.
const SEED_STAGES = `
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createTaskDir } from "./backend/src/workspace.ts";
import { saveRevision } from "./agent/src/lib/save_revision.ts";
import { withTaskDatabase } from "./agent/src/lib/schema.ts";
import { moveStage } from "./agent/src/lib/stage_read.ts";

const [dir, taskId] = [process.argv[2], process.argv[3]];
createTaskDir(dir, "srs-authoring", "图书借阅（样本）", null, taskId);
const material = "读者凭借书证在自助机上借书。\\n每位读者最多同时借五本。\\n逾期不还的，按馆里的规定罚款。\\n";
writeFileSync(join(dir, "inputs", "材料.md"), material, "utf-8");
const call = (callId) => ({ workspaceDir: dir, sessionId: "session-sample", callId });
const quote = (excerpt) => ({ kind: "文档原文", locator: "inputs/材料.md", excerpt });
const must = (result) => {
  if (result.isError || result.details?.rejected) throw new Error("the seed was refused: " + JSON.stringify(result.details ?? result));
  return result;
};
let op = 0;
const move = (to, reason) => {
  op += 1;
  const outcome = withTaskDatabase(dir, { createIfMissing: false }, (db) =>
    moveStage(db, dir, { taskId, sessionId: "session-sample", runId: null, callId: "ui-op-" + op, actor: "user" }, to, reason));
  if (!outcome.moved) throw new Error("the seed could not move to " + to + ": " + JSON.stringify(outcome));
};
move("clarifying", "用户在卡片上选了「进入澄清」");
must(saveRevision(call("call-1"), { operations: [{ op: "add", collection: "总体分析",
  fields: { 标题: "借书", 它是什么: "读者凭借书证在自助机上借书。", 标签: ["流程"], 状态: "在用" }, sources: [quote("读者凭借书证在自助机上借书。")] }] }));
move("modeling", "用户在卡片上选了「进入整理建模」");
move("writing", "用户在卡片上选了「开始写条目」");
move("clarifying", "借期还没有问清楚。");
`;

function build(version) {
  const tag = `v${version}`;
  try {
    execFileSync("git", ["-C", REPO, "rev-parse", "--verify", "--quiet", `refs/tags/${tag}`], { stdio: "ignore" });
  } catch {
    throw new Error(`the repository has no tag ${tag}; fetch the release tags first`);
  }
  const work = mkdtempSync(path.join(tmpdir(), `taskwright-sample-${version}-`));
  try {
    const archive = execFileSync("git", ["-C", REPO, "archive", tag, "agent", "backend", "task-types", "package.json"], { maxBuffer: 256 * 1024 * 1024 });
    execFileSync("tar", ["-x", "-C", work], { input: archive });
    writeFileSync(path.join(work, "seed.mts"), STAGED.includes(version) ? SEED_STAGES : SEED, "utf-8");
    const task = path.join(work, "sample");
    const renamed = version.localeCompare("0.4.2", undefined, { numeric: true }) >= 0;
    // TASKWRIGHT_TASKS_ROOT: the release checks that the database it writes lies under the service's task root.
    execFileSync(process.execPath, ["seed.mts", task, `TASK-SAMPLE-${version.replaceAll(".", "")}`, renamed ? "renamed" : "old"],
      { cwd: work, env: { ...process.env, TASKWRIGHT_TASKS_ROOT: work }, stdio: ["ignore", "inherit", "inherit"] });
    const target = path.join(HERE, version);
    rmSync(target, { recursive: true, force: true });
    mkdirSync(target, { recursive: true });
    for (const name of KEPT) cpSync(path.join(task, name), path.join(target, name), { recursive: true });
    console.log(`${version}: written to ${path.relative(REPO, target)}`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

const wanted = process.argv.slice(2);
for (const version of wanted.length ? wanted : ALL) {
  if (!ALL.includes(version)) throw new Error(`unknown version ${version}; one of ${ALL.join(" ")}`);
  build(version);
}
