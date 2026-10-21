# 工具做成时返回给助手的话

写入与说话类工具做成时交还模型的文字：保存修订、保存图、发布版本、请求评审、回复；以及连续被拒到上限停下时的那句与兜底扩展追加的那句提醒。
查找知识库的结果在 `results_search_knowledge.md`；查看条目与查询任务状态的返回在 `task_query.md`。被拒时的文字在 `rejections_*.md`。

## `result.save_revision.saved`

用途：保存修订做成时的第一行（lib/save_revision.ts 的 savedText）。下面逐个操作一行。

已保存为任务 {{task}} 的修订 {{revision}}，一共 {{count}} 个操作：

## `result.save_revision.line_add`

用途：保存结果里一个新增操作的那一行。

{{no}}. 新增了条目 {{item}}（集合「{{collection}}」），{{item}} 现在是修订 {{revision}}。

## `result.save_revision.line_update`

用途：保存结果里一个修改操作的那一行。

{{no}}. 修改了条目 {{item}}（改前在修订 {{from}}），{{item}} 现在是修订 {{revision}}。

## `result.save_revision.line_restore`

用途：保存结果里一个恢复操作的那一行。

{{no}}. 恢复了条目 {{item}}，恢复成删除前的样子，{{item}} 现在是修订 {{revision}}。

## `result.save_revision.line_delete`

用途：保存结果里一个删除操作的那一行。

{{no}}. 删除了条目 {{item}}（删除前在修订 {{from}}）。

## `result.replayed`

用途：同一次调用重发、之前已经保存过时，补在第一次的结果后面的一句（保存修订与保存图共用）。

这次调用之前已经保存过，没有重复写入。

## `result.save_revision.sources_relabelled`

用途：只给 sources、不改字段的修改去掉了原来的几条来源时，写进结果的一句。removed 是去掉的几条（part.quote_label，用「、」接起）。

这次重新标注了 {{item}} 的来源，去掉了原来的 {{count}} 条：{{removed}}。

## `result.save_revision.locator_moved`

用途：Word 来源的摘录不在写的那一段、只在同一表格行的另一格里时，工具把出处改到那一段，写在保存结果末尾的一句。no 是第几个操作，where 是 part.source_no，from 是原来的出处，n 是改到的段落号。

第 {{no}} 个操作的{{where}}的出处 {{from}} 已改为 #p{{n}}：摘录「{{excerpt}}」在同一行的另一格里。

## `result.save_revision.stale_sources`

用途：执行者改写了的内容上还留着原来的来源时，写在保存结果末尾的提醒。parts 是哪几处的哪几条（result.save_revision.stale_part，用「；」接起）。

提醒：{{item}} 这次改写了的内容上还留着原来的来源：{{parts}}。它们如果已经不支持改后的内容，请对 {{item}} 做一次只给 sources、不改字段的修改，把要保留的来源全部重新写一遍，没写的就去掉。

## `result.save_revision.stale_part`

用途：提醒里的一处：哪几个字段（或字段的第几项）上的哪一条来源。

{{places}}上的{{source}}

## `result.save_revision.field_place`

用途：提醒里说到一个字段。

「{{field}}」

## `result.save_revision.field_item_place`

用途：提醒里说到字段的第几项。

「{{field}}」第 {{no}} 项

## `result.save_diagram.deleted`

用途：删除了一张图（lib/save_diagram.ts 的 savedText）。

已删除图 {{id}}「{{name}}」（删除记作它的修订 {{revision}}）。

## `result.save_diagram.saved`

用途：新画或修改了一张图。done 是 result.save_diagram.done_add 或 done_update；后面可能接着画了哪些条目、去掉了哪些来源。

已{{done}}图 {{id}}「{{name}}」（{{kind}}），现在是修订 {{revision}}。要再改这张图时 diagram 写 {{id}}、base_revision 写 {{revision}}。

## `result.save_diagram.done_add`

用途：新画一张图时「已……图」里的那个词。

保存

## `result.save_diagram.done_update`

用途：修改一张图时「已……图」里的那个词。

修改

## `result.save_diagram.drawn`

用途：图里画了几个条目。

图里画了 {{count}} 个条目：{{items}}。

## `result.save_diagram.dropped`

用途：改了 Mermaid 文本、有的条目不再画在图里时，它们的来源一并去掉了。

{{items}} 已经不在图里，它们的来源一并去掉了。

## `result.publish_version.published`

用途：发布了一版（lib/publish_version.ts）。kept 是 result.publish_version.kept_* 之一。

第 {{version}} 版已发布：完成条件 {{conditions}} 条全部满足，发布的是修订 {{revision}}，{{kept}}。发布之后任务照常可以修改，以后再发布新的一版。

## `result.publish_version.kept_both`

用途：这一版的文档存了两份。

生成的文档存了 Markdown 与 Word 两份

## `result.publish_version.kept_one`

用途：这一版的文档存了一份。

生成的文档存了一份

## `result.publish_version.kept_none`

用途：这一版没有存文档。

这一版没有存文档

## `result.review.summary`

用途：评审做完时给调用方的第一行（lib/review_run.ts 的 summaryText）。下面每个条目一行。

评审了 {{count}} 个条目：合规 {{passed}} 个，不合规 {{failed}} 个，评审未完成 {{unfinished}} 个。

## `result.review.unfinished_line`

用途：一个条目评审未完成时的那一行。

{{item}}（修订 {{revision}}）：评审未完成（{{reason}}），没有记下合规与否，可以稍后再评审。

## `result.review.line`

用途：一个条目评完时的那一行。status 是 result.review.status_*。

{{item}}（修订 {{revision}}）：{{status}}。

## `result.review.status_passed`

用途：合规而没有建议。

合规

## `result.review.status_passed_advice`

用途：合规，另有几条建议。

合规（建议 {{advice}} 条）

## `result.review.status_failed`

用途：不合规。

不合规（问题 {{problems}} 处，建议 {{advice}} 条）

## `result.reply.delivered`

用途：回复送达而没有另外要说的（tools/reply.ts）。

回复已送达

## `result.reply.delivered_with`

用途：回复送达，后面接这一轮记下的行为等几句（result.reply.acts 等，lib/dialogue_acts.ts 拼好的）。

回复已送达。{{recorded}}

## `result.reply.acts`

用途：这一轮记下了哪几条对话行为（lib/dialogue_acts.ts 的 recordReplyActs）。acts 是 result.reply.act，用「、」接起。

本轮记了 {{acts}}。

## `result.reply.act`

用途：记下的一条对话行为：编号、功能的中文名与摘要。

{{id}}（{{function}}：{{summary}}）

## `result.reply.resend`

用途：这张卡片是先前那一张的重发。

{{id}} 是 {{resends}} 的重发，{{resends}} 不再等回应。

## `result.reply.responds_to`

用途：这一轮有要用户回应的卡片时，提醒下一轮理解里写哪个编号。

用户回应时，你下一轮理解里的 responds_to 写 {{id}}。

## `result.stopped`

用途：这一轮连续被拒到上限、工具停下这次运行时，接在拒绝原因后面的话（lib/rejection_limit.ts）。模型此后不会再被请求，这句话留在会话记录里给人看。

这一轮已经连续 {{limit}} 次没有按规矩回答，这次运行到此停下。

## `result.reply_fallback`

用途：一次运行没有以一次成功的回复收尾时，兜底扩展追加给助手的那句话（hooks/reply_fallback.ts）。后端按它认出这条消息，给页面换成系统说明（backend/src/conversation.ts）。

请用 reply 工具把要对用户说的话发出来

## `result.activity_segment`

用途：工具做成的结果后面附上活动补充里这一步要用的那一段时，段前的一句（lib/activity_segments.ts）。上面一行是固定的分段记号，观测台据此把它与工具本身的结果分开。

以下是这项活动接下来要用的规则，平台只在这条会话里附这一次，照它做：
