/**
 * 脱敏诊断包里的任务库副本：把来源表（item_source）每条来源的摘录（excerpt）换成 mask 给的写法（摘要值与长度），别的表与列不动。
 * 只给后端导出脱敏诊断包时用，改的是复制到暂存目录里的那一份，原库不动（backend/src/data_pack.ts）。它与建任务、导入时改编号一样，
 * 是后端不写任务库的例外（backend/tests/no_writes.test.ts 的白名单）。
 */

import { DatabaseSync } from "node:sqlite";

/** 改写 dbFile 这份任务库里全部来源的摘录；返回改了几条。摘录为空的不改。 */
export function redactSourceExcerpts(dbFile: string, mask: (excerpt: string) => string): number {
  const db = new DatabaseSync(dbFile);
  try {
    const rows = db.prepare("SELECT rowid AS id, excerpt FROM item_source WHERE excerpt IS NOT NULL AND excerpt <> ''").all() as { id: number; excerpt: string }[];
    const update = db.prepare("UPDATE item_source SET excerpt = ? WHERE rowid = ?");
    db.exec("BEGIN");
    try {
      for (const row of rows) update.run(mask(row.excerpt), row.id);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    // 改写之后旧的摘录可能还留在库文件的空闲页里：整理一遍，按字节也找不到原文。
    db.exec("VACUUM");
    return rows.length;
  } finally {
    db.close();
  }
}
