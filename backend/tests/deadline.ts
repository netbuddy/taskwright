/**
 * 测试文件的总时限：测试命令用 --import 在每个测试文件的子进程里预加载本文件（node --test --import ./tests/deadline.ts …）。
 *
 * 为什么要它：Node 的测试框架让每个测试文件在子进程里运行，等子进程自己退出才算这个文件跑完。测试结束时还开着的监听服务器、
 * 连接、定时器或子进程会让子进程一直不退出，整套测试就一直挂着，连已经通过的例也不报出来。框架自带的 --test-timeout
 * 只限单个测试例，管不到「测试都跑完了、进程却不退出」；--test-force-exit 让进程退出，但文件照样算通过，没关的东西就被盖过去了。
 * 所以这里设一个不拖住进程的定时器：文件正常结束时它不起作用；到时进程还在，就写明是哪个文件、以失败退出，框架把这个文件报为失败。
 *
 * 只在测试框架起的子进程里生效（框架给子进程设了环境变量 NODE_TEST_CONTEXT），框架的主进程与别的进程里什么都不做。
 */

import { relative } from "node:path";

/**
 * 缺省时限（秒）。最慢的测试文件在开发机上约 10 秒跑完；机器很忙时慢几倍也远在 300 秒以内，而 300 秒又比「挂了十分钟才有人发现」早得多。
 * 慢机器上可以用环境变量 TASKWRIGHT_TEST_FILE_DEADLINE（秒，正数）放宽。
 */
export const DEFAULT_DEADLINE_SECONDS = 300;

export const DEADLINE_ENV = "TASKWRIGHT_TEST_FILE_DEADLINE";

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
}
