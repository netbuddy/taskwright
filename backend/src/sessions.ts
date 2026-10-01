/**
 * 一个任务的会话：pi 把会话文件写在「归档目录/任务编号/pi-sessions/service/」下，一条会话一个 .jsonl 文件。
 * 这里只读会话目录里的文件，不起 pi；pi 的启动、续接与切换不在这里。
 */

import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { readSessionFile, sessionInfo } from "./conversation.ts";
import { byCodePoint } from "./library.ts";

export const LABEL = "service";

export class Sessions {
  readonly dir: string;
  private files = new Map<string, string>();
  /** 最近一次 list() 读到的最晚活动（毫秒）。 */
  private latest: number | null = null;

  constructor(runsDir: string, taskId: string) {
    this.dir = join(runsDir, taskId, "pi-sessions", LABEL);
  }

  /** 会话列表：每条会话的编号、名字、开始时刻、最近活动、消息条数，以及是不是执行者正接着的那条（不起 pi 时恒为假）。 */
  list() {
    const rows = [];
    let names: string[] = [];
    try {
      if (statSync(this.dir).isDirectory()) names = readdirSync(this.dir).filter((n) => n.endsWith(".jsonl")).sort(byCodePoint);
    } catch {
      names = [];
    }
    let latest: number | null = null;
    for (const name of names) {
      const { file, last_active_ms, ...info } = sessionInfo(join(this.dir, name));
      if (!info.session_id) continue;
      this.files.set(info.session_id, file);
      if (last_active_ms !== null && (latest === null || last_active_ms > latest)) latest = last_active_ms;
      rows.push({ ...info, active: false });
    }
    this.latest = latest;
    return rows;
  }

  /**
   * 这个任务的全部会话里最晚的一次活动（毫秒）；没有会话文件、或者都没有时刻时为 null。材料有没有进入对话按它判断。
   * 缺省重读一遍会话目录；刚调用过 list() 的地方传 false，用那一次读到的结果，不再读一遍。
   */
  lastActivityMs(fresh = true): number | null {
    if (fresh) this.list();
    return this.latest;
  }

  /** 记下一条会话的文件（pi 报来的活动会话文件；刚新建的会话文件可能还没写出来）。 */
  remember(sessionId: string, file: string): void {
    this.files.set(sessionId, file);
  }

  isFile(path: string): boolean {
    try {
      return statSync(path).isFile();
    } catch {
      return false;
    }
  }

  file(sessionId: string): string | undefined {
    if (!this.files.has(sessionId)) this.list();
    return this.files.get(sessionId);
  }

  /** 一条会话的全部条目，直接读会话文件；找不到文件时为空列表。 */
  entries(sessionId: string) {
    const path = this.file(sessionId);
    if (!path) return [];
    try {
      if (!statSync(path).isFile()) return [];
    } catch {
      return [];
    }
    return readSessionFile(path);
  }
}
