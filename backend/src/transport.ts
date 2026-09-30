/**
 * PiSession 与助手的程序之间按行收发文字的一层。PiSession 只经这个接口启动程序、写一行、读一行、停下；
 * 命令与应答的对应、事件队列、归档与补记都在 PiSession 里，不在这一层。现在只有一种实现：子进程（transport_rpc.ts）。
 */

/** 助手程序的启动参数：可执行文件、参数、工作目录与环境变量（由 launch.buildCommand 给出）。 */
export interface TransportSpec {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
}

/** 读到的东西交给谁。只在 subscribe 之后才开始读。 */
export interface TransportHandlers {
  /** 助手输出的每一行：只按换行符断开，去掉行尾的换行与回车，其余原样。 */
  line(text: string): void;
  /** 助手错误输出的每一行，断法相同。 */
  stderrLine(text: string): void;
  /** 输出读到头了：此前已经等过错误输出读完（最多 2 秒）与程序退出（最多 5 秒）。 */
  ended(): void;
}

export interface PiTransport {
  /** 启动。起不来时拒绝，带上系统给的错误（有 code，例如 ENOENT、EACCES、E2BIG），由 PiSession 转成它的错误类。 */
  start(spec: TransportSpec): Promise<void>;
  /** 开始读，读到的交给 handlers。 */
  subscribe(handlers: TransportHandlers): void;
  /** 还能不能往里写。 */
  writable(): boolean;
  /** 写一行（不带换行符，由实现补上）。 */
  write(line: string): void;
  /** 程序还在：没有退出，也没有被信号杀掉。 */
  running(): boolean;
  /** 退出码：被信号杀掉时写成负的信号编号（与 Python 的 returncode 相同）；还没退出时为 null。 */
  exitCode(): number | null;
  /** 停下：先关输入让它自己退，graceMs 内不退就强行结束，再等 graceMs；最后等错误输出读完，最多 2 秒。 */
  stop(graceMs: number): Promise<void>;
}
