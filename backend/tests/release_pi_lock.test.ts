/**
 * 静态核对：release/pi 里钉住的 pi 与它的锁文件。
 *
 * 安装包里的 pi 由 release/build.mjs 照 release/pi/package-lock.json 装出来。这里只读文件，核对三件事：
 * 钉的是一个精确版本，锁文件与它对得上；锁文件里的每个包都来自公开的 npm 源并带校验值；
 * 依赖都装在 pi 自己的 node_modules 里（构建只复制 pi 的包目录，保留清单 PI_KEEP 写的也是这个位置）。
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const RELEASE = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "release");
const PI = "@earendil-works/pi-coding-agent";
const PI_PATH = `node_modules/${PI}`;
const REGISTRY = "https://registry.npmjs.org/";

type LockEntry = { version?: string; resolved?: string; integrity?: string; dependencies?: Record<string, string> };

const read = (...parts: string[]) => readFileSync(join(RELEASE, ...parts), "utf-8");
const pinned = JSON.parse(read("pi", "package.json")) as { dependencies: Record<string, string>; devDependencies?: unknown };
const lock = JSON.parse(read("pi", "package-lock.json")) as { lockfileVersion: number; packages: Record<string, LockEntry> };
const version = pinned.dependencies[PI];

test("release/pi/package.json 只钉 pi 一个依赖，写的是精确版本", () => {
  assert.deepEqual(Object.keys(pinned.dependencies), [PI]);
  assert.equal(pinned.devDependencies, undefined);
  assert.match(version, /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/, `要写精确版本，现在是 ${version}`);
});

test("锁文件里 pi 的版本与 package.json 钉的相同", () => {
  assert.equal(lock.lockfileVersion, 3);
  assert.deepEqual(lock.packages[""].dependencies, { [PI]: version });
  assert.equal(lock.packages[PI_PATH]?.version, version);
});

test("锁文件里的每个包都来自公开的 npm 源并带校验值", () => {
  const entries = Object.entries(lock.packages).filter(([key]) => key !== "");
  assert.ok(entries.length > 1);
  for (const [key, entry] of entries) {
    assert.ok(entry.resolved?.startsWith(REGISTRY), `${key} 的地址不是公开的 npm 源：${entry.resolved}`);
    assert.match(entry.integrity ?? "", /^sha512-/, `${key} 没有校验值`);
  }
});

test("依赖都在 pi 自己的 node_modules 里，构建要保留的包也在那里", () => {
  const npmrc = read("pi", ".npmrc").split("\n").map((line) => line.trim());
  assert.ok(npmrc.includes("install-strategy=shallow"));
  assert.ok(npmrc.includes(`registry=${REGISTRY}`));
  const outside = Object.keys(lock.packages).filter((key) => key !== "" && key !== PI_PATH && !key.startsWith(`${PI_PATH}/node_modules/`));
  assert.deepEqual(outside, [], "锁文件要用 install-strategy=shallow 生成，见 release/pi/README.md");

  const build = read("build.mjs");
  const keep = /const PI_KEEP = (\[[^\]]*\]);/.exec(build);
  assert.ok(keep, "release/build.mjs 里找不到 PI_KEEP");
  const packages = (JSON.parse(keep[1]) as string[]).filter((each) => each.startsWith("node_modules/"));
  assert.ok(packages.length > 0);
  for (const each of packages) assert.ok(lock.packages[`${PI_PATH}/${each}`], `PI_KEEP 里的 ${each} 不在锁文件里 pi 自己的 node_modules 下`);
});

test("release/build.mjs 不另写一份 pi 的版本号", () => {
  const build = read("build.mjs");
  assert.doesNotMatch(build, /PI_VERSION/);
  assert.ok(!build.includes(`"${version}"`), `build.mjs 里又出现了 "${version}"，版本号只写在 release/pi/package.json`);
});
