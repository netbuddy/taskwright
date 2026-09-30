/**
 * 收发数据这一层的子进程实现：把助手的程序作为子进程启动，经它的标准输入写命令，从标准输出与标准错误按行读。
 * 现在只有这一种实现（接口见 transport.ts）。后端里与子进程和管道有关的代码只许写在这个文件里，由测试守着。
 */

import { type ChildProcess, spawn } from "node:child_process";
import { constants } from "node:os";
import { createInterface } from "node:readline";
import type { PiTransport, TransportHandlers, TransportSpec } from "./transport.ts";

const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));

export class RpcTransport implements PiTransport {
  private child: ChildProcess | null = null;
  private stderrDone: Promise<void> = Promise.resolve();
  private exitedPromise: Promise<void> = Promise.resolve();

  /**
   * 启动失败有两种报法：命令行太长（E2BIG）、内存不足这类错误由 spawn 当场抛出，没有执行权限、找不到文件这类错误随后经
   * error 事件报出。两种都原样拒绝，由调用方按错误代号处理。
   */
  async start(spec: TransportSpec): Promise<void> {
    const child = spawn(spec.command, spec.args, { cwd: spec.cwd, env: spec.env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    this.child = child;
    const spawned = await new Promise<Error | null>((ok) => {
      child.once("spawn", () => ok(null));
      child.once("error", (error) => ok(error));
    });
    if (spawned) {
      this.child = null;
      throw spawned;
    }
    this.exitedPromise = new Promise((ok) => child.once("exit", () => ok()));
    // 往已经关掉的管道里写时 Node 会异步报 EPIPE；不接住会把整个服务带倒。写不进去由调用方按进程已退出处理。
    child.stdin?.on("error", () => {});
  }

  subscribe(handlers: TransportHandlers): void {
    const child = this.child!;
    const stdout = createInterface({ input: child.stdout!, crlfDelay: Infinity });
    stdout.on("line", (line) => handlers.line(line));
    stdout.on("close", async () => {
      // 标准输出到头了，说明进程没了。先等标准错误读完、进程退干净，退出码与错误输出才齐。
      await Promise.race([this.stderrDone, sleep(2000)]);
      await Promise.race([this.exitedPromise, sleep(5000)]);
      handlers.ended();
    });
    const stderr = createInterface({ input: child.stderr!, crlfDelay: Infinity });
    this.stderrDone = new Promise((ok) => {
      stderr.on("line", (line) => handlers.stderrLine(line));
      stderr.on("close", () => ok());
    });
  }

  writable(): boolean {
    const stdin = this.child?.stdin;
    return !!stdin && !stdin.destroyed && !stdin.writableEnded;
  }

  write(line: string): void {
    this.child!.stdin!.write(line + "\n");
  }

  running(): boolean {
    const child = this.child;
    return child !== null && child.exitCode === null && child.signalCode === null;
  }

  exitCode(): number | null {
    const child = this.child;
    if (child === null) return null;
    if (child.exitCode !== null) return child.exitCode;
    if (child.signalCode) return -((constants.signals as Record<string, number>)[child.signalCode] ?? 0);
    return null;
  }

  async stop(graceMs: number): Promise<void> {
    const child = this.child;
    if (child === null) return;
    try {
      child.stdin?.end();
    } catch {
      // 已经关了
    }
    if (!(await this.waitExit(graceMs))) {
      child.kill("SIGKILL");
      await this.waitExit(graceMs);
    }
    await Promise.race([this.stderrDone, sleep(2000)]);
  }

  private async waitExit(ms: number): Promise<boolean> {
    const child = this.child;
    if (child === null || child.exitCode !== null || child.signalCode !== null) return true;
    return Promise.race([this.exitedPromise.then(() => true), sleep(ms).then(() => false)]);
  }
}
