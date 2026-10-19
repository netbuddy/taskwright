# stages 目录

这个目录现在放两样东西：系统提示 `system.md`，与各项活动的头（`reading.md`、`clarifying.md`、`modeling.md`、`writing.md`、`reviewing.md`、`document.md`、`publish.md`，文件名是活动的键）。
有阶段的任务每次运行开始时，系统提示由扩展按会话选段拼成（`agent/src/lib/context_assemble.ts`）：平台说明在 `../capabilities/`（按七项能力分目录，一个文件一个模块），
各项活动的工序在 `../templates/`（活动模板），各节点的出口在 `../flows/`。这里的活动文件只有头，不拼进系统提示。

活动的头在开头两行 `---` 之间，一行一栏，写成「名字: 值」：`activity`（活动的键，与文件名相同）、`name`（名称）、`mode`（方式：`batch` 批处理、`dialogue` 逐项对话、`user_only` 仅限用户发起）、`purpose`（一句话目的）、`reads`（读哪几类需求资产）、`writes`（写哪几类）、`requires`（前置条件，可以是空的）、`example`（一句例子）。列表用逗号隔开。需求资产的六类是 `materials`（材料与证据）、`description`（业务说明）、`models`（分析模型）、`items`（需求条目）、`review`（评审与确认）、`versions`（文档与版本）；`reads` 另认 `knowledge`（知识库）与 `all`（全部资产）。前置条件都是数据条件，取值与校验在 `agent/src/lib/activity_def.ts`。头给任务起点页的活动目录用，也决定一项活动能不能启动，拼系统提示时按它的 `mode`、`reads`、`writes` 选模块。八栏缺了任何一栏、取值不认，活动目录就出不来（`agent/tests/activity_def.test.ts`）。

任务类型一级的文字在任务类型的 skill 目录里：`SKILL.md` 的正文是每项活动都要用的部分，旁边的 `stages/<活动的键>.md` 是那项活动的补充，没有这个文件就是这一段没有内容。
