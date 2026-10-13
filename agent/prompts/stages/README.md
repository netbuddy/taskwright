# stages 目录

有阶段的任务（任务定义里有「总体分析」集合的任务）每次运行开始时，系统提示由扩展用这个目录里的文件拼成（`agent/src/hooks/stage_prompt.ts`），不再靠模型自己去读 skill 文件。

| 文件 | 内容 |
|---|---|
| `system.md` | 系统提示。 |
| `common.md` | 平台说明里每个阶段都要用的部分。 |
| `reading.md`、`clarifying.md`、`modeling.md`、`writing.md`、`reviewing.md`、`document.md` | 六项活动（六个阶段）各一段：做什么、不做什么、做到什么算够。一次运行只放当前这一项的那一段。文件名是 `agent/src/lib/stage.ts` 里六个阶段的键。 |

活动的说明里没有出口。一项活动做完了提议什么、往回提议什么、用户说的话不属于这一段时怎样办，是它在一条流程里的那个节点的事，写在流程的定义里：`agent/prompts/flows/initial.md`（首次分析），每个节点一节，标题是「# 节点：某阶段」。任务在流程里的某个阶段时，系统提示里活动的说明后面接它那个节点的一节；用户单独开展一项活动时接一段固定的文字（做够了汇报结束，不提议别的活动）；任务空闲时用一段固定的开头接澄清那项活动的说明，不带出口。这两段固定的文字在 `agent/src/lib/stage_prompt.ts` 里。

任务类型一级的文字在任务类型的 skill 目录里：`SKILL.md` 的正文是每个阶段都要用的部分，旁边的 `stages/<阶段的键>.md` 是那个阶段的一段，没有这个文件就是这一段没有内容。

早先的任务没有阶段，它们的文字不在这里：系统提示是 `backend/prompts/executor_system_prompt.md`，平台说明是 `agent/prompts/skills/taskwright-executor/SKILL.md`。`common.md` 的第一到九节与第十一节同那一份平台说明本应相同（第十节与第十二节只有有阶段的任务才有），`agent/tests/stage_prompt_files.test.ts` 逐段核对；有意不同的几处列在那份测试的 `EDITS` 表里。改工具的用法、来源、回复这类两种任务都受影响的说明时，两份都要改。

`common.md` 里的理解格式说明由 `scripts/render-intent-schema.mjs` 生成，不要手改。
