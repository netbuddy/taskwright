# stages 目录

有阶段的任务（任务定义里有「总体分析」集合的任务）每次运行开始时，系统提示由扩展用这个目录里的文件拼成（`agent/src/hooks/stage_prompt.ts`），不再靠模型自己去读 skill 文件。

| 文件 | 内容 |
|---|---|
| `system.md` | 系统提示。 |
| `common.md` | 平台说明里每个阶段都要用的部分。 |
| `reading.md`、`clarifying.md`、`modeling.md`、`writing.md`、`reviewing.md` | 五个阶段各一段，一次运行只放当前阶段的那一段。文件名是 `agent/src/lib/stage.ts` 里五个阶段的键。 |

任务类型一级的文字在任务类型的 skill 目录里：`SKILL.md` 的正文是每个阶段都要用的部分，旁边的 `stages/<阶段的键>.md` 是那个阶段的一段，没有这个文件就是这一段没有内容。

早先的任务没有阶段，它们的文字不在这里：系统提示是 `backend/prompts/executor_system_prompt.md`，平台说明是 `agent/prompts/skills/taskwright-executor/SKILL.md`。`common.md` 的第一到九节与第十一节同那一份平台说明本应相同，`agent/tests/stage_prompt_files.test.ts` 逐段核对；有意不同的几处列在那份测试的 `EDITS` 表里。改工具的用法、来源、回复这类两种任务都受影响的说明时，两份都要改。

`common.md` 里的理解格式说明由 `scripts/render-intent-schema.mjs` 生成，不要手改。
