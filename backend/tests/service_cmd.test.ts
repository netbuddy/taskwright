/**
 * 服务的进程文件（service_process.ts）与 service 命令（service_command.ts），起真的后端进程核对：
 * - 监听之后写出 <数据目录>/run/service.json，字段齐全，环境变量只记 TASKWRIGHT_ 开头的与 PI_CODING_AGENT_DIR；
 * - 同一个数据目录再起一个服务被拒，并指明在运行的那一个；
 * - service status 在运行时退出码 0；stop 发 SIGTERM，进程退出、文件删掉，之后 status 是 2（没有文件）；
 * - 进程文件记的进程已经不在：status 是 1（残留）；再起服务时清掉残留、照常起来；
 * - restart：停掉再照文件起，新的进程号不同、接口答话，输出写着用了哪几个记下的环境变量名（不写值）。
 */

import assert from "node:assert/strict";
import { type ChildProcess, spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { processFilePath, readProcessFile, writeProcessFile } from "../src/service_process.ts";
import { BACKEND_MAIN, ROOT, spawnBackend, tempDir } from "./helpers.ts";

const tmp = tempDir();
after(() => rmSync(tmp, { recursive: true, force: true }));
let n = 0;
const fresh = (name: string) => join(tmp, `${name}-${++n}`);

/** 起一个服务：数据目录 data，日志目录 logs（经环境变量另给），假模型。 */
function serve(data: string, logs: string, extra: Record<string, string> = {}) {
  return spawnBackend(["--data", data, "--profile", "fake", "--host", "127.0.0.1"], {
    cwd: ROOT, env: { ...process.env, TASKWRIGHT_LOG_DIR: logs, PI_CODING_AGENT_DIR: join(data, "pi-agent"), ...extra },
  });
}

/** 跑一次 service 命令（不起服务，同步等它结束）。 */
function service(verb: string, data: string, env: Record<string, string> = {}) {
  const done = spawnSync(process.execPath, [BACKEND_MAIN, "service", verb, "--data", data], { cwd: ROOT, encoding: "utf-8", timeout: 60_000, env: { ...process.env, ...env } });
  return { status: done.status, out: done.stdout, err: done.stderr };
}

const exited = (child: ChildProcess) => (child.exitCode !== null || child.signalCode !== null
  ? Promise.resolve(child.exitCode) : new Promise<number | null>((ok) => child.once("exit", (code) => ok(code))));

test("进程文件：监听之后写出，字段齐全，环境变量只记两类；同一个数据目录再起一个被拒；status 是 0，stop 之后进程退出、文件删掉，status 是 2", async () => {
  const data = fresh("data");
  const logs = join(data, "logs");
  const { child, port } = await serve(data, logs, { SOME_OTHER_VAR: "不该记下" });
  try {
    const file = readProcessFile(data)!;
    assert.deepEqual([file.pid, file.port, file.host, file.mode], [child.pid, port, "127.0.0.1", "server"]);
    assert.equal(file.node, process.execPath);
    assert.ok(file.argv[1].endsWith("main.mts") && file.argv.includes("--data") && file.argv.includes(data), JSON.stringify(file.argv));
    assert.ok(Array.isArray(file.cmdline) && file.cmdline.includes("--data"), JSON.stringify(file.cmdline));
    assert.equal(file.cwd, ROOT);
    assert.deepEqual(Object.keys(file.env).filter((name) => !name.startsWith("TASKWRIGHT_") && name !== "PI_CODING_AGENT_DIR"), []);
    assert.equal(file.env.TASKWRIGHT_LOG_DIR, logs);
    assert.equal(file.env.PI_CODING_AGENT_DIR, join(data, "pi-agent"));
    assert.ok(/^\d{4}-\d\d-\d\dT/.test(file.started_at) && typeof file.product_version === "string");

    // 同一个数据目录再起一个：被拒，指明在运行的那一个。
    await assert.rejects(serve(data, logs), (error: Error) => error.message.includes(`服务已在运行（pid ${child.pid}，端口 ${port}），要重启请用 service restart`));
    assert.equal(readProcessFile(data)!.pid, child.pid, "被拒的那个没有动进程文件");

    const status = service("status", data);
    assert.equal(status.status, 0, status.err);
    assert.match(status.out, new RegExp(`进程号 ${child.pid}，端口 ${port}（127\\.0\\.0\\.1），运行形态 server\\n启动于 .*，版本 .*\\n在运行。`));

    const stop = service("stop", data);
    assert.equal(stop.status, 0, stop.err);
    assert.match(stop.out, new RegExp(`向进程号 ${child.pid} 发送 SIGTERM。\\n已停止（进程号 ${child.pid}）。`));
    assert.equal(await exited(child), 0);
    assert.equal(existsSync(processFilePath(data)), false);
    const none = service("status", data);
    assert.equal(none.status, 2);
    assert.match(none.err, /没有进程文件/);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  }
});

test("残留的进程文件：记的进程已经不在，status 是 1、stop 不发信号；再起服务时清掉残留、照常起来", async () => {
  const data = fresh("data");
  const logs = join(data, "logs");
  // 一个已经退出的进程的进程号。
  const gone = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf-8" });
  const deadPid = Number(gone.stdout);
  writeProcessFile(data, { pid: deadPid, port: 1, host: "127.0.0.1", mode: "server", started_at: "2026-10-22T00:00:00", product_version: "0", argv: [], cmdline: null, cwd: ROOT, env: {}, node: process.execPath });
  const status = service("status", data);
  assert.equal(status.status, 1);
  assert.match(status.out, new RegExp(`残留：进程号 ${deadPid} 已经不在了。`));
  const stop = service("stop", data);
  assert.equal(stop.status, 1);
  assert.match(stop.err, /没有停止：进程号 \d+ 已经不在了，进程文件是残留。/);
  const { child, output } = await serve(data, logs);
  try {
    assert.match(output(), new RegExp(`清掉了残留的进程文件（记的是 pid ${deadPid}，端口 1，那个进程已经不在了）。`));
    assert.equal(readProcessFile(data)!.pid, child.pid);
  } finally {
    child.kill("SIGTERM");
    assert.equal(await exited(child), 0);
  }
  assert.equal(existsSync(processFilePath(data)), false, "收到 SIGTERM 退出时删掉了自己的进程文件");
});

test("restart：停掉再照进程文件起，新的进程号不同、接口答话；输出写着用了哪几个记下的环境变量名，不写值；新进程的输出接到 service-<时刻>.out", async () => {
  const data = fresh("data");
  const logs = join(data, "logs");
  const { child } = await serve(data, logs, { TASKWRIGHT_EXTRA_FLAG: "secret-value" });
  let fresh_pid: number | null = null;
  try {
    // 执行 restart 的环境里另有一个不同值的同名变量：新进程用的是进程文件里记的。
    const done = service("restart", data, { TASKWRIGHT_EXTRA_FLAG: "from-shell" });
    assert.equal(done.status, 0, done.err + done.out);
    assert.equal(await exited(child), 0);
    const now = readProcessFile(data)!;
    fresh_pid = now.pid;
    assert.notEqual(now.pid, child.pid);
    assert.match(done.out, new RegExp(`已重启：新的进程号 ${now.pid}，端口 ${now.port}。`));
    const names = Object.keys(now.env).sort();
    assert.ok(["PI_CODING_AGENT_DIR", "TASKWRIGHT_EXTRA_FLAG", "TASKWRIGHT_LOG_DIR"].every((name) => names.includes(name)), names.join(","));
    assert.ok(done.out.includes(`用了进程文件里记的环境变量：${names.join("、")}。`), done.out);
    assert.equal(done.out.includes("secret-value"), false, "不打印变量的值");
    assert.equal(now.env.TASKWRIGHT_EXTRA_FLAG, "secret-value");
    const res = await fetch(`http://127.0.0.1:${now.port}/api/v1/service`);
    assert.equal(res.status, 200);
    assert.ok(readdirSync(logs).some((name) => /^service-\d{8}-\d{6}\.out$/.test(name)), readdirSync(logs).join(","));
    // 再用 stop 收尾。
    const stop = service("stop", data);
    assert.equal(stop.status, 0, stop.err);
    assert.equal(existsSync(processFilePath(data)), false);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    if (fresh_pid !== null) {
      try {
        process.kill(fresh_pid, "SIGTERM");
      } catch {
        // 已经停了
      }
    }
  }
});

test("service 命令的用法：不认识的动词与缺动词退出码 2", () => {
  const unknown = spawnSync(process.execPath, [BACKEND_MAIN, "service", "reload"], { encoding: "utf-8" });
  assert.deepEqual([unknown.status, /没有「service reload」这个命令/.test(unknown.stderr)], [2, true]);
  const missing = spawnSync(process.execPath, [BACKEND_MAIN, "service"], { encoding: "utf-8" });
  assert.deepEqual([missing.status, /service 后面要写做什么/.test(missing.stderr)], [2, true]);
  assert.equal(readFileSync(BACKEND_MAIN, "utf-8").includes("serviceCommand"), true);
});
