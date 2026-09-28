/**
 * 打印在一个任务目录里起 pi 自带终端界面（交互模式）的命令行，给 scripts/tui.sh 用。
 *
 * 用法：
 *   node backend/src/print_command.mts --task <任务目录> [--profile dev] [--label tui] [--continue | --session <会话文件>] [--env-tag <标签>] [--shell]
 *
 * 命令行由 launch.ts 的 buildCommand 拼（与任务服务起 pi 用的是同一份启动配置、同一个函数，只是不写 --mode rpc），
 * 所以终端界面里执行者手上的扩展、工具、系统提示、skill 与模型，与网页里用的相同。
 * 会话文件放在 $TASKWRIGHT_RUNS_DIR/pi-sessions/<名字>/（没设时是当前目录下的 runs/）。
 *
 * 不给 --shell 时打印给人看的几行：任务、会话目录、命令行（系统提示全文换成它来自哪个文件）、另加的环境变量名。
 * 给 --shell 时打印一段 shell 语句，由 scripts/tui.sh 用 eval 执行：设好另加的环境变量（Langfuse 的密钥也在其中，
 * 只经这段语句进入 pi 的环境，不上命令行参数），把 pi 的命令行放进位置参数，并给出任务目录与会话目录。
 */

import { readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { DB_NAME } from "../../agent/src/lib/db.ts";
import { ENV_TRACING_ENVIRONMENT, LaunchError, buildCommand, expandUser, loadProfile } from "./launch.ts";
import { openRo } from "./library.ts";

function fail(text: string): never {
  process.stderr.write(`启动不了：${text}\n`);
  process.exit(2);
}

/** 单引号括起来的 shell 字面量。 */
function quote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

const { values } = parseArgs({
  options: {
    task: { type: "string" },
    profile: { type: "string", default: "dev" },
    label: { type: "string", default: "tui" },
    continue: { type: "boolean", default: false },
    session: { type: "string" },
    "env-tag": { type: "string" },
    shell: { type: "boolean", default: false },
  },
  strict: true,
});
if (!values.task) fail("要用 --task 给出任务目录。");
if (values.continue && values.session) fail("--continue 与 --session 只能给一个。");

const workspace = resolve(expandUser(values.task));
let statOk = false;
try {
  statOk = statSync(workspace).isDirectory();
} catch {
  statOk = false;
}
if (!statOk) fail(`任务目录 ${workspace} 不存在。先在网页里（或经接口 POST /api/v1/tasks）建任务，再用它的任务目录。`);
const db = isFile(join(workspace, DB_NAME)) ? openRo(workspace) : null;
let task: Record<string, any> | undefined;
try {
  task = db ? (db.prepare("SELECT task_id, task_name, status FROM task ORDER BY started_at LIMIT 1").get() as Record<string, any> | undefined) : undefined;
} catch {
  task = undefined;
} finally {
  db?.close();
}
if (!task) fail(`${workspace} 里还没有任务记录（没有 ${DB_NAME} 或库里没有任务）。先在网页里（或经接口）建任务。`);

const runs = resolve(expandUser((process.env.TASKWRIGHT_RUNS_DIR ?? "").trim() || "runs"));
const sessionDir = join(runs, "pi-sessions", values.label!);
let sessionFile: string | null = null;
if (values.session) {
  sessionFile = resolve(expandUser(values.session));
  if (!isFile(sessionFile)) fail(`会话文件 ${sessionFile} 不存在。`);
} else if (values.continue) {
  let files: string[] = [];
  try {
    files = readdirSync(sessionDir).filter((f) => f.endsWith(".jsonl")).map((f) => join(sessionDir, f));
  } catch {
    files = [];
  }
  files.sort((a, b) => statSync(a).mtimeMs - statSync(b).mtimeMs);
  if (!files.length) fail(`${sessionDir} 里还没有会话文件可以续接，去掉 --continue 开一条新会话。`);
  sessionFile = files[files.length - 1];
}

let built;
let profile;
try {
  profile = loadProfile(values.profile!);
  built = buildCommand(profile, workspace, sessionDir, sessionFile, true);
} catch (error) {
  if (error instanceof LaunchError) fail(error.technical ?? error.message);   // 终端工具给开发者用，打印排查用的原话
  throw error;
}
if (values["env-tag"]) built.env[ENV_TRACING_ENVIRONMENT] = values["env-tag"];
const added = Object.entries(built.env).filter(([name, value]) => process.env[name] !== value);
const environmentTag = built.env[ENV_TRACING_ENVIRONMENT] ?? "";
const taskLine = `任务 ${task.task_id}「${task.task_name ?? ""}」，状态是${task.status}；任务目录 ${workspace}`;
const sessionLine = `会话文件放在 ${sessionDir}` + (sessionFile ? `，续接 ${sessionFile}` : "，这次开一条新会话");
const tagLine = `Langfuse 的环境标签：${environmentTag || "（没有设）"}`;

if (values.shell) {
  const lines = [
    ...added.map(([name, value]) => `export ${name}=${quote(value)}`),
    `TW_WORKSPACE=${quote(workspace)}`,
    `TW_SESSION_DIR=${quote(sessionDir)}`,
    `TW_INFO=${quote([taskLine, sessionLine, tagLine].join("\n"))}`,
    `set -- ${[built.command, ...built.args].map(quote).join(" ")}`,
  ];
  process.stdout.write(lines.join("\n") + "\n");
} else {
  const shown = [...built.argv];
  const at = shown.indexOf("--system-prompt");
  if (at >= 0) shown[at + 1] = `（系统提示全文，取自 ${profile!.system_prompt_file}）`;
  process.stdout.write([taskLine, sessionLine, tagLine, `命令行：${JSON.stringify(shown)}`,
    `另加的环境变量：${added.map(([name]) => name).join("、") || "（没有）"}`].join("\n") + "\n");
}
