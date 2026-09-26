/**
 * 仓根目录：启动时算一次，任务类型模板、启动配置、理解格式的 schema 等资源文件一律从这里定位，
 * 不在各模块里各自拼相对路径。以后打包成单个可执行文件时，只改这一处的算法。
 */

import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** 任务类型模板所在的目录：每个子目录是一种任务类型的起始文件。 */
export const TASK_TYPES_DIR = join(REPO_ROOT, "task-types");

/** 启动配置所在的目录（与 Python 版共用同一份）。 */
export const PROFILE_DIR = join(REPO_ROOT, "server", "taskwright_server", "profiles");

/** 理解格式的 schema：用户行为各功能的中文名写在它的 $defs.user_function 的 x-names 里。 */
export const INTENT_SCHEMA_PATH = join(REPO_ROOT, "agent", "prompts", "schemas", "user_intent.schema.json");
