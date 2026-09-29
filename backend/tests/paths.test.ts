/** 仓根目录下的路径（fromRoot）：相对路径接在仓根目录下面，绝对路径原样返回，以 agent/ 开头的相对路径按 TASKWRIGHT_AGENT_DIR 找。 */

import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { REPO_ROOT, fromRoot } from "../src/paths.ts";

/** 只拼路径、不建目录：fromRoot 不碰磁盘。 */
const OUTSIDE = join(tmpdir(), "taskwright-from-root");

test("相对路径接在仓根目录下面", () => {
  assert.equal(fromRoot("backend/profiles/dev.json"), join(REPO_ROOT, "backend", "profiles", "dev.json"));
});

test("绝对路径原样返回，不接在仓根目录下面", () => {
  const outside = join(OUTSIDE, "prompt.md");
  assert.equal(fromRoot(outside), outside);
});

test("设了 TASKWRIGHT_AGENT_DIR 时，以 agent/ 开头的相对路径从那个目录找，绝对路径仍原样返回", () => {
  const saved = process.env.TASKWRIGHT_AGENT_DIR;
  const agentDir = join(OUTSIDE, "agent-cache");
  process.env.TASKWRIGHT_AGENT_DIR = agentDir;
  try {
    assert.equal(fromRoot("agent/prompts/system.md"), join(agentDir, "prompts", "system.md"));
    const outside = join(OUTSIDE, "agent", "x.md");
    assert.equal(fromRoot(outside), outside);
  } finally {
    if (saved === undefined) delete process.env.TASKWRIGHT_AGENT_DIR;
    else process.env.TASKWRIGHT_AGENT_DIR = saved;
  }
});
