/**
 * 桌面包的目录（desktop_dirs.ts、paths.ts 的 userDataDirFor）：各平台的根目录缺省值，根下的 pi/ 与 cache/ 及两个环境变量的覆盖；
 * 首次启动时从本机 pi 的配置复制一次（复制不是链接，auth.json 只有本人能读，产品设置里的那一份跟着记过来，之后不再复制）；
 * 新构建起来之后删掉旧构建的程序内容（正在解压或复制的不动）。
 */

import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { COPIED_MARK, adoptPiConfig, desktopLayout, pruneOldBuilds, readCopiedMark } from "../src/desktop_dirs.ts";
import { userDataDirFor } from "../src/paths.ts";
import { tempDir } from "./helpers.ts";

const tmp = tempDir();
after(() => rmSync(tmp, { recursive: true, force: true }));
let n = 0;
const fresh = (name: string) => {
  const dir = join(tmp, `${name}-${++n}`);
  mkdirSync(dir, { recursive: true });
  return dir;
};

test("根目录的缺省值各平台一例；根下 pi/ 与 cache/；PI_CODING_AGENT_DIR 与 TASKWRIGHT_CACHE_DIR 给了时照给的", () => {
  assert.equal(userDataDirFor("linux", {}, "/u"), "/u/.local/share/taskwright");
  assert.equal(userDataDirFor("linux", { XDG_DATA_HOME: "/data/xdg" }, "/u"), "/data/xdg/taskwright");
  assert.equal(userDataDirFor("win32", { LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local" }, "C:\\Users\\u"), join("C:\\Users\\u\\AppData\\Local", "Taskwright"));
  assert.equal(userDataDirFor("darwin", {}, "/Users/u"), "/Users/u/Library/Application Support/Taskwright");
  assert.deepEqual(desktopLayout("/u/.local/share/taskwright", {}),
    { root: "/u/.local/share/taskwright", pi: "/u/.local/share/taskwright/pi", piGiven: false, cache: "/u/.local/share/taskwright/cache" });
  const given = desktopLayout("/srv/tw", { PI_CODING_AGENT_DIR: "/opt/pi-config", TASKWRIGHT_CACHE_DIR: "/var/cache/tw" });
  assert.deepEqual([given.pi, given.piGiven, given.cache], ["/opt/pi-config", true, "/var/cache/tw"]);
});

test("首次复制：自己的 pi/ 是空的而本机 pi 的配置里有模型登记与密钥时复制一份（不是链接），密钥整份复制，模型登记只留产品登记的服务，产品设置里的那一份跟着记过来，留下记号；之后不再复制", async () => {
  const root = fresh("root");
  const legacy = join(fresh("home"), ".pi", "agent");
  mkdirSync(legacy, { recursive: true });
  const auth = '{"taskwright-ollama":{"type":"api_key","key":"k"},"other-llm":{"type":"api_key","key":"k2"}}\n';
  writeFileSync(join(legacy, "models.json"), JSON.stringify({ providers: { "taskwright-ollama": { baseUrl: "http://a/v1", models: [{ id: "m" }] }, "other-llm": { baseUrl: "http://b/v1", models: [{ id: "q" }] }, "taskwright-old": { models: [] } }, extra: 1 }));
  writeFileSync(join(legacy, "auth.json"), auth, { mode: 0o644 });
  writeFileSync(join(legacy, "settings.json"), '{"defaultProvider":"taskwright-ollama","defaultModel":"m","theme":"dark"}\n');
  writeFileSync(join(legacy, "models-store.json"), "{}\n");
  const settings = join(root, "settings.json");
  const ollama = { kind: "ollama", purpose: "language", name: "ollama", base_url: "http://a", models_fetched_at: null, status: null, models: [] };
  writeFileSync(settings, JSON.stringify({ version: 2, pi_dirs: { [legacy]: { selection: { language: { provider: "taskwright-ollama", model: "m" } }, providers: { "taskwright-ollama": ollama } } } }));
  const env = { TASKWRIGHT_SETTINGS_FILE: settings };
  const pi = join(root, "pi");

  const mark = await adoptPiConfig(pi, legacy, env, () => new Date("2026-10-14T03:00:00Z"));
  assert.deepEqual(mark, { from: legacy, at: "2026-10-14T03:00:00.000Z", files: ["models.json", "auth.json", "settings.json"], skipped: ["other-llm", "taskwright-old"] });
  assert.deepEqual(JSON.parse(readFileSync(join(pi, "models.json"), "utf-8")), { providers: { "taskwright-ollama": { baseUrl: "http://a/v1", models: [{ id: "m" }] } }, extra: 1 },
    "用户本人登记的 other-llm 与产品名单上没有的 taskwright-old 都不复制；文件里别的内容照留");
  assert.equal(readFileSync(join(pi, "auth.json"), "utf-8"), auth, "凭据整份复制");
  assert.deepEqual(JSON.parse(readFileSync(join(pi, "settings.json"), "utf-8")), { defaultProvider: "taskwright-ollama", defaultModel: "m", theme: "dark" }, "缺省服务复制过来了，照留");
  for (const name of ["models.json", "auth.json", "settings.json"]) assert.equal(lstatSync(join(pi, name)).isSymbolicLink(), false, `${name} 是复制的，不是链接`);
  assert.equal(existsSync(join(pi, "models-store.json")), false, "只复制三个文件");
  assert.equal(statSync(join(pi, "auth.json")).mode & 0o777, 0o600);
  const dirs = JSON.parse(readFileSync(settings, "utf-8")).pi_dirs;
  assert.deepEqual(dirs[pi], dirs[legacy], "选过的模型跟着记到自己的 pi/ 名下");
  assert.deepEqual(readCopiedMark(pi), mark);
  assert.ok(existsSync(join(pi, COPIED_MARK)));

  // 之后：自己的 pi/ 里已经有了，不再复制；本机 pi 的配置后来改了也不跟。
  const before = readFileSync(join(pi, "models.json"), "utf-8");
  writeFileSync(join(legacy, "models.json"), '{"providers":{"changed":{}}}\n');
  assert.equal(await adoptPiConfig(pi, legacy, env), null);
  assert.equal(readFileSync(join(pi, "models.json"), "utf-8"), before);
  // 本机 pi 的配置里没有模型登记与密钥时什么都不做。
  const empty = fresh("empty");
  assert.equal(await adoptPiConfig(join(fresh("root2"), "pi"), empty, env), null);
});

test("首次复制：pi 的缺省服务是没有复制过来的服务时，去掉缺省服务与缺省模型；没有产品设置时模型登记一项都不复制；模型登记读不出来时不复制它", async () => {
  const legacy = join(fresh("home"), ".pi", "agent");
  mkdirSync(legacy, { recursive: true });
  writeFileSync(join(legacy, "models.json"), JSON.stringify({ providers: { "other-llm": { models: [{ id: "q" }] } } }));
  writeFileSync(join(legacy, "settings.json"), '{"defaultProvider":"other-llm","defaultModel":"q","theme":"dark"}\n');
  const pi = join(fresh("root"), "pi");
  const mark = await adoptPiConfig(pi, legacy, { TASKWRIGHT_SETTINGS_FILE: join(fresh("none"), "settings.json") });
  assert.deepEqual([mark!.files, mark!.skipped], [["models.json", "settings.json"], ["other-llm"]]);
  assert.deepEqual(JSON.parse(readFileSync(join(pi, "models.json"), "utf-8")), { providers: {} });
  assert.deepEqual(JSON.parse(readFileSync(join(pi, "settings.json"), "utf-8")), { theme: "dark" });

  const broken = join(fresh("home"), ".pi", "agent");
  mkdirSync(broken, { recursive: true });
  writeFileSync(join(broken, "models.json"), "{不是 JSON");
  writeFileSync(join(broken, "auth.json"), "{}\n");
  const pi2 = join(fresh("root"), "pi");
  const second = await adoptPiConfig(pi2, broken, { TASKWRIGHT_SETTINGS_FILE: join(fresh("none"), "settings.json") });
  assert.deepEqual([second!.files, second!.skipped], [["auth.json"], []]);
  assert.equal(existsSync(join(pi2, "models.json")), false);
});

test("旧构建清理：cache/payload/ 下只留现在这个构建，cache/ 下只留现在这个 agent-<构建号>；正在解压或复制的不动", () => {
  const cache = fresh("cache");
  for (const dir of ["payload/old1", "payload/now", "payload/next.tmp-4242", "agent-old", "agent-now", "agent-next.tmp-4242", "其他"]) mkdirSync(join(cache, dir), { recursive: true });
  writeFileSync(join(cache, "payload", "old1", "big.bin"), "x");
  const removed = pruneOldBuilds(cache, { payload: "now", agent: "agent-now" });
  assert.deepEqual(removed.sort(), ["agent-old", "payload/old1"]);
  for (const dir of ["payload/now", "payload/next.tmp-4242", "agent-now", "agent-next.tmp-4242", "其他"]) assert.ok(existsSync(join(cache, dir)), dir);
  // 不给要留哪一个时那一类不清（单可执行文件不清 agent-，AppImage 不清 payload/）。
  mkdirSync(join(cache, "payload", "old2"));
  assert.deepEqual(pruneOldBuilds(cache, { payload: null, agent: "agent-now" }), []);
  assert.ok(existsSync(join(cache, "payload", "old2")));
});
