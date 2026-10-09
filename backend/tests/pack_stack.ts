/**
 * 数据包测试共用的东西：建一个有任务、归档与知识库的临时数据目录；读一个包；比较两个目录里的文件。
 * 归档用测试自己造的小文件，不是真的对话记录。
 */

import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DB_NAME } from "../../agent/src/lib/db.ts";
import { MANIFEST_NAME, type Manifest, type PackLocations } from "../src/data_pack.ts";
import { Service } from "../src/service.ts";
import { ServiceDb } from "../src/service_db.ts";
import { ZipReader } from "../src/zip.ts";

export const sha256 = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");

/** 数据目录下各个位置（都在数据目录里面）。 */
export function locations(dataDir: string): PackLocations & { knowledgeDir: string } {
  return { dataDir, tasksDir: join(dataDir, "tasks"), runsDir: join(dataDir, "runs"), knowledgeDir: join(dataDir, "knowledge") };
}

/** 在 dataDir 建一个现在格式的数据目录（有服务级库与通用知识库），按 names 建几个任务，返回各位置与各任务的编号。 */
export async function dataWith(dataDir: string, names: string[]): Promise<PackLocations & { knowledgeDir: string; ids: string[] }> {
  const where = locations(dataDir);
  const service = new Service(where.tasksDir, where.runsDir, {}, { port: 1, knowledgeDir: where.knowledgeDir, registry: ServiceDb.open(dataDir, "0.5.0") });
  const ids = names.map((name) => service.create({ task_type: "srs-authoring", task_name: name }).task_id as string);
  await service.close();
  return { ...where, ids };
}

/** 写一个文件（上级目录不在就建），可以指定它的修改时刻（毫秒）。 */
export function put(path: string, content: string | Buffer, mtimeMs?: number): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  if (mtimeMs !== undefined) utimesSync(path, mtimeMs / 1000, mtimeMs / 1000);
}

/** 给一个任务造一份假的归档：一条会话文件（第一行记着任务目录）与一次运行的三个事件文件。返回这几个文件相对归档目录的路径。 */
export function putArchive(where: PackLocations, taskId: string, mtimeMs = Date.UTC(2026, 8, 20, 10, 0, 0)): string[] {
  const base = join(where.runsDir, taskId);
  const session = "pi-sessions/service/2026-09-20T10-00-00-000Z_01a11a9d-031c-7481-91dc-06673e05c0b1.jsonl";
  put(join(base, session), JSON.stringify({ type: "session", id: "01a11a9d-031c-7481-91dc-06673e05c0b1", cwd: join(where.tasksDir, taskId), timestamp: "2026-09-20T10:00:00.000Z" })
    + "\n" + JSON.stringify({ type: "message", id: "m1", timestamp: "2026-09-20T10:00:05.000Z", message: { role: "user", content: "先看一下材料" } }) + "\n", mtimeMs);
  const events = ["pi-events/service-20260920-100000.jsonl", "pi-events/service-20260920-100000.times.jsonl", "pi-events/service-20260920-100000.backend.jsonl"];
  for (const name of events) put(join(base, name), `{"file":"${name}"}\n`.repeat(20), mtimeMs);
  return [session, ...events];
}

/** 一个目录下全部普通文件的摘要（相对路径 → SHA-256），任务库旁边的两个日志文件不算。目录不存在时是空的。 */
export function tree(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const visit = (dir: string, rel: string) => {
    let names: string[];
    try {
      names = readdirSync(dir).sort();
    } catch {
      return;
    }
    for (const name of names) {
      const path = join(dir, name);
      const inside = rel ? `${rel}/${name}` : name;
      const st = lstatSync(path);
      if (st.isDirectory()) visit(path, inside);
      else if (st.isFile() && !name.endsWith("-wal") && !name.endsWith("-shm")) out[inside] = sha256(readFileSync(path));
    }
  };
  visit(root, "");
  return out;
}

/** 任务库里的几个数：修订、条目、来源、事件各几条，任务编号与格式版本。只读。 */
export function facts(taskDir: string) {
  const db = new DatabaseSync(join(taskDir, DB_NAME), { readOnly: true });
  try {
    const count = (sql: string) => Number((db.prepare(sql).get() as { n: number }).n);
    return {
      task_id: (db.prepare("SELECT task_id FROM task").get() as { task_id: string } | undefined)?.task_id ?? null,
      revisions: count("SELECT COUNT(*) AS n FROM revision"), items: count("SELECT COUNT(DISTINCT item_id) AS n FROM item_version"),
      sources: count("SELECT COUNT(*) AS n FROM item_source"), events: count("SELECT COUNT(*) AS n FROM event"),
      version: Number((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version),
    };
  } finally {
    db.close();
  }
}

/** 读一个包：清单文件、包里的条目名（清单文件自己除外），以及按路径取一个条目内容的函数。 */
export function readPack(file: string): { manifest: Manifest; names: string[]; content: (path: string) => Buffer } {
  const reader = ZipReader.open(file);
  try {
    const manifest = JSON.parse(reader.read(reader.entry(MANIFEST_NAME)!).toString("utf-8")) as Manifest;
    const data = new Map(reader.entries.map((entry) => [entry.name, reader.read(entry)]));
    return { manifest, names: reader.entries.map((entry) => entry.name).filter((name) => name !== MANIFEST_NAME), content: (path) => data.get(path)! };
  } finally {
    reader.close();
  }
}
