/**
 * 测试文件的总时限：测试命令用 --import 在每个测试文件的子进程里预加载本文件（node --test --import ./tests/deadline.ts …）。
 *
 * 为什么要它：Node 的测试框架让每个测试文件在子进程里运行，等子进程自己退出才算这个文件跑完。测试结束时还开着的监听服务器、
 * 连接、定时器或子进程会让子进程一直不退出，整套测试就一直挂着，连已经通过的例也不报出来。框架自带的 --test-timeout
 * 只限单个测试例，管不到「测试都跑完了、进程却不退出」；--test-force-exit 让进程退出，但文件照样算通过，没关的东西就被盖过去了。
 * 所以这里设一个不拖住进程的定时器：文件正常结束时它不起作用；到时进程还在，就写明是哪个文件、以失败退出，框架把这个文件报为失败。
 *
 * 只在测试框架起的子进程里生效（框架给子进程设了环境变量 NODE_TEST_CONTEXT），框架的主进程与别的进程里什么都不做。
 *
 * 顺带做的另一件事：测试不得碰用户自己的 pi 配置目录。后端取 pi 配置目录时看环境变量 PI_CODING_AGENT_DIR，没设就用用户主目录下
 * 的缺省目录（见 src/launch.ts 的 piAgentDir），pi 自己也是这个规则。于是没设这个变量就跑测试时，用到的就是用户的配置目录：
 * 几个测试文件开头用 pi --version 探测本机有没有装 pi，pi 一运行就在配置目录里给配置文件建锁目录又删掉（目录的修改时间随之变化）；
 * 测试里运行的后端代码没有另给配置目录时也会读到用户的配置。所以这里在变量没设（或是空串）时，为这个测试文件的进程在系统临时目录下
 * 新建一个空目录并把变量指到它，进程退出时删掉；测试里起的子进程继承这个变量。自己另设配置目录的测试不受影响。
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

/**
 * 缺省时限（秒）。最慢的测试文件在开发机上约 10 秒跑完；机器很忙时慢几倍也远在 300 秒以内，而 300 秒又比「挂了十分钟才有人发现」早得多。
 * 慢机器上可以用环境变量 TASKWRIGHT_TEST_FILE_DEADLINE（秒，正数）放宽。
 */
export const DEFAULT_DEADLINE_SECONDS = 300;

export const DEADLINE_ENV = "TASKWRIGHT_TEST_FILE_DEADLINE";

/** pi 配置目录的环境变量（pi 自己的规则，后端也照它取）。 */
export const AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";

/** 环境变量给的秒数；没设或写的不是正数时用缺省值。 */
export function deadlineSeconds(env: NodeJS.ProcessEnv = process.env): number {
  const given = Number(env[DEADLINE_ENV]);
  return Number.isFinite(given) && given > 0 ? given : DEFAULT_DEADLINE_SECONDS;
}

if (process.env.NODE_TEST_CONTEXT) {
  const seconds = deadlineSeconds();
  const file = relative(process.cwd(), process.argv[1] ?? "") || "（不知道是哪个文件）";
  setTimeout(() => {
    process.stderr.write(`测试文件 ${file} 超过 ${seconds} 秒还没有结束，按失败处理。多半是有服务器、连接或子进程没有关，`
      + `或者有一处等待没有时限；在这个文件里查每例起的东西有没有在 finally 里关掉。\n`);
    process.exit(1);
  }, seconds * 1000).unref();
  // 这个文件是每个测试文件都预加载的唯一一个，所以顺带把产品自己的设置文件（在界面上选的模型，见 src/product_settings.ts）
  // 指到临时目录里一个不存在的文件：测试不读开发者本机的设置，测试里起的后端进程继承这个环境变量。要用设置文件的测试自己另设。
  if (!process.env.TASKWRIGHT_SETTINGS_FILE) {
    process.env.TASKWRIGHT_SETTINGS_FILE = join(tmpdir(), `taskwright-test-no-settings-${process.pid}`, "settings.json");
  }
  // pi 的配置目录同样不用开发者本机的（理由见文件开头）：没设时指到一个新建的空目录，进程退出时删掉。
  if (!process.env[AGENT_DIR_ENV]) {
    const agentDir = mkdtempSync(join(tmpdir(), "taskwright-test-pi-agent-"));
    process.env[AGENT_DIR_ENV] = agentDir;
    process.on("exit", () => rmSync(agentDir, { recursive: true, force: true }));
  }
}
