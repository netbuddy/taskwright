/**
 * 命令行的数据命令：taskwright data upgrade [--data <数据目录>]（后端外壳是 node backend/src/main.mts data upgrade …）。
 * 不起服务：看一遍数据目录，备份，把上一版留下的数据升到这个程序的格式，把报告打印出来。服务器形态启动时发现有数据要升级会
 * 拒绝启动并让管理员先运行它；桌面形态在页面上升级，也可以用它。做的事与页面上的升级是同一段代码（data_upgrade.ts）。
 *
 * 退出码：0 都做成了（或者本来就没有要升级的）；1 有任务没有做成，或者整体没有做成；2 没有做——参数不对、
 * 有服务正在用这个数据目录、或者数据比这个程序新。
 */

import { parseArgs } from "node:util";
import { newerDataText } from "../../agent/src/lib/schema.ts";
import { locate, occupiedTasks, planUpgrade, reportText, runUpgrade } from "./data_upgrade.ts";
import * as occupancy from "./occupancy.ts";

const USAGE = "用法：taskwright data upgrade [--data <数据目录>] [--tasks <任务目录的上级目录>] [--knowledge <知识库目录>]";

/** argv 是 data 之后的参数。out 与 err 各收一行文字（缺省写标准输出与标准错误）。返回退出码。 */
export async function dataCommand(argv: string[], out: (line: string) => void = (line) => process.stdout.write(line + "\n"),
  err: (line: string) => void = (line) => process.stderr.write(line + "\n")): Promise<number> {
  if (argv[0] !== "upgrade") {
    err(argv[0] ? `没有「data ${argv[0]}」这个命令。${USAGE}` : `data 后面要写做什么。${USAGE}`);
    return 2;
  }
  let values: { data?: string; tasks?: string; knowledge?: string };
  try {
    ({ values } = parseArgs({ args: argv.slice(1), options: { data: { type: "string" }, tasks: { type: "string" }, knowledge: { type: "string" } }, strict: true }));
  } catch (error) {
    err(`参数不对：${(error as Error).message}。${USAGE}`);
    return 2;
  }
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
