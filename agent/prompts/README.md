# 提示词与运行时文字的索引

本目录放平台一级的全部文字：给助手（模型）读的说明、工具的说明，以及运行时由程序填值后发给助手或显示给用户的整句话。
平台一级的文字由产品工程改，现场只读；任务类型一级的文字在任务类型目录里（`task-types/<键>/.pi/skills/`），任务一级的由用户改。

每一份文字下面写四件事：拼在哪里（系统提示里的哪个部分，或者运行时的哪个地方）、谁读（模型、用户或两者）、
参数（模板里的 `{{名字}}`）、被哪些测试钉着。改了文字要跑这些测试；固定期望文件要跟着改的另外写明。

## 系统提示的几部分

有阶段的任务每次运行之前，扩展按这条会话的工作项把系统提示整份换成拼好的一份（`agent/src/lib/stage_prompt.ts`，
扩展的接线在 `agent/src/hooks/stage_prompt.ts`）。各部分依次是：系统提示、平台说明的共用部分、任务类型说明的共用部分、
平台说明里这个阶段的那一段、这个阶段在流程里的出口、任务类型说明里这个阶段的那一段、本次范围说明、助手程序接在后面的工作目录等。
下表的「部分」一栏用这些名字。

| 文件 | 拼在哪里 | 谁读 | 参数 | 钉住它的测试 |
|---|---|---|---|---|
| `stages/system.md` | 系统提示（第一部分）；也是启动参数 `--system-prompt` 给的那一份，拼不成时沿用 | 模型 | 无 | `agent/tests/stage_prompt_files.test.ts`、`agent/tests/skill_files.test.ts`、`agent/tests/stage_prompt.test.ts`、`backend/tests/stage_prompt_rpc.test.ts`、`backend/tests/profiles.test.ts`；固定期望文件 `backend/tests/fixtures/expected/launch_argv.json` 与 `observatory_view.json` 里有它的全文 |
| `stages/common.md` | 平台说明的共用部分 | 模型 | 无；第八节的理解格式说明由 `scripts/render-intent-schema.mjs` 从 `schemas/user_intent.schema.json` 生成 | `agent/tests/stage_prompt_files.test.ts`、`agent/tests/skill_files.test.ts`、`agent/tests/dialogue_acts.test.ts`、`agent/tests/understanding_eval.test.ts`、`agent/tests/stage_prompt.test.ts` |
| `stages/reading.md`、`clarifying.md`、`modeling.md`、`writing.md`、`reviewing.md`、`document.md`、`publish.md` | 平台说明里这个阶段的那一段（文件名是活动的键）；文件头是活动的定义（`agent/src/lib/activity_def.ts` 读） | 模型；文件头里的名字与说明也显示给用户 | 无 | `agent/tests/stage_prompt_files.test.ts`、`agent/tests/stage_prompt.test.ts`、`agent/tests/activity_def.test.ts` |
| `stages/README.md` | 不拼，写给改说明的人 | 人 | — | — |
| `flows/analysis.md` | 这个阶段在流程里的出口（每个节点一节，标题「# 节点：某阶段」）；文件头是流程的定义 | 模型；文件头里的名字与说明也显示给用户 | 无 | `agent/tests/stage_prompt_files.test.ts`、`agent/tests/stage_prompt.test.ts`、`agent/tests/activity_def.test.ts` |
| `flows/change.md` | 现在只有流程的头，不拼进系统提示 | 用户（流程的名字与说明） | 无 | `agent/tests/activity_def.test.ts` |
| `schemas/user_intent.schema.json` | 不直接拼：扩展用它从助手的文字里认出理解（`agent/src/lib/structured_outputs.ts`），`common.md` 第八节的格式说明由它生成 | 程序；生成的说明给模型 | — | `agent/tests/dialogue_acts.test.ts`、`agent/tests/stage_prompt_files.test.ts` |
| `review.md` | 评审者的系统提示（`agent/src/lib/review.ts`），不属于执行者的系统提示 | 模型（评审者） | 无 | `agent/tests/overall_review.test.ts` 与评审的测试 |

## 模板：`tools/` 与 `runtime/`

`tools/` 放工具的说明：每个工具一份，登记工具时读入（总说明、提示里的一句话、用法要点、每个参数的说明）。
`runtime/` 放运行时的文字：任务状况消息、界面操作说明、工具的拒绝语、空闲时的开头、本次范围说明等。
两处的文件都是模板，代码经 `agent/src/lib/texts.ts` 按键取出、填值。

一份模板文件这样写：

```markdown
# 任务状况消息

（这里可以写这份文件的说明，第一个键之前的文字不属于任何键。）

## `status.opening`

用途：会话开头任务现状消息的第一句。

任务「{{name}}」现在在{{stage}}。
```

- 每一段从一行二级标题开始，标题只写键，键放在反引号里；二级标题不能有别的写法。键用小写字母、数字与下划线，用点隔成至少两段，全部模板里不重复。
- 标题下第一个不空的行写「用途：」加一句话：这句话在哪里出现、给谁看。
- 再往下到下一个二级标题之前是正文，首尾的空行去掉，中间原样（换行就是换行）。正文是到达模型或用户的整句话；编号、键名、JSON 的形状留在代码里。
- 占位只有 `{{名字}}` 一种，没有条件、循环这类逻辑：选哪一句由代码定。
- 代码里引用键写字面的字符串：`fillText("status.opening", { name, stage })` 直接取文字，`textKey("status.opening")` 先存下键之后再取。
  守护测试 `agent/tests/texts_guard.test.ts` 按这两种写法扫助手库与后端的源码，核对代码用的键都有模板、没有闲置的模板、
  对象字面量给的值与占位一一对上；运行时 `fillText` 每次都核对给的值与占位，对不上就抛错。

| 文件 | 拼在哪里 | 谁读 | 参数 | 钉住它的测试 |
|---|---|---|---|---|

（这一张表随模板文件逐份补上；守护测试核对每一份模板文件在本文件里都列着。）
