# stages 目录

有阶段的任务（任务定义里有「总体分析」集合的任务）每次运行开始时，系统提示由扩展用这个目录里的文件拼成（`agent/src/hooks/stage_prompt.ts`），不再靠模型自己去读 skill 文件。

| 文件 | 内容 |
|---|---|
| `system.md` | 系统提示。 |
| `common.md` | 平台说明里每个阶段都要用的部分。 |
| `reading.md`、`clarifying.md`、`modeling.md`、`writing.md`、`reviewing.md`、`document.md` | 六项活动（六个阶段）各一段：做什么、不做什么、做到什么算够。一次运行只放当前这一项的那一段。文件名是 `agent/src/lib/stage.ts` 里六个阶段的键。 |
| `publish.md` | 发布这项活动的定义。现在只有头，不是工作阶段，不拼进系统提示。 |

六项活动的文件与 `publish.md` 开头两行 `---` 之间是一段结构化的头，一行一栏，写成「名字: 值」：`activity`（活动的键，与文件名相同）、`name`（名称）、`mode`（方式：`batch` 批处理、`dialogue` 逐项对话、`user_only` 仅限用户发起）、`purpose`（一句话目的）、`reads`（读哪几类需求资产）、`writes`（写哪几类）、`requires`（前置条件，可以是空的）、`example`（一句例子）。列表用逗号隔开。需求资产的六类是 `materials`（材料与证据）、`description`（业务说明）、`models`（分析模型）、`items`（需求条目）、`review`（评审与确认）、`versions`（文档与版本）；`reads` 另认 `knowledge`（知识库）与 `all`（全部资产）。前置条件都是数据条件，取值与校验在 `agent/src/lib/activity_def.ts`。头给任务起点页的活动目录用，也决定一项活动能不能启动；拼系统提示时头去掉，只用其后的正文。八栏缺了任何一栏、取值不认，活动目录就出不来（`agent/tests/activity_def.test.ts`）。

活动的说明里没有出口。一项活动做完了提议什么、往回提议什么、用户说的话不属于这一段时怎样办，是它在一条流程里的那个节点的事，写在流程的定义里：`agent/prompts/flows/initial.md`（首次分析），每个节点一节，标题是「# 节点：某阶段」。流程的定义开头同样有一段头：`flow`（流程的键）、`name`、`purpose`、`applies`（适用情形）、`nodes`（各站）、`inputs`（需要的输入）、`requires`、`example`（一段经过示例）；`agent/prompts/flows/change.md`（需求变更）现在只有头。系统提示按会话拼：会话的工作项是流程的工作项时，活动的说明后面接它那个节点的一节；工作项是单项活动时接一段固定的文字（做够了汇报结束，不提议别的活动）；会话空闲时（自由讨论的会话，或者它的工作项已经结束）用一段固定的开头接澄清那项活动的说明，不带出口。这两段固定的文字在 `agent/src/lib/stage_prompt.ts` 里。

任务类型一级的文字在任务类型的 skill 目录里：`SKILL.md` 的正文是每个阶段都要用的部分，旁边的 `stages/<阶段的键>.md` 是那个阶段的一段，没有这个文件就是这一段没有内容。

早先的任务没有阶段，它们的文字不在这里：系统提示是 `backend/prompts/executor_system_prompt.md`，平台说明是 `agent/prompts/skills/taskwright-executor/SKILL.md`。`common.md` 的第一到九节与第十一节同那一份平台说明本应相同（第十节与第十二节只有有阶段的任务才有），`agent/tests/stage_prompt_files.test.ts` 逐段核对；有意不同的几处列在那份测试的 `EDITS` 表里。改工具的用法、来源、回复这类两种任务都受影响的说明时，两份都要改。

`common.md` 里的理解格式说明由 `scripts/render-intent-schema.mjs` 生成，不要手改。
