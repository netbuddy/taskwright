// Builds the sample task directories in format 8 that the data upgrade tests use.
//
// Usage (from the repository root): node backend/tests/fixtures/task_dirs/build.mjs [name ...]
// Without arguments it rebuilds both: format-8-a format-8-b.
//
// Format 8 is the oldest task database format this program still upgrades. Each sample is written by code that wrote
// format 8 itself, not by today's code: the script takes agent/, backend/ and task-types/ of commit 8e32feb (the last
// commit before format 9) out of git (`git archive`) into a temporary directory and runs a small seed script there.
// - format-8-a: a requirements task with one material; the user starts the requirements-analysis work item in
//   session-sample, a topic page is saved while reading, the user moves the work item to clarifying, and one tool
//   rejection is recorded (format 8 has no reason codes for it).
// - format-8-b: a requirements task with one material and one topic page saved in a session that belongs to no work item.
// What is kept is what a task directory holds apart from run archives and session files: task.sqlite, docs/ and inputs/.
// The directory of each sample is replaced as a whole.
//
// Times and operation ids differ from run to run, so a rebuilt task.sqlite is not byte for byte the one committed;
// the tests check counts and content, not bytes.
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..", "..", "..");
/** The commit whose code writes format 8. */
const FORMAT_8_REF = "8e32feb";
const KEPT = ["task.sqlite", "docs", "inputs"];

const COMMON = `
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createTaskDir } from "./backend/src/workspace.ts";
import { saveRevision } from "./agent/src/lib/save_revision.ts";
import { withTaskDatabase } from "./agent/src/lib/schema.ts";
import { moveStage, startActivity } from "./agent/src/lib/stage_read.ts";
import { ToolRejection, recordRejection } from "./agent/src/lib/tool_rejection.ts";

const [dir, taskId, name] = [process.argv[2], process.argv[3], process.argv[4]];
createTaskDir(dir, "srs-authoring", name, null, taskId);
const material = "读者凭借书证在自助机上借书。\\n每位读者最多同时借五本。\\n逾期不还的，按馆里的规定罚款。\\n";
writeFileSync(join(dir, "inputs", "材料.md"), material, "utf-8");
const call = (sessionId, callId) => ({ workspaceDir: dir, sessionId, callId });
const quote = (excerpt) => ({ kind: "文档原文", locator: "inputs/材料.md", excerpt });
const page = (title, what, excerpt) => ({ op: "add", collection: "总体分析", fields: { 标题: title, 它是什么: what, 标签: ["流程"], 状态: "在用" }, sources: [quote(excerpt)] });
const must = (result) => {
  if (result.isError || result.details?.rejected) throw new Error("the seed was refused: " + JSON.stringify(result.details ?? result));
  return result;
};
const who = (callId) => ({ taskId, sessionId: "session-sample", runId: null, callId, actor: "user" });
`;

const SEEDS = {
  "format-8-a": `${COMMON}
const started = withTaskDatabase(dir, { createIfMissing: false }, (db) => startActivity(db, dir, who("ui-op-1"), "reading", true, ""));
if (!started.moved) throw new Error("the seed could not start the work item: " + JSON.stringify(started));
must(saveRevision(call("session-sample", "call-1"), { operations: [page("借书", "读者凭借书证在自助机上借书。", "读者凭借书证在自助机上借书。")] }));
const moved = withTaskDatabase(dir, { createIfMissing: false }, (db) => moveStage(db, dir, who("ui-op-2"), "clarifying", "用户在卡片上选了「进入澄清」"));
if (!moved.moved) throw new Error("the seed could not move to clarifying: " + JSON.stringify(moved));
const rejected = recordRejection({ workspaceDir: dir, sessionId: "session-sample", callId: "call-2", toolName: "save_revision" },
  new ToolRejection("这次「保存修订」什么都没有写入：没有名叫「功能」的集合。", "没有名叫「功能」的集合", "集合名照任务定义写"), { operations: [] });
if (rejected === null) throw new Error("the seed could not record the rejection");
`,
  "format-8-b": `${COMMON}
must(saveRevision(call("session-b", "call-1"), { operations: [page("还书", "读者在自助机上还书。", "逾期不还的，按馆里的规定罚款。")] }));
`,
};
const SAMPLES = {
  "format-8-a": { id: "TASK-SAMPLE-8A", name: "图书借阅（样本甲）" },
  "format-8-b": { id: "TASK-SAMPLE-8B", name: "图书借阅（样本乙）" },
};

function build(sample) {
  const work = mkdtempSync(path.join(tmpdir(), `taskwright-sample-${sample}-`));
  try {
    const archive = execFileSync("git", ["-C", REPO, "archive", FORMAT_8_REF, "agent", "backend", "task-types", "package.json"], { maxBuffer: 256 * 1024 * 1024 });
    execFileSync("tar", ["-x", "-C", work], { input: archive });
    writeFileSync(path.join(work, "seed.mts"), SEEDS[sample], "utf-8");
    const task = path.join(work, "sample");
    // TASKWRIGHT_TASKS_ROOT: the code checks that the database it writes lies under the service's task root.
    execFileSync(process.execPath, ["seed.mts", task, SAMPLES[sample].id, SAMPLES[sample].name],
      { cwd: work, env: { ...process.env, TASKWRIGHT_TASKS_ROOT: work }, stdio: ["ignore", "inherit", "inherit"] });
    const target = path.join(HERE, sample);
    rmSync(target, { recursive: true, force: true });
    mkdirSync(target, { recursive: true });
    for (const name of KEPT) cpSync(path.join(task, name), path.join(target, name), { recursive: true });
    // The code switched the database to WAL mode. A sample in WAL mode gets -wal and -shm files whenever a test reads it,
    // so it is kept in rollback journal mode; the program switches it back to WAL the first time it writes a copy.
    const db = new DatabaseSync(path.join(target, "task.sqlite"));
    db.exec("PRAGMA journal_mode = DELETE");
    db.close();
    console.log(`${sample}: written to ${path.relative(REPO, target)}`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

const wanted = process.argv.slice(2);
for (const sample of wanted.length ? wanted : Object.keys(SAMPLES)) {
  if (!(sample in SAMPLES)) throw new Error(`unknown sample ${sample}; one of ${Object.keys(SAMPLES).join(" ")}`);
  build(sample);
}
