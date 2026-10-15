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
- 正文里有以「## 」开头的行时（例如拼进系统提示的一节带着自己的标题），把整段正文放在一行「````text」与一行「````」之间，原样取中间的内容；围栏之后到下一个标题之前只能是空行。
- 占位只有 `{{名字}}` 一种，没有条件、循环这类逻辑：选哪一句由代码定。
- 代码里引用键写字面的字符串：`fillText("status.opening", { name, stage })` 直接取文字，`textKey("status.opening")` 先存下键之后再取。
  守护测试 `agent/tests/texts_guard.test.ts` 按这两种写法扫助手库与后端的源码，核对代码用的键都有模板、没有闲置的模板、
  对象字面量给的值与占位一一对上；运行时 `fillText` 每次都核对给的值与占位，对不上就抛错。

| 文件 | 拼在哪里 | 谁读 | 参数 | 钉住它的测试 |
|---|---|---|---|---|
| `tools/get_item.md` | 工具「查看条目」登记时的总说明、工具清单里的一句话、用法要点与每个参数的说明（`agent/src/tools/get_item.ts`） | 模型 | 无 | `agent/tests/texts_guard.test.ts` |
| `tools/get_task_status.md` | 工具「查询任务状态」登记时的总说明、工具清单里的一句话、用法要点与每个参数的说明（`agent/src/tools/get_task_status.ts`） | 模型 | 无 | `agent/tests/texts_guard.test.ts` |
| `tools/publish_version.md` | 工具「发布版本」登记时的总说明、工具清单里的一句话、用法要点与每个参数的说明（`agent/src/tools/publish_version.ts`） | 模型 | 无 | `agent/tests/texts_guard.test.ts` |
| `tools/reply.md` | 工具「回复」登记时的总说明、工具清单里的一句话、用法要点与每个参数的说明（`agent/src/tools/reply.ts`） | 模型 | 无 | `agent/tests/texts_guard.test.ts`、`agent/tests/reply_tool_text.test.ts` |
| `tools/request_review.md` | 工具「请求评审」登记时的总说明、工具清单里的一句话、用法要点与每个参数的说明（`agent/src/tools/request_review.ts`） | 模型 | 无 | `agent/tests/texts_guard.test.ts` |
| `tools/save_diagram.md` | 工具「保存图」登记时的总说明、工具清单里的一句话、用法要点与每个参数的说明（`agent/src/tools/save_diagram.ts`） | 模型 | `save_diagram.param.kind` 有 `{{kinds}}`（图的六个种类与中文名，取自 `agent/src/lib/diagram.ts`） | `agent/tests/texts_guard.test.ts` |
| `tools/save_revision.md` | 工具「保存修订」登记时的总说明、工具清单里的一句话、用法要点与每个参数的说明（`agent/src/tools/save_revision.ts`） | 模型 | 无 | `agent/tests/texts_guard.test.ts` |
| `tools/search_knowledge.md` | 工具「查找知识库」登记时的总说明、工具清单里的一句话、用法要点与每个参数的说明（`agent/src/tools/search_knowledge.ts`） | 模型 | `search_knowledge.param.limit` 有 `{{max}}`、`{{default}}`（片段数的上限与缺省值，取自 `agent/src/lib/knowledge_search.ts`） | `agent/tests/texts_guard.test.ts`、`agent/tests/knowledge_search.test.ts` |
| `runtime/shared.md` | 页面与助手共用的句子：启动工作项、流程换站、接着做、删除工作项、范围说明、提议作废、活动做完（`agent/src/lib/stage.ts`），与「我已经看过了」那句（`agent/src/lib/user_ops.ts`；后端 `conversation.ts`、`executor.ts`，助手 `dialogue_acts.ts`，页面 `cardAnswer.ts` 按它的开头认出这句）。页面经生成的 `agent/src/lib/shared_texts.gen.ts` 读 | 模型与用户 | 见各段的用途一行（工作项与阶段的名字、条目清单、范围说明的原文等） | `agent/tests/texts_guard.test.ts`（另核对生成的表没有过期）、`agent/tests/stage.test.ts`、`agent/tests/user_ops.test.ts`、页面的对话区测试 |
| `runtime/stage_prompt.md` | 系统提示里的三段固定文字：会话空闲时的开头、单项活动代替节点出口的那一段、本次范围说明（`agent/src/lib/stage_prompt.ts` 的 IDLE_OPENING、STANDALONE_EXIT、scopeSection；后端的调试接口也用前两个） | 模型 | `stage_prompt.scope` 有 `{{scope}}`（用户写的范围说明） | `agent/tests/texts_guard.test.ts`、`agent/tests/stage_prompt.test.ts`、`backend/tests/activity_flow.test.ts`；拼好的系统提示在固定期望文件 `observatory_view.json` 里 |
| `runtime/ui_ops.md` | 用户在页面上做了一件事之后追加进会话的界面操作说明：改字段、删除、标为先不管、看过了、撤销、保留与撤销保留、启动与换站、接着做与删除工作项、发布、改评审规则（`agent/src/lib/user_ops.ts`），继续本阶段（`user_stage.ts`），改图（`user_diagram.ts`），点卡片与界面评审结束（`agent/src/hooks/user_commands.ts`）；以及后端替用户发的「我先不管」那句（`backend/src/executor.ts`，助手 `dialogue_acts.ts` 按它的开头认） | 模型 | 见各段的用途一行（条目编号、修订号、清单、字段内容等） | `agent/tests/texts_guard.test.ts`、`agent/tests/user_ops.test.ts`、`agent/tests/stage_continue.test.ts`、`agent/tests/user_diagram.test.ts`、`backend/tests/conversation.test.ts` 等 |

工具文件依赖随 pi 安装的包，单元测试里导入不了：工具登记时用对了哪些键，由守护测试的静态扫描核对；
模板里的文字由上表最后一栏的测试钉着，没有列测试的几份改动要有意为之。守护测试还核对每一份模板文件在本表里都列着。
