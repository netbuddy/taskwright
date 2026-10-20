/**
 * 需求资产的六类：键与「资产显示名」的读法。不读文件、不读库，页面也导入（经 lib/activity_catalog.ts），不能导入 node 模块。
 * 键是平台定的，活动声明的 reads、writes 写这几个键；给人看的名字由任务定义的「资产显示名」给（lib/asset_names.ts 取用）。
 */

/** 六类资产的键，按任务起点页上从左到右的次序。 */
export const ASSETS = ["materials", "description", "models", "items", "review", "versions"] as const;
export type AssetKey = (typeof ASSETS)[number];

/** 读「资产显示名」的值：六个键各一段不为空的文字，不多不少时给出（去掉两头空白），否则是 null。 */
export function parseAssetNames(given: unknown): Record<AssetKey, string> | null {
  if (typeof given !== "object" || given === null || Array.isArray(given)) return null;
  const entries = given as Record<string, unknown>;
  if (Object.keys(entries).length !== ASSETS.length || !ASSETS.every((key) => typeof entries[key] === "string" && (entries[key] as string).trim() !== "")) return null;
  return Object.fromEntries(ASSETS.map((key) => [key, (entries[key] as string).trim()])) as Record<AssetKey, string>;
}
