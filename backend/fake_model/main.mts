/**
 * 手工起一个假端点：
 *
 *   node backend/fake_model/main.mts --script 脚本.json --log 请求记录.jsonl [--port 0] [--agent-dir 目录]
 *
 * --port 不写或写 0 时由操作系统挑空闲端口，启动后把端口打印出来。给了 --agent-dir 就顺手在那里写好
 * 只认这个假端点的 pi 配置目录，之后用 PI_CODING_AGENT_DIR=<那个目录> 启动 pi 即可。按 Ctrl+C 停。
 * 参数与打印的两行字与 Python 版（python -m taskwright_server.fake_model）相同。
 */

import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { MODEL_ARG, writeAgentDir } from "./agent_config.ts";
import { FakeModel } from "./server.ts";

const { values } = parseArgs({
  options: { script: { type: "string" }, log: { type: "string" }, port: { type: "string", default: "0" }, "agent-dir": { type: "string" } },
  strict: true,
});
if (!values.log) {
  process.stderr.write("缺少参数：--log（请求记录写到哪个 jsonl 文件）。\n");
  process.exit(2);
}
const port = Number(values.port);
if (!Number.isInteger(port)) {
  process.stderr.write(`--port 要写一个整数，现在是「${values.port}」。\n`);
  process.exit(2);
}
const script = values.script ? JSON.parse(readFileSync(values.script, "utf-8")) : [];
const fake = await new FakeModel(script, values.log).start(port);
console.log(`假端点已启动：${fake.baseUrl}（只监听本机回环地址）`);
if (values["agent-dir"]) {
  writeAgentDir(values["agent-dir"], fake.baseUrl);
  console.log(`pi 配置目录已写好：${values["agent-dir"]}；启动 pi 时设 PI_CODING_AGENT_DIR 为它，--model 写 ${MODEL_ARG}`);
}
const stop = () => void fake.stop().then(() => process.exit(0));
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
