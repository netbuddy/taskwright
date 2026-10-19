# 提示词与运行时文字的索引

本目录放平台一级的全部文字：给助手（模型）读的说明、工具的说明，以及运行时由程序填值后发给助手或显示给用户的整句话。
平台一级的文字由产品工程改，现场只读；任务类型一级的文字在任务类型目录里（`task-types/<键>/.pi/skills/`），任务一级的由用户改。

每一份文字下面写四件事：拼在哪里（系统提示里的哪个部分，或者运行时的哪个地方）、谁读（模型、用户或两者）、
参数（模板里的 `{{名字}}`）、被哪些测试钉着。改了文字要跑这些测试；固定期望文件要跟着改的另外写明。

## 系统提示的几部分

有阶段的任务每次运行之前，扩展按这条会话的位置把系统提示整份换成拼好的一份（`agent/src/lib/context_assemble.ts`，
扩展的接线在 `agent/src/hooks/stage_prompt.ts`）。选段看三样输入：活动的头（方式、读、写）、获准能力表（`agent/src/lib/stage.ts` 的 `allowedWrites`）、
会话的位置（流程的工作项、单项活动的工作项、空闲）。各部分依次是：系统提示、本次会话的位置说明（程序生成）、平台说明里 when 是 always 的模块、
条件满足的模块（各按次序号）、活动模板、任务类型说明的共用部分、这一站在流程里的出口、任务类型说明里这项活动的补充、本次范围说明、
助手程序接在后面的工作目录等。拼不成（模块缺了、头不对、重名、次序号相同、模板或流程的节点不在）时这次运行停下并告诉用户，
不沿用以前拼好的任何一份。下表的「部分」一栏用这些名字。

| 文件 | 拼在哪里 | 谁读 | 参数 | 钉住它的测试 |
|---|---|---|---|---|
| `stages/system.md` | 系统提示（第一部分）；也是启动参数 `--system-prompt` 给的那一份（早先的任务用它） | 模型 | 无 | `agent/tests/stage_prompt_files.test.ts`、`agent/tests/skill_files.test.ts`、`agent/tests/context_assemble.test.ts`、`backend/tests/stage_prompt_rpc.test.ts`、`backend/tests/profiles.test.ts`；固定期望文件 `backend/tests/fixtures/expected/launch_argv.json` 与 `observatory_view.json` 里有它的全文 |
| `capabilities/<能力>/<模块>.md` | 平台说明的模块：七项能力（reading、analysis、organizing、writing、reviewing、dialogue、planning）各一个目录，一个文件一个模块，开头的头写 `name`、`order`、`when`（写法见 `agent/src/lib/prompt_modules.ts`）；同一条规矩只在一个模块里写 | 模型 | 无；`dialogue/understanding_full.md` 与 `understanding_brief.md` 里的理解格式说明由 `scripts/render-intent-schema.mjs` 从 `schemas/user_intent.schema.json` 生成 | `agent/tests/prompt_modules.test.ts`、`agent/tests/context_assemble.test.ts`、`agent/tests/stage_prompt_files.test.ts`、`agent/tests/skill_files.test.ts`、`agent/tests/dialogue_acts.test.ts`、`agent/tests/understanding_eval.test.ts` |
| `templates/reading.md`、`clarifying.md`、`modeling.md`、`writing.md`、`reviewing.md`、`document.md`、`idle.md` | 活动模板（「现在这个阶段」）：这项活动的工序与特有的做法；头写 `template`（模板的键）与 `writes_allowed`（这个模板允许的写入），`idle.md` 另写 `based_on: clarifying`，正文用澄清的模板去掉开头与出口 | 模型 | 无 | `agent/tests/stage_prompt_files.test.ts`、`agent/tests/context_assemble.test.ts` |
| `stages/reading.md`、`clarifying.md`、`modeling.md`、`writing.md`、`reviewing.md`、`document.md`、`publish.md` | 不拼：只有活动的头（`agent/src/lib/activity_def.ts` 读），文件名是活动的键 | 用户（活动的名字与说明） | 无 | `agent/tests/activity_def.test.ts` |
| `stages/README.md` | 不拼，写给改说明的人 | 人 | — | — |
| `flows/analysis.md` | 这一站在流程里的出口（每个节点一节，标题「# 节点：某阶段」）；文件头是流程的定义 | 模型；文件头里的名字与说明也显示给用户 | 无 | `agent/tests/stage_prompt_files.test.ts`、`agent/tests/context_assemble.test.ts`、`agent/tests/activity_def.test.ts` |
| `flows/change.md` | 现在只有流程的头，不拼进系统提示 | 用户（流程的名字与说明） | 无 | `agent/tests/activity_def.test.ts` |
| `schemas/user_intent.schema.json` | 不直接拼：扩展用它从助手的文字里认出理解（`agent/src/lib/structured_outputs.ts`），「先写理解」两个模块的格式说明由它生成 | 程序；生成的说明给模型 | — | `agent/tests/dialogue_acts.test.ts`、`agent/tests/stage_prompt_files.test.ts` |
| `review.md` | 评审者的系统提示（`agent/src/lib/review.ts`），不属于执行者的系统提示 | 模型（评审者） | 无 | `agent/tests/overall_review.test.ts` 与评审的测试 |

## 模板：`tools/` 与 `runtime/`

`tools/` 放工具的说明：每个工具一份，登记工具时读入（总说明、提示里的一句话、用法要点、每个参数的说明）。
`runtime/` 放运行时的文字：任务状况消息、界面操作说明、工具的拒绝语、工具做成时返回的话、位置说明、本次范围说明等。
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
| `runtime/stage_prompt.md` | 系统提示里程序生成的几段：本次会话的位置说明（在哪里、主要工作、获准的写入）与本次范围说明；拼不成而停下运行时写进会话给用户看的那一句（`agent/src/lib/context_assemble.ts`、`agent/src/hooks/stage_prompt.ts`） | 模型；停下运行的那一句给用户 | `stage_prompt.position` 有 `{{where}}`、`{{main}}`、`{{allowed}}`；`stage_prompt.scope` 有 `{{scope}}`；`stage_prompt.compose_failed` 有 `{{reason}}` | `agent/tests/texts_guard.test.ts`、`agent/tests/context_assemble.test.ts`；拼好的系统提示在固定期望文件 `observatory_view.json` 里 |
| `runtime/status.md` | 会话开始或续接时扩展写进会话的任务状况：现状、上次之后的变化、材料与分段、知识库一段、还在等回应的行为（`agent/src/lib/task_status.ts`）；后端 `conversation.ts` 由 `status.head_now`、`status.head_changes`、`status.change_by_executor` 生成正则、按 `status.open_acts` 的开头认，换成页面的说法 | 模型；页面换一道说法再显示 | 见各段的用途一行（时刻、任务名、条目数、材料路径与大小、知识库与文档等） | `agent/tests/texts_guard.test.ts`、`agent/tests/task_status.test.ts`、`agent/tests/task_status_knowledge.test.ts`、`backend/tests/task_status_display.test.ts` |
| `runtime/task_query.md` | 「查看条目」与「查询任务状态」返回给助手的文字：图的内容、条目末尾的修改提示、各集合的条目、未解决与未读、材料的分段、评审发现（`agent/src/lib/task_query.ts`） | 模型 | 见各段的用途一行 | `agent/tests/texts_guard.test.ts`、`agent/tests/read_tools_and_user_edit_source.test.ts`、`agent/tests/diagram_query.test.ts`、`agent/tests/pdf_materials.test.ts` 等 |
| `runtime/status_page.md` | 任务起点页与活动输入页上的说明（`backend/src/task_status.ts` 的 startPageTexts） | 用户 | `status_page.lead` 有 `{{task}}`（任务名） | `agent/tests/texts_guard.test.ts`、`backend/tests/task_status.test.ts` |
| `runtime/results.md` | 工具做成时交还模型的话：保存修订（`agent/src/lib/save_revision.ts`）、保存图（`agent/src/lib/save_diagram.ts`）、发布版本（`agent/src/lib/publish_version.ts`）、评审结果（`agent/src/lib/review_run.ts`）、回复送达与这一轮记下的行为（`agent/src/tools/reply.ts`、`agent/src/lib/dialogue_acts.ts`）；连续被拒到上限停下的那句（`agent/src/lib/rejection_limit.ts`）与兜底扩展追加的提醒（`agent/src/hooks/reply_fallback.ts`，后端按它认出这条消息，`backend/src/conversation.ts`） | 模型 | 见各段的用途一行（任务编号、修订号、条目编号、图的编号、版本号、评审的个数等） | `agent/tests/texts_guard.test.ts`、`agent/tests/save_revision.test.ts`、`agent/tests/save_diagram.test.ts`、`agent/tests/review.test.ts`、`agent/tests/rejection_limit.test.ts` 等 |
| `runtime/results_search_knowledge.md` | 查找知识库交还模型的话（`agent/src/lib/knowledge_search.ts`）：没有可查的、这一次没有做成、开头一句、每个片段的几行、裁剪的说明与末尾的说明 | 模型 | 见各段的用途一行（要找的话、知识库与文档的个数、片段的位置与出处等） | `agent/tests/texts_guard.test.ts`、`agent/tests/knowledge_search.test.ts` |
| `runtime/rejections_shared.md` | 按阶段、按工作项拦下助手的拒绝语（`agent/src/lib/stage.ts`：写条目、改主题页、画图、请求评审、发布版本、汇报活动做完、回复里停用的阶段参数）与业务说明的最低门（`agent/src/lib/overall_analysis.ts`）。页面经生成的 `shared_texts.gen.ts` 读 | 模型；事实层也显示给用户 | 见各段的用途一行（阶段名、集合名、卡片选项的键与文字等） | `agent/tests/texts_guard.test.ts`、`agent/tests/stage_save.test.ts`、`agent/tests/stage_diagram.test.ts`、`agent/tests/stage_review.test.ts`、`agent/tests/overall_gate.test.ts` 等 |
| `runtime/rejections_gate.md` | 守门的拒绝语：这一轮还没写理解（`agent/src/lib/dialogue_acts.ts`）、问题条目改状态要用户先点头（`agent/src/lib/problem_consent.ts`）、任务没有活动可以汇报做完（`agent/src/lib/stage_read.ts`） | 模型；事实层也显示给用户 | 见各段的用途一行 | `agent/tests/texts_guard.test.ts`、`agent/tests/dialogue_acts.test.ts`、`agent/tests/problem_consent.test.ts`、`agent/tests/rejection_limit.test.ts` |
| `runtime/rejections_save_revision.md` | 保存修订被拒（`agent/src/lib/save_revision.ts`）：整条拒绝语的开头、逐个操作的标签与最后一句，操作的形状、集合、条目编号、修订号、字段、来源指到的字段、问题条目的改法与状态；后端的过程摘要按开头、标签与「怎么办：」拆（`backend/src/work_summary.ts`），用户操作按原因的键认出修订过期（`agent/src/lib/user_ops.ts`） | 模型；页面上用户改条目时给用户（只取事实层） | 见各段的用途一行（操作序号、集合名、条目编号、修订号、字段名等） | `agent/tests/texts_guard.test.ts`、`agent/tests/save_revision.test.ts`、`agent/tests/user_ops.test.ts`、`backend/tests/conversation.test.ts` 等 |
| `runtime/rejections_source.md` | 来源核对的拒绝语（`agent/src/lib/save_revision.ts` 的 checkSources 及其下各函数，保存图也用）：来源的形状与种类、引用的条目与图、用户的话、材料与知识库文档的出处与摘录（文本、Word、PDF）、supports 的写法 | 模型；页面上用户改条目时给用户（只取事实层） | 见各段的用途一行（第几条来源、出处、摘录、段落号、页与块等） | `agent/tests/texts_guard.test.ts`、`agent/tests/save_revision.test.ts`、`agent/tests/docx_source.test.ts`、`agent/tests/pdf_source.test.ts`、`agent/tests/knowledge_sources.test.ts` 等 |
| `runtime/rejections_reply.md` | 回复被拒（`agent/src/lib/reply.ts`）：单独调用（`agent/src/lib/speak.ts`，用户 agent 的回应也用）、参数的形状、告知、要的回应五种各自的写法、点名的条目与修订号、连续被拒到第 3 次起只要成文正文 | 模型；事实层也显示给用户 | 见各段的用途一行（第几条、键名、种类的称呼、条目编号、修订号等） | `agent/tests/texts_guard.test.ts`、`agent/tests/reply.test.ts`、`agent/tests/reply_closed_question.test.ts`、`agent/tests/rejection_limit.test.ts` 等 |
| `runtime/rejections_save_diagram.md` | 保存图被拒（`agent/src/lib/save_diagram.ts`）：图的编号与修订号、图名、种类、说明、图里写的条目编号与来源、Mermaid 文本没有通过校验与到了上限；工具数连续几次没有通过校验、后端的过程摘要按开头认（`backend/src/work_summary.ts`） | 模型；页面上用户改图时给用户 | 见各段的用途一行（图的编号、修订号、字数上限、校验给的话等） | `agent/tests/texts_guard.test.ts`、`agent/tests/save_diagram.test.ts`、`backend/tests/save_diagram_tool.test.ts` 等 |
| `runtime/rejections_publish_version.md` | 发布版本被拒（`agent/src/lib/publish_version.ts`）：阶段、完成条件、用户同意、存档之后再核对、存档没有做成 | 模型；页面上发布时给用户 | 见各段的用途一行（版本号、修订号、选项的文字等） | `agent/tests/texts_guard.test.ts`、`agent/tests/completion_consent.test.ts`、`agent/tests/version_archive.test.ts`、`backend/tests/complete_consent.test.ts` |
| `runtime/rejections_request_review.md` | 请求评审被拒（`agent/src/lib/review.ts`）：参数、点名的条目、没有要评的 | 模型；页面上发起评审时给用户 | 见各段的用途一行 | `agent/tests/texts_guard.test.ts`、`agent/tests/review.test.ts`、`agent/tests/review_lifecycle.test.ts`、`agent/tests/stage_review.test.ts` |
| `runtime/rejections_get_item.md` | 查看条目被拒（`agent/src/lib/task_query.ts`）：条目或图不在、修订号不对 | 模型 | 见各段的用途一行 | `agent/tests/texts_guard.test.ts`、`agent/tests/read_tools_and_user_edit_source.test.ts`、`agent/tests/diagram_query.test.ts` |
| `runtime/rejections_search_knowledge.md` | 查找知识库的参数写得不对（`agent/src/lib/knowledge_search.ts`） | 模型 | `search_knowledge.limit_invalid` 有 `{{max}}`、`{{default}}` | `agent/tests/texts_guard.test.ts`、`agent/tests/knowledge_search.test.ts` |
| `runtime/ui_ops.md` | 用户在页面上做了一件事之后追加进会话的界面操作说明：改字段、删除、标为先不管、看过了、撤销、保留与撤销保留、启动与换站、接着做与删除工作项、发布、改评审规则（`agent/src/lib/user_ops.ts`），继续本阶段（`user_stage.ts`），改图（`user_diagram.ts`），点卡片与界面评审结束（`agent/src/hooks/user_commands.ts`）；以及后端替用户发的「我先不管」那句（`backend/src/executor.ts`，助手 `dialogue_acts.ts` 按它的开头认） | 模型 | 见各段的用途一行（条目编号、修订号、清单、字段内容等） | `agent/tests/texts_guard.test.ts`、`agent/tests/user_ops.test.ts`、`agent/tests/stage_continue.test.ts`、`agent/tests/user_diagram.test.ts`、`backend/tests/conversation.test.ts` 等 |

工具文件依赖随 pi 安装的包，单元测试里导入不了：工具登记时用对了哪些键，由守护测试的静态扫描核对；
模板里的文字由上表最后一栏的测试钉着，没有列测试的几份改动要有意为之。守护测试还核对每一份模板文件在本表里都列着。

## 拒绝语与原因码

工具的拒绝语放在 `runtime/rejections_*.md`。拒绝语的键就是原因码：前两段是哪个工具（共用的守门是 `gate`）与哪一种原因，
例如 `save_revision.collection_unknown`；第三段是只差情形的变体（`gate.stage_item_write.idle` 是会话空闲时那一种），原因码仍取前两段。
键加 `.guide` 是指引层（给助手的「怎么办」），变体没有自己的指引层时用原因码那一层的；以 `part.` 开头的是几种拒绝共用的半句，不是原因码。
代码用 `refusalText("键", {…})` 一次取原因码与两层文字，把原因码交给拒绝（`ToolRejection` 的最后一项）；拒绝记进任务库的
`tool_rejection` 表时，`reason_code` 存第一个原因码，`reason_codes` 存全部。守门类的原因码（`agent/src/lib/tool_rejection.ts` 的 `GATE_CODES`）
记作缺前置步骤（`gate`），别的记作输入不合规（`input`）；库打不开、没有任务记录、存档没有做成这些不是输入的问题，不记进表。
会话记录里的工具结果只存文字、不存原因码：要从会话记录里认出某一种拒绝的地方（数一次运行里连续被拒几次、数图连续几次没有通过校验、
后端的过程摘要），用 `textPattern` 或 `textPrefix` 从同一份模板取认法，不另写固定的句子；拿得到异常本身的地方认原因码。
观测台健康页的门禁统计按原因码数每百次调用被拒几次（`observatory/taskwright_observatory/health.py` 的 `reason_code_rows`）。

