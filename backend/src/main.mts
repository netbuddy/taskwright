/**
 * 启动任务服务。
 *
 * 用法：
 *   node backend/src/main.mts --tasks <任务目录的上级目录> --runs <归档目录> --port <端口> [--host 0.0.0.0] [--profile dev]
 *
 * 服务缺省绑 0.0.0.0。收到 SIGTERM 或 SIGINT 时停止接新连接、删掉本服务写的占用标记，然后退出。
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { makeServer } from "./http.ts";
import { PROFILE_DIR } from "./paths.ts";
import { Service } from "./service.ts";

function expandUser(path: string): string {
  return path === "~" || path.startsWith("~/") ? join(homedir(), path.slice(1)) : path;
}

/** 读一份启动配置：profiles 目录下的 JSON 文件，name 不带扩展名。 */
export function loadProfile(name: string): unknown {
  const path = join(PROFILE_DIR, `${name}.json`);
  if (!existsSync(path)) {
    const available = readdirSync(PROFILE_DIR).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)).sort().join("、") || "（一个都没有）";
    throw new Error(`找不到启动配置「${name}」。可用的配置有：${available}。`);
  }
  return JSON.parse(readFileSync(path, "utf-8"));
}

const { values } = parseArgs({
  options: {
    tasks: { type: "string" },
    runs: { type: "string" },
    port: { type: "string" },
    host: { type: "string", default: "0.0.0.0" },
    profile: { type: "string", default: "dev" },
  },
  strict: true,
});
const missing = ["tasks", "runs", "port"].filter((k) => !values[k as keyof typeof values]);
if (missing.length) {
  process.stderr.write(`缺少参数：${missing.map((k) => `--${k}`).join("、")}。\n`);
  process.exit(2);
}
const port = Number(values.port);
if (!Number.isInteger(port)) {
  process.stderr.write(`--port 要写一个整数，现在是「${values.port}」。\n`);
  process.exit(2);
}

const service = new Service(expandUser(values.tasks!), expandUser(values.runs!), loadProfile(values.profile!), { port });
const server = makeServer(service);
server.listen(port, values.host, () => {
  console.log(`任务服务在 http://${values.host}:${port}/api/v1/tasks ，任务目录 ${values.tasks}，归档 ${values.runs}`);
});

let closing = false;
function stop(): void {
  if (closing) return;
  closing = true;
  server.close();
  server.closeAllConnections();
  service.close();
  process.exit(0);
}
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
