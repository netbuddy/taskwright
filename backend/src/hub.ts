/**
 * 事件分发：每个任务一个。管 SSE 订阅者、库事件的转发、兜底轮询与 Last-Event-ID 补发。
 *
 * 库事件的正本是库里的事件表。后端记着「已经转发到第几号」，有七处会让它去查库（trigger）：写入类工具成功结束
 * （tool_execution_end）；直接操作的结果经状态栏 taskwright-user-result 回报成功；直接操作的请求成功返回之后；点卡片时扩展命令
 * 替用户记了一次阶段移动；界面发起的评审每记一条（状态栏 taskwright-review）；一次工作结束；pi 在跑期间每 2 秒一次的兜底轮询
 * （库里的最大序号比已转发的大才查）。这几处都在 executor.ts 与本文件里。查到新行就按序号现拼内容推送。
 * 后端重启、pi 重启、断线补发走同一条路：从第 N 号之后查事件表、现拼内容，不依赖内存里存过什么。
 */

import * as library from "./library.ts";

export const hubSettings = {
  /** 补发窗口：断线重连时差得比这更多，就不补发，改发一条 resync。 */
  replayWindow: 500,
  /** 兜底轮询的间隔（毫秒）。 */
  pollMs: 2000,
};

export type HubItem = [string, number | null, Record<string, any>];

/** 一个订阅者：它自己的事件队列，以及已经发给它的最大库事件序号。 */
export class Subscriber {
  readonly session: string | null;
  lastSeq = 0;
  private items: HubItem[] = [];
  private waiter: ((item: HubItem | null) => void) | null = null;

  constructor(session: string | null) {
    this.session = session;
  }

  put(item: HubItem): void {
    if (this.waiter) {
      const waiter = this.waiter;
      this.waiter = null;
      waiter(item);
    } else {
      this.items.push(item);
    }
  }

  /** 取下一条；超时（毫秒）时为 null。 */
  get(timeoutMs: number): Promise<HubItem | null> {
    if (this.items.length) return Promise.resolve(this.items.shift()!);
    return new Promise((done) => {
      const timer = setTimeout(() => {
        this.waiter = null;
        done(null);
      }, timeoutMs);
      this.waiter = (item) => {
        clearTimeout(timer);
        done(item);
      };
    });
  }

  /** 连接断了：叫醒正在等的读取，让它退出。 */
  wake(): void {
    if (this.waiter) {
      const waiter = this.waiter;
      this.waiter = null;
      waiter(null);
    }
  }
}

export class Hub {
  readonly taskDir: string;
  isRunning: () => boolean;
  readonly subscribers: Subscriber[] = [];
  forwarded: number;
  readonly stats = { 轮询次数: 0, 轮询发现新行次数: 0, 提示次数: 0, 推送的库事件数: 0 };
  private timer: NodeJS.Timeout;
  /** 服务已经收尾：事件流不再等新事件。 */
  closed = false;

  constructor(taskDir: string, isRunning: () => boolean = () => false) {
    this.taskDir = taskDir;
    this.isRunning = isRunning;
    this.forwarded = library.currentMax(taskDir);
    this.timer = setInterval(() => this.poll(), hubSettings.pollMs);
    this.timer.unref();
  }

  /** 过程与对话类事件：没有 id，漏了不补。订阅时带了 session 的只收自己会话的。 */
  emit(name: string, data: Record<string, any>): void {
    for (const sub of [...this.subscribers]) {
      if (sub.session && data.session_id && data.session_id !== sub.session) continue;
      sub.put([name, null, data]);
    }
  }

  /** 有提示说库里可能有新行：查、拼、推，更新已转发序号。 */
  trigger(): void {
    this.stats.提示次数 += 1;
    const [events, top] = library.libraryEvents(this.taskDir, this.forwarded);
    // 这一批最后一条事件上带的阶段与灯是按会话算的：每个订阅者拿到的是它订阅的那条会话的那一份。
    const stages = new Map<string | null, ReturnType<typeof library.stageView>>();
    events.forEach(([name, data], index) => {
      const last = index === events.length - 1 && "stage" in data;
      for (const sub of [...this.subscribers]) sub.put([name, data.seq, last ? this.withStage(data, sub.session, stages) : data]);
      this.stats.推送的库事件数 += 1;
    });
    this.forwarded = Math.max(this.forwarded, top);
  }

  /** 把一条库事件上带的阶段换成某条会话的那一份；stages 是这一批里已经算过的，免得同一条会话算两遍。 */
  private withStage(data: Record<string, any>, session: string | null, stages: Map<string | null, ReturnType<typeof library.stageView>>): Record<string, any> {
    if (!stages.has(session)) stages.set(session, library.stageView(this.taskDir, session));
    return { ...data, stage: stages.get(session) };
  }

  private poll(): void {
    if (!this.isRunning()) return;
    this.stats.轮询次数 += 1;
    if (library.currentMax(this.taskDir) > this.forwarded) {
      this.stats.轮询发现新行次数 += 1;
      this.trigger();
    }
  }

  /** 先登记订阅者，再算补发：带了 Last-Event-ID 的，从它之后补；差距超过补发窗口发 resync。 */
  subscribe(session: string | null, lastEventId: number | null): [Subscriber, HubItem[]] {
    const sub = new Subscriber(session);
    this.subscribers.push(sub);
    let replay: HubItem[] = [];
    if (lastEventId !== null) {
      const top = library.currentMax(this.taskDir);
      if (top - lastEventId > hubSettings.replayWindow) {
        replay = [["resync", null, { reason: "gap_too_large" }]];
      } else if (top > lastEventId) {
        const [events] = library.libraryEvents(this.taskDir, lastEventId, session);
        replay = events.map(([name, data]) => [name, data.seq, data]);
      }
      sub.lastSeq = lastEventId;
    }
    return [sub, replay];
  }

  unsubscribe(sub: Subscriber): void {
    const i = this.subscribers.indexOf(sub);
    if (i >= 0) this.subscribers.splice(i, 1);
    sub.wake();
  }

  /** 服务收尾的第一步：停掉兜底轮询；事件流照旧开着，之后关 pi 时推的执行者状态还送得到。 */
  stopPolling(): void {
    clearInterval(this.timer);
  }

  /** 服务收尾的最后一步：停掉轮询，叫醒各条事件流让它们写完手上的事件、正常结束连接。 */
  close(): void {
    clearInterval(this.timer);
    this.closed = true;
    for (const sub of [...this.subscribers]) sub.wake();
  }
}
