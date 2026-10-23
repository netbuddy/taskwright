/**
 * 命令行的数据命令（后端外壳是 node backend/src/main.mts data …，桌面包是 taskwright data …）。都不起服务。
 *
 *   taskwright data upgrade [--data <数据目录>]
 *       看一遍数据目录，备份，把上一版留下的数据升到这个程序的格式，把报告打印出来。服务器形态启动时发现有数据要升级会拒绝启动并让
 *       管理员先运行它；桌面形态在页面上升级，也可以用它。做的事与页面上的升级是同一段代码（data_upgrade.ts）。
 *   taskwright data upgrade --pack <数据包> --to <新的数据包>
 *       把一个旧版本导出的数据包升到这个程序的格式，写成一个新的包；原来的包不动，不需要数据目录。
 *   taskwright data export [--data <数据目录>] [--task <任务编号> | --library <知识库编号>] [--with-events] [--with-materials] [--diagnostic] --to <数据包>
 *       事件归档（runs/<任务编号>/pi-events）缺省不带，只带对话记录；加 --with-events 才带。材料与知识库文档的原件和派生文件缺省不带，
 *       只带材料清单与文档清单；加 --with-materials 才带。命令行没有启动配置，清单里的分段参数写默认值。
 *       加 --diagnostic 导出成诊断包（只能与 --task 一起写）：固定带事件归档、不带材料原件，另带任务建立以来的后端日志与设置摘录（data_pack.ts）。
 *       导出一个数据包：不写 --task 与 --library 是整套（全部任务与知识库）。导出不改原数据，服务开着也可以导；
 *       还没有升级的数据目录也可以导（升级之前先留一份）。目标文件已经在时不覆盖。
 *   taskwright data import [--data <数据目录>] --from <数据包> [--renumber]
 *       把一个数据包导入到数据目录。有服务正在用这个数据目录、或者它自己有上一版的数据还没有升级时不做。包里任务的编号已经有任务
 *       在用时跳过；加 --renumber 就改成新编号导入（只对任务起作用，知识库不改编号）。
 * 导出、导入与数据包升级的代码在 data_pack.ts。
 *
 * 退出码：0 都做成了（或者本来就没有要做的；导入时因为已经存在而跳过的不算没有做成）；1 有任务或知识库没有做成，或者整体没有做成；
 * 2 没有做——参数不对、有服务正在用这个数据目录、数据或数据包比这个程序新、数据包不对、目标文件已经在。
 */

import { parseArgs } from "node:util";
import { newerDataText } from "../../agent/src/lib/schema.ts";
import { PackError, exportPack, exportText, importPack, importText, upgradePack, upgradePackText } from "./data_pack.ts";
import { locate, occupiedTasks, planUpgrade, reportText, runUpgrade, upgradeCommandLine, upgradeNeeded } from "./data_upgrade.ts";
import * as occupancy from "./occupancy.ts";
import { piAgentDir } from "./launch.ts";
import { appVersion, logDir } from "./paths.ts";
import { settingsExcerpt } from "./product_settings.ts";
import { ServiceDb, type TaskEntry } from "./service_db.ts";

const USAGE = [
  "用法：taskwright data upgrade [--data <数据目录>] [--tasks <任务目录的上级目录>] [--knowledge <知识库目录>]",
  "　　　taskwright data upgrade --pack <数据包> --to <新的数据包>",
  "　　　taskwright data export [--data <数据目录>] [--task <任务编号> | --library <知识库编号>] [--with-events] [--with-materials] [--diagnostic] --to <数据包>",
  "　　　taskwright data import [--data <数据目录>] --from <数据包> [--renumber]",
].join("\n");

type Print = (line: string) => void;
/** 几个目录的参数：四个命令都认（--runs 只有导出与导入用得着）。 */
const DIRS = { data: { type: "string" }, tasks: { type: "string" }, runs: { type: "string" }, knowledge: { type: "string" } } as const;

/** 解析一个子命令的参数；有不认识的参数或者多出来的词时报错并返回 null。 */
function parse<T extends Record<string, { type: "string" | "boolean" }>>(args: string[], options: T, err: Print): Record<string, any> | null {
  try {
    return parseArgs({ args, options, strict: true }).values;
  } catch (error) {
    err(`参数不对：${(error as Error).message}。\n${USAGE}`);
    return null;
  }
}

/** argv 是 data 之后的参数。out 与 err 各收一行文字（缺省写标准输出与标准错误）。返回退出码。 */
export async function dataCommand(argv: string[], out: Print = (line) => process.stdout.write(line + "\n"),
  err: Print = (line) => process.stderr.write(line + "\n")): Promise<number> {
  const [verb, ...rest] = argv;
  if (verb === "upgrade") return upgradeCommand(rest, out, err);
  if (verb === "export") return exportCommand(rest, out, err);
  if (verb === "import") return importCommand(rest, out, err);
  err(verb ? `没有「data ${verb}」这个命令。\n${USAGE}` : `data 后面要写做什么。\n${USAGE}`);
  return 2;
}

async function upgradeCommand(args: string[], out: Print, err: Print): Promise<number> {
  const values = parse(args, { data: { type: "string" }, tasks: { type: "string" }, knowledge: { type: "string" }, pack: { type: "string" }, to: { type: "string" } }, err);
  if (values === null) return 2;
  if (values.pack || values.to) return upgradePackCommand(values, out, err);
  const where = locate(values);
  // 有服务正在用这个数据目录时不做：任务根目录下有一个任务被活着的服务占着就算。
  const busy = occupiedTasks(where.tasksDir);
  if (busy.length > 0) {
    err(`有服务正在使用数据目录 ${where.dataDir}，所以没有升级。请先停下它：`);
    for (const one of busy) err(`  任务 ${one.dir}：${occupancy.occupiedText(one.lock)}`);
    return 2;
  }
  const plan = planUpgrade(where);
  if (plan.service.state === "newer") {
    err(`数据目录 ${where.dataDir} 没有升级：${newerDataText(plan.service.written_by)}`);
    return 2;
  }
  for (const task of plan.newer) err(`任务 ${task.task_id ?? task.dir} 没有动：${newerDataText(task.written_by)}`);
  // 命令行每次都把记着升级失败的任务再试一遍。
  const { report, registry } = await runUpgrade(plan, { retryFailed: true });
  registry?.close();
  out(reportText(report).trimEnd());
  if (report.file) out(`这份报告也写在 ${report.file}`);
  return report.fatal || report.failed > 0 ? 1 : 0;
}

/** 数据包那几个函数抛的「做不了」：写明原因，退出码 2。别的错照原样抛出去。 */
function refused(error: unknown, what: string, err: Print): number {
  if (!(error instanceof PackError)) throw error;
  err(`${what}：${error.message}`);
  return 2;
}

async function upgradePackCommand(values: Record<string, any>, out: Print, err: Print): Promise<number> {
  if (!values.pack || !values.to) {
    err(`升级数据包要同时写 --pack 与 --to。\n${USAGE}`);
    return 2;
  }
  if (values.data || values.tasks || values.knowledge) {
    err(`升级数据包不需要数据目录：--pack 不与 --data、--tasks、--knowledge 一起写。\n${USAGE}`);
    return 2;
  }
  try {
    const result = await upgradePack(values.pack, values.to);
    out(upgradePackText(result).trimEnd());
    return result.tasks.some((task) => !task.ok) ? 1 : 0;
  } catch (error) {
    return refused(error, "数据包没有升级", err);
  }
}

async function exportCommand(args: string[], out: Print, err: Print): Promise<number> {
  const values = parse(args, { ...DIRS, task: { type: "string" }, library: { type: "string" }, to: { type: "string" }, "with-events": { type: "boolean" }, "with-materials": { type: "boolean" }, diagnostic: { type: "boolean" } }, err);
  if (values === null) return 2;
  if (!values.to) {
    err(`导出要写 --to <数据包>。\n${USAGE}`);
    return 2;
  }
  if (values.task && values.library) {
    err(`--task 与 --library 只能写一个；都不写是导出整套。\n${USAGE}`);
    return 2;
  }
  if (values.diagnostic && !values.task) {
    err(`--diagnostic 要与 --task 一起写：诊断包只能按一个任务导出。\n${USAGE}`);
    return 2;
  }
  const where = locate(values);
  try {
    const diagnostic = values.diagnostic
      ? { settings: settingsExcerpt(piAgentDir(process.env), process.env, where.dataDir), logsDir: logDir(where.dataDir) } : undefined;
    const result = await exportPack(where, { scope: values.task ? "task" : values.library ? "library" : "all", taskId: values.task, libraryId: values.library, to: values.to,
      withEvents: values["with-events"] === true, withMaterials: values["with-materials"] === true, diagnostic });
    out(exportText(result).trimEnd());
    // 有东西没有带进包（读不出编号的任务目录等）算没有都做成。
    return result.skipped.length > 0 ? 1 : 0;
  } catch (error) {
    return refused(error, "没有导出", err);
  }
}

async function importCommand(args: string[], out: Print, err: Print): Promise<number> {
  const values = parse(args, { ...DIRS, from: { type: "string" }, renumber: { type: "boolean" } }, err);
  if (values === null) return 2;
  if (!values.from) {
    err(`导入要写 --from <数据包>。\n${USAGE}`);
    return 2;
  }
  const where = locate(values);
  const busy = occupiedTasks(where.tasksDir);
  if (busy.length > 0) {
    err(`有服务正在使用数据目录 ${where.dataDir}，所以没有导入。请先停下它，或者在页面上导入：`);
    for (const one of busy) err(`  任务 ${one.dir}：${occupancy.occupiedText(one.lock)}`);
    return 2;
  }
  const plan = planUpgrade(where);
  if (plan.service.state === "newer") {
    err(`数据目录 ${where.dataDir} 没有导入：${newerDataText(plan.service.written_by)}`);
    return 2;
  }
  if (upgradeNeeded(plan)) {
    err(`数据目录 ${where.dataDir} 里有上一版留下的数据要先升级。请先运行 ${upgradeCommandLine(where)}，做完再导入。`);
    return 2;
  }
  // 登记表到真要记第一个任务时才打开（没有就建）：整个包被拒绝时不在数据目录里留下任何东西。
  let registry: ServiceDb | null = null;
  const lazy = { putTask: (entry: TaskEntry) => (registry ??= ServiceDb.open(where.dataDir, appVersion())).putTask(entry) };
  try {
    const report = await importPack(where, { file: values.from, onConflict: values.renumber ? "renumber" : "skip", registry: lazy });
    out(importText(report).trimEnd());
    if (report.file) out(`这份报告也写在 ${report.file}`);
    if (report.fatal) return 2;
    return [...report.tasks, ...report.libraries].some((one) => one.outcome === "failed") ? 1 : 0;
  } finally {
    registry?.close();
  }
}
