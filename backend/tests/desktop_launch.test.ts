/**
 * 产品包启动程序用的几样判断（desktop_launch.ts）：
 * - 命令行第一个参数分到 data、service、observatory 三个子命令，别的起服务；
 * - 重起命令：AppImage 重新运行 AppImage 文件，单个可执行文件重新运行它自己，参数照用户给的；从代码仓里跑时不给；
 * - 找 Python：TASKWRIGHT_PYTHON 指定的、找不到、版本低于 3.9，以及 python3 不在时退到 python、Windows 再试 py -3；
 * - 起观测台的命令行与环境：PYTHONPATH、观测台用的 node、单个可执行文件的记号、端口。
 */

import assert from "node:assert/strict";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import { NO_PYTHON_TEXT, type PythonProbe, findPython, launcherCommand, observatoryLaunch, relaunchCommand } from "../src/desktop_launch.ts";

test("子命令：data、service、observatory 分出去，别的（含没有参数、选项开头）起服务", () => {
  const of = (...rest: string[]) => launcherCommand(["/exe", "/exe", ...rest]);
  assert.deepEqual([of("data", "upgrade"), of("service", "status"), of("observatory", "--pack", "a.zip"), of(), of("--port", "9000"), of("services")],
    ["data", "service", "observatory", null, null, null]);
});

test("重起命令：AppImage 是 AppImage 文件加用户参数；单个可执行文件是它自己加用户参数；从代码仓里跑时不给", () => {
  const argv = ["/node-or-exe", "/script-or-exe", "--data", "/d", "--port", "8950"];
  assert.deepEqual(relaunchCommand(argv, { APPIMAGE: "/opt/apps/Taskwright.AppImage" }, false, "/tmp/.mount_x/usr/lib/taskwright/bin/node"),
    ["/opt/apps/Taskwright.AppImage", "--data", "/d", "--port", "8950"]);
  assert.deepEqual(relaunchCommand(argv, {}, true, "/opt/taskwright-linux-x64"), ["/opt/taskwright-linux-x64", "--data", "/d", "--port", "8950"]);
  assert.equal(relaunchCommand(argv, {}, false, "/usr/bin/node"), null);
});

/** 假的探测：表里有的命令给出版本，没有的当作找不到。 */
const probing = (versions: Record<string, string>): PythonProbe & { seen: string[] } => {
  const seen: string[] = [];
  const probe = ((command: string, prefix: string[]) => {
    const key = [command, ...prefix].join(" ");
    seen.push(key);
    return versions[key] ?? null;
  }) as PythonProbe & { seen: string[] };
  probe.seen = seen;
  return probe;
};

test("找 Python：环境变量指定的优先；python3 不在时退到 python；Windows 再试 py -3", () => {
  const given = probing({ "/opt/py/bin/python3.11": "3.11", python3: "3.12" });
  assert.deepEqual(findPython({ TASKWRIGHT_PYTHON: "/opt/py/bin/python3.11" }, "linux", given), { command: "/opt/py/bin/python3.11", prefix: [], version: "3.11" });
  assert.deepEqual(given.seen, ["/opt/py/bin/python3.11"]);
  assert.deepEqual(findPython({}, "linux", probing({ python: "3.9" })), { command: "python", prefix: [], version: "3.9" });
  const windows = probing({ "py -3": "3.13" });
  assert.deepEqual(findPython({}, "win32", windows), { command: "py", prefix: ["-3"], version: "3.13" });
  assert.deepEqual(windows.seen, ["python3", "python", "py -3"]);
});

test("找 Python：一个都没有、版本低于 3.9、环境变量指定的跑不起来，都给出那句提示", () => {
  assert.deepEqual(findPython({}, "linux", probing({})), { error: `${NO_PYTHON_TEXT}。` });
  assert.deepEqual(findPython({}, "linux", probing({ python3: "3.8" })), { error: `${NO_PYTHON_TEXT}。找到的 python3 是 3.8 版。` });
  assert.deepEqual(findPython({ TASKWRIGHT_PYTHON: "/没有/python" }, "linux", probing({ python3: "3.12" })), { error: `${NO_PYTHON_TEXT}。` });
  assert.equal(NO_PYTHON_TEXT, "观测台需要 Python 3.9 以上，请安装后重试（或设 TASKWRIGHT_PYTHON）");
});

test("起观测台：-m taskwright_observatory 接用户参数；PYTHONPATH 指向包里的 observatory/；观测台用的 node 是产品包自己；端口取 --port", () => {
  const run = observatoryLaunch({ command: "py", prefix: ["-3"] }, "/payload", ["--pack", "a.zip", "--port", "8800"], { PYTHONPATH: "/mine", KEEP: "1" }, true, "/opt/taskwright.exe");
  assert.equal(run.command, "py");
  assert.deepEqual(run.args, ["-3", "-m", "taskwright_observatory", "--pack", "a.zip", "--port", "8800"]);
  assert.equal(run.env.PYTHONPATH, `${join("/payload", "observatory")}${delimiter}/mine`);
  assert.deepEqual([run.env.TASKWRIGHT_OBSERVATORY_NODE, run.env.TASKWRIGHT_OBSERVATORY_NODE_SEA, run.env.KEEP, run.port], ["/opt/taskwright.exe", "1", "1", 8800]);
  const plain = observatoryLaunch({ command: "python3", prefix: [] }, "/payload", ["--runs", "r", "--port=9001"], {}, false, "/m/bin/node");
  assert.deepEqual([plain.env.PYTHONPATH, plain.env.TASKWRIGHT_OBSERVATORY_NODE, "TASKWRIGHT_OBSERVATORY_NODE_SEA" in plain.env, plain.port],
    [join("/payload", "observatory"), "/m/bin/node", false, 9001]);
  assert.equal(observatoryLaunch({ command: "python3", prefix: [] }, "/p", [], {}, false, "/n").port, 8770);
});
