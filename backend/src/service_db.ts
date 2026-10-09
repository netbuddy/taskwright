/**
 * 服务级库：数据目录下的 service.sqlite，一个数据目录一份。放不属于任何一个任务的数据。
 *
 * 现在有两张表：
 * - meta：键值。data_format 是数据目录的格式版本（现在是 1），last_written_by 是最近一次写这个数据目录的产品版本。
 * - tasks：任务登记表，每个任务一行：编号、名字、属主、状态、任务类型、建立时刻、任务目录相对任务根目录的路径，
 *   以及最近一次数据升级失败的时刻与原因（没有失败过是空）。
 *
 * 这是唯一写这个库的模块：建表、升级与每一句 SQL 都在这里，别的文件只调下面的取存函数，参数与返回都是普通对象
 * （backend/tests/no_writes.test.ts 守着）。以后把服务级库换成别的数据库，要换的只有这一个文件。
 *
 * 任务的内容不在这里：每个任务有它自己的任务库（任务目录里的 task.sqlite），那个库后端只读。登记表里的名字与状态是登记时
 * 从任务库抄来的：建任务时、服务接手任务时、任务升级完时各抄一次，任务完成时不同步，所以它可能比任务库里的旧。
 * 现在读登记表的只有数据升级（看哪些任务升级失败过）；任务列表仍然按任务目录扫描、读各任务库。
 */

import { existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync, backup } from "node:sqlite";

export const SERVICE_DB_NAME = "service.sqlite";

/** 数据目录现在的格式版本，记在 meta 的 data_format 与库文件自己的 user_version 里。以后每改一次服务级库的结构就加一步、加 1。 */
export const DATA_FORMAT = 1;

/** 遇到别的连接占着锁时最多等多少毫秒（与任务库的写入一侧相同）。 */
const BUSY_TIMEOUT_MS = 5000;

/** 数据目录的格式版本比这个程序认识的新：旧程序不打开新数据。writtenBy 是写它的产品版本，没有记时是 null。 */
export class NewerDataDirectory extends Error {
  readonly writtenBy: string | null;
  constructor(writtenBy: string | null) {
    super("数据目录的格式比这个程序新");
    this.writtenBy = writtenBy;
  }
}

/** 登记表里的一行。 */
export interface TaskRecord {
  task_id: string;
  name: string | null;
  /** 属主；现在只有单机用户，写 local。 */
  owner: string;
  status: string | null;
  task_type: string | null;
  created_at: string | null;
  /** 任务目录相对任务根目录的路径。 */
  dir: string;
  /** 最近一次数据升级失败的时刻与原因；没有失败过，或者后来升级成了，都是 null。 */
  upgrade_failed_at: string | null;
  upgrade_error: string | null;
}

/** 登记一个任务时给的内容：升级失败的两项不在这里改（见 markUpgradeFailed、clearUpgradeFailed）。 */
export type TaskEntry = Omit<TaskRecord, "upgrade_failed_at" | "upgrade_error">;

/** 数据目录的格式版本与最近写它的产品版本。 */
export interface DataDirectoryState {
  data_format: number;
  last_written_by: string | null;
}

export function serviceDbPath(dataDir: string): string {
  return join(dataDir, SERVICE_DB_NAME);
}

/** 各步把库从一个格式版本升到下一个；每一步在一个事务里，版本号在同一个事务里写。 */
const STEPS: { from: number; to: number; sql: string }[] = [
  {
    from: 0, to: 1,
    sql: `CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS tasks (
  task_id TEXT PRIMARY KEY,
  name TEXT,
  owner TEXT NOT NULL,
  status TEXT,
  task_type TEXT,
  created_at TEXT,
  dir TEXT NOT NULL,
  upgrade_failed_at TEXT,
  upgrade_error TEXT
);`,
  },
];

/** 库给的一行是没有原型的对象：抄成普通对象再交出去，调用方拿到的与别处的对象一样比较、一样序列化。 */
const plain = (row: unknown): TaskRecord | null => (row ? { ...(row as TaskRecord) } : null);

const versionOf = (db: DatabaseSync) => Number((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version);

/**
 * 只读看一眼数据目录的格式版本，不建文件、不改任何东西。服务级库还不存在（全新的数据目录，或者上一版留下的）时返回 null。
 * 库文件在却读不出来时抛错。
 */
export function peekDataDirectory(dataDir: string): DataDirectoryState | null {
  const path = serviceDbPath(dataDir);
  if (!existsSync(path)) return null;
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const version = versionOf(db);
    let writtenBy: string | null = null;
    try {
      const row = db.prepare("SELECT value FROM meta WHERE key = 'last_written_by'").get() as { value: string } | undefined;
      writtenBy = row ? row.value : null;
    } catch {
      // 还没有 meta 表（空文件）：不知道是谁写的
    }
    return { data_format: version, last_written_by: writtenBy };
  } finally {
    db.close();
  }
}

/**
 * 把数据目录的服务级库完整地复制一份到 target（数据升级之前的备份），返回副本的字节数；服务级库还不存在时什么都不做，返回 null。
 * 用数据库自带的备份办法，不是复制文件（理由同任务库的备份，见 library.ts 的 backupTaskDb）。
 */
export async function backupServiceDb(dataDir: string, target: string): Promise<number | null> {
  const path = serviceDbPath(dataDir);
  if (!existsSync(path)) return null;
  mkdirSync(dirname(target), { recursive: true });
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    await backup(db, target);
  } finally {
    db.close();
  }
  return statSync(target).size;
}

export class ServiceDb {
  private readonly db: DatabaseSync;

  private constructor(db: DatabaseSync) {
    this.db = db;
  }

  /** 只读打开数据目录的服务级库（只用取的那几个函数）；库文件不存在时是 null。不建文件、不升级。 */
  static read(dataDir: string): ServiceDb | null {
    const path = serviceDbPath(dataDir);
    if (!existsSync(path)) return null;
    return new ServiceDb(new DatabaseSync(path, { readOnly: true }));
  }

  /**
   * 打开数据目录的服务级库；没有就新建，格式旧就升到现在的版本，并记下这次写它的产品版本。
   * 比这个程序新时抛 NewerDataDirectory，什么都不改。
   */
  static open(dataDir: string, productVersion: string): ServiceDb {
    mkdirSync(dataDir, { recursive: true });
    const db = new DatabaseSync(serviceDbPath(dataDir), { timeout: BUSY_TIMEOUT_MS });
    try {
      let version = versionOf(db);
      if (version > DATA_FORMAT) {
        let writtenBy: string | null = null;
        try {
          writtenBy = ((db.prepare("SELECT value FROM meta WHERE key = 'last_written_by'").get() as { value: string } | undefined) ?? null)?.value ?? null;
        } catch {
          // 读不出是谁写的
        }
        throw new NewerDataDirectory(writtenBy);
      }
      db.exec("PRAGMA journal_mode = WAL");
      for (const step of STEPS) {
        if (step.from !== version) continue;
        db.exec("BEGIN IMMEDIATE");
        try {
          db.exec(step.sql);
          db.exec(`PRAGMA user_version = ${step.to}`);
          db.exec("COMMIT");
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
        version = step.to;
      }
      const store = new ServiceDb(db);
      store.setMeta("data_format", String(DATA_FORMAT));
      store.setMeta("last_written_by", productVersion);
      return store;
    } catch (error) {
      db.close();
      throw error;
    }
  }

  /** 关掉连接；重复调用只关一次。 */
  close(): void {
    if (this.db.isOpen) this.db.close();
  }

  meta(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined;
    return row ? row.value : null;
  }

  setMeta(key: string, value: string): void {
    this.db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
  }

  /**
   * 登记一个任务，或者把已经登记的那一行改成现在的样子。升级失败的两项不动。
   * 一个任务目录只留一行：这个目录先前按别的编号记过（升级失败时读不出任务编号，是按目录名记的），那一行并到这一行里。
   */
  putTask(entry: TaskEntry): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const other = this.db.prepare("SELECT * FROM tasks WHERE dir = ? AND task_id <> ?").get(entry.dir, entry.task_id) as TaskRecord | undefined;
      if (other) this.db.prepare("DELETE FROM tasks WHERE task_id = ?").run(other.task_id);
      this.db.prepare(
        "INSERT INTO tasks (task_id, name, owner, status, task_type, created_at, dir, upgrade_failed_at, upgrade_error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) "
        + "ON CONFLICT(task_id) DO UPDATE SET name = excluded.name, owner = excluded.owner, status = excluded.status, "
        + "task_type = excluded.task_type, created_at = excluded.created_at, dir = excluded.dir",
      ).run(entry.task_id, entry.name, entry.owner, entry.status, entry.task_type, entry.created_at, entry.dir,
        other?.upgrade_failed_at ?? null, other?.upgrade_error ?? null);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  task(taskId: string): TaskRecord | null {
    return plain(this.db.prepare("SELECT * FROM tasks WHERE task_id = ?").get(taskId));
  }

  /** 登记表里目录是这一个的那一行；没有登记过是 null。 */
  taskByDir(dir: string): TaskRecord | null {
    return plain(this.db.prepare("SELECT * FROM tasks WHERE dir = ?").get(dir));
  }

  /** 登记的全部任务，按编号排。 */
  tasks(): TaskRecord[] {
    return this.db.prepare("SELECT * FROM tasks ORDER BY task_id").all().map((row) => plain(row)!);
  }

  /**
   * 记下一个任务目录的数据升级没有做成。这个任务可能还没有登记过（升级失败时读不出它的任务记录），所以按目录记：
   * 没有登记的先登记一行，编号用目录名。
   */
  markUpgradeFailed(dir: string, at: string, error: string): void {
    this.db.prepare(
      "INSERT INTO tasks (task_id, owner, dir, upgrade_failed_at, upgrade_error) VALUES (?, 'local', ?, ?, ?) "
      + "ON CONFLICT(task_id) DO UPDATE SET upgrade_failed_at = excluded.upgrade_failed_at, upgrade_error = excluded.upgrade_error",
    ).run(this.taskByDir(dir)?.task_id ?? dir, dir, at, error);
  }

  /** 这个任务目录的数据升级后来做成了：清掉先前记的失败。 */
  clearUpgradeFailed(dir: string): void {
    this.db.prepare("UPDATE tasks SET upgrade_failed_at = NULL, upgrade_error = NULL WHERE dir = ?").run(dir);
  }
}
