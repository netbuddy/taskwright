/**
 * 与助手程序（pi）共用的配置文件的读写：模型登记文件 models.json 与登录凭据文件 auth.json。它们在这台电脑上这个用户的
 * pi 配置目录里，用户自己在命令行里用 pi 时读的也是它们，所以写的时候守三条规矩：
 *   1. 只改调用方给的那几项，文件里别的内容原样保留（读成对象、改、整份写回；不认识的字段一样写回）；
 *   2. 写之前先把原文件复制一份备份到同一目录，文件名是「原文件名.taskwright-backup-时刻」，每个文件只留最近 BACKUP_KEEP 份；
 *   3. 与 pi 用同样的办法加锁：在文件旁边建一个「原文件名.lock」目录（建目录是原子操作），建成才算拿到锁，写完删掉。
 *      pi 用的锁库把修改时间早于 STALE_MS 之前的锁目录当作失效的锁，这里照同样的规则清掉。
 * 写入先写同一目录里的临时文件再改名，权限与原文件相同（凭据文件是 0600）。
 * 文件里有注释时（pi 读的时候允许有注释），读成对象再写回会把注释丢掉，所以拒绝写入，说明原因。
 */

import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, rmdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { ApiError } from "./errors.ts";

/** 拿锁最多等这么久（毫秒），等不到就以 config_locked 拒绝。 */
export const LOCK_WAIT_MS = 2_000;
/** 两次尝试之间隔多久（毫秒）。 */
export const LOCK_RETRY_MS = 20;
/** 锁目录的修改时间早于这么久之前（毫秒）就当作失效的锁：与 pi 所用锁库的缺省值相同。 */
export const STALE_MS = 10_000;
/** 每个文件留几份备份。 */
export const BACKUP_KEEP = 5;
export const BACKUP_MARK = ".taskwright-backup-";

export function lockPath(file: string): string {
  return `${file}.lock`;
}

/** 在 file 旁边建锁目录，拿到锁之后运行 fn，最后删掉锁目录。等不到锁时抛 config_locked。 */
export async function withFileLock<T>(file: string, fn: () => T | Promise<T>): Promise<T> {
  const lock = lockPath(file);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      mkdirSync(lock);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (isStale(lock)) {
        try {
          rmdirSync(lock);
        } catch {
          // 别人刚好也在清它，或者它刚被释放：下一轮再试
        }
        continue;
      }
      if (Date.now() >= deadline) {
        throw new ApiError("config_locked", `配置文件 ${basename(file)} 正被别的程序写入，请稍后再试。`, { file: basename(file) });
      }
      await sleep(LOCK_RETRY_MS);
    }
  }
  try {
    return await fn();
  } finally {
    try {
      rmdirSync(lock);
    } catch {
      // 锁目录已经不在（例如被当作失效的锁清掉了）：没有什么要做的
    }
  }
}

function isStale(lock: string): boolean {
  try {
    return statSync(lock).mtimeMs < Date.now() - STALE_MS;
  } catch {
    return false;
  }
}

/**
 * 读一个配置文件，得到其中的对象。没有这个文件时是 {}。
 * 文件不能写回时（读不出、不是 JSON 对象、或者带注释）抛 config_unwritable，说明原因；文件内容一字不动。
 */
export function readForWrite(file: string): Record<string, any> {
  let text: string;
  try {
    text = readFileSync(file, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw unwritable(file, "读不出来");
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  if (!text.trim()) return {};
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    let plain = false;
    try {
      JSON.parse(stripJsonComments(text));
      plain = true;
    } catch {
      // 去掉注释也读不出：不是 JSON
    }
    throw unwritable(file, plain ? "里面有注释，改写时会把注释丢掉" : "不是有效的 JSON");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw unwritable(file, "不是一个 JSON 对象");
  return value as Record<string, any>;
}

function unwritable(file: string, why: string): ApiError {
  return new ApiError("config_unwritable", `配置文件 ${basename(file)} ${why}，所以没有改动它。请手工检查这个文件。`, { file: basename(file) });
}

/** 读一个配置文件，只用来看（允许注释与字节序标记，与 pi 相同）；没有、读不出或不是对象时是 null。 */
export function readForView(file: string): Record<string, any> | null {
  let text: string;
  try {
    text = readFileSync(file, "utf-8");
  } catch {
    return null;
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  try {
    const value = JSON.parse(stripJsonComments(text));
    return typeof value === "object" && value !== null && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

/** 去掉 JSON 文本里字符串之外的 // 与 /* *\/ 注释（与 pi 读配置文件时的处理相同）。 */
export function stripJsonComments(text: string): string {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      out += c;
      if (c === "\\") {
        out += text[i + 1] ?? "";
        i++;
      } else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i++;
    } else out += c;
  }
  return out;
}

/** 备份文件名里的时刻：UTC，精确到毫秒，例如 20260929T031200123Z；同一毫秒里再备份时加序号。 */
function stamp(date: Date): string {
  return date.toISOString().replace(/[-:]/g, "").replace(".", "");
}

/** 把 file 复制一份备份（权限与原文件相同），再删掉多出 BACKUP_KEEP 份的旧备份。没有原文件时什么也不做，返回 null。 */
export function backup(file: string, now = new Date()): string | null {
  if (!existsSync(file)) return null;
  const base = `${file}${BACKUP_MARK}${stamp(now)}`;
  let target = base;
  for (let n = 2; existsSync(target); n++) target = `${base}-${n}`;
  copyFileSync(file, target);
  chmodSync(target, statSync(file).mode & 0o777);
  const dir = dirname(file);
  const prefix = `${basename(file)}${BACKUP_MARK}`;
  const old = readdirSync(dir).filter((name) => name.startsWith(prefix)).sort();
  for (const name of old.slice(0, Math.max(0, old.length - BACKUP_KEEP))) {
    try {
      unlinkSync(join(dir, name));
    } catch {
      // 删不掉就留着
    }
  }
  return target;
}

/** 把对象写成 JSON：先写同一目录里的临时文件、设好权限，再改名替换原文件。mode 缺省时沿用原文件的权限，没有原文件时用 0600。 */
export function writeJson(file: string, value: unknown, mode?: number): void {
  const dir = dirname(file);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const keep = mode ?? (existsSync(file) ? statSync(file).mode & 0o777 : 0o600);
  const temp = join(dir, `.${basename(file)}.taskwright-${process.pid}-${Date.now()}.tmp`);
  try {
    writeFileSync(temp, JSON.stringify(value, null, 2) + "\n", { encoding: "utf-8", mode: keep });
    chmodSync(temp, keep);
    renameSync(temp, file);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}

/**
 * 在锁里读、改、写一个配置文件：change 拿到当前的对象，就地修改后返回 true 表示要写回（返回 false 什么也不写、不备份）。
 * 写回之前先备份。mode 见 writeJson。
 */
export async function updateJsonFile(file: string, change: (value: Record<string, any>) => boolean, mode?: number): Promise<void> {
  await withFileLock(file, () => {
    const value = readForWrite(file);
    if (!change(value)) return;
    backup(file);
    writeJson(file, value, mode);
  });
}
