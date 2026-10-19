# 页面也用到的拒绝语

工具按阶段、按工作项拦下助手的写入时的拒绝语，出自 `agent/src/lib/stage.ts` 与 `agent/src/lib/overall_analysis.ts`；这两个文件页面也导入，
所以本文件同 `shared.md` 一样另由 `node scripts/render-shared-texts.mts` 生成进 `agent/src/lib/shared_texts.gen.ts`。

拒绝语的键就是原因码（前两段，例如 `gate.stage_item_write`）；第三段是只差情形的变体（`.idle` 空闲时、`.document` 编写文档阶段等），原因码相同。
键加 `.guide` 是指引层（给助手的「怎么办」）；变体没有自己的指引层时用原因码那一层的。以 `part.` 开头的是几种拒绝共用的半句，不是原因码。

## `part.forward_card`

用途：怎样提议进入下一段：用哪张卡片、两个选项怎样写（lib/stage.ts 的 forwardCardGuidance）。

请用请选择卡片提议，说清下一段要做什么，两个选项的键与文字是 {{enter_key}}「{{enter_text}}」、{{stay_key}}「{{stay_text}}」

## `part.back_card`

用途：怎样提议退回某个阶段：用哪张卡片、两个选项怎样写（lib/stage.ts 的 backCardGuidance）。

请用请选择卡片提议，在问句里写明为什么要退回，两个选项的键与文字是 {{back_key}}「{{back_text}}」、{{stay_key}}「{{stay_text}}」

## `part.leave_document`

用途：编写文档阶段被拦时怎么办：这一段只补写主题页的文字，要先回到前面的阶段。back_card 是 part.back_card 那一句。

编写文档阶段只补写主题页的文字。要做这件事，得先回到{{stage}}：{{back_card}}，由用户在卡片上点

## `part.leave_idle`

用途：会话空闲时被拦怎么办的后半句：启动哪一项活动由用户定，本会话里能做什么。

启动哪一项活动由用户决定：请用户从任务起点页启动一个工作项。本会话里你可以立主题页、改主题页、记问题条目

## `part.reach_writing`

用途：还没到写条目时怎样才能到。

进入写条目要由用户在卡片上选「{{start_items}}」：你可以先立页、请用户看，觉得理解够了就用请选择卡片提议

## `gate.stage_item_write.idle`

用途：会话空闲时助手要写别的集合（不是业务说明、也不是问题）的条目。op 是新增、修改、删除或写。

本会话不属于任何工作项，这时不能{{op}}「{{collection}}」的条目

## `gate.stage_item_write.idle.guide`

用途：上一条的指引。leave_idle 是 part.leave_idle 那一句。

「{{collection}}」的条目要在写条目这项活动里写。{{leave_idle}}

## `gate.stage_item_write.document`

用途：编写文档阶段助手要写别的集合的条目。

任务现在在{{stage}}阶段，这个阶段不能{{op}}「{{collection}}」的条目

## `gate.stage_item_write.document.guide`

用途：上一条的指引。leave_document 是 part.leave_document 那一句。

{{leave_document}}

## `gate.stage_item_write`

用途：写条目之前的阶段助手要写别的集合的条目。

任务现在在{{stage}}阶段，这个阶段不能{{op}}「{{collection}}」的条目

## `gate.stage_item_write.guide`

用途：上一条的指引。reach_writing 是 part.reach_writing 那一句。

「{{collection}}」的条目要到写条目阶段才能写。{{reach_writing}}

## `gate.stage_page_write.add`

用途：评审确认阶段助手要新立主题页。

任务现在在{{stage}}阶段，这个阶段不能新立主题页

## `gate.stage_page_write.delete`

用途：评审确认阶段助手要删除主题页。

任务现在在{{stage}}阶段，这个阶段不能删除主题页

## `gate.stage_page_write.fields`

用途：评审确认阶段助手改了主题页「状态」「改看」之外的字段。fields 是改到的其余字段（各加引号）。

任务现在在{{stage}}阶段，这个阶段主题页只能改「{{status}}」与「{{see_also}}」，这次还改了{{fields}}

## `gate.stage_page_write.guide`

用途：评审确认阶段动主题页被拦时的指引（三种情形同一句）。back_card 是提议退回澄清的 part.back_card 那一句。

要动主题页的内容，得先回到澄清或整理建模：{{back_card}}，由用户在卡片上点

## `gate.stage_diagram.idle`

用途：会话空闲时助手要画图、改图或删图。

本会话不属于任何工作项，这时不能画图、改图或删图

## `gate.stage_diagram.idle.guide`

用途：上一条的指引。

图要在整理建模这项活动里画。{{leave_idle}}

## `gate.stage_diagram.document`

用途：编写文档阶段助手要画图、改图或删图。

任务现在在{{stage}}阶段，这个阶段不能画图、改图或删图

## `gate.stage_diagram.document.guide`

用途：上一条的指引。

{{leave_document}}

## `gate.stage_diagram.reading`

用途：核读材料阶段助手要画图、改图或删图。

任务现在在{{stage}}阶段，这个阶段不能画图、改图或删图

## `gate.stage_diagram.reading.guide`

用途：上一条的指引：先提议进入澄清，再提议进入整理建模。forward 是从核读材料往前的 part.forward_card 那一句。

图要到整理建模阶段才能画。往前进入下一段要由用户在卡片上点，你只能提议：材料读完之后先提议进入澄清，{{forward}}；澄清告一段落之后，再照同样的办法提议「{{enter_modeling}}」

## `gate.stage_diagram`

用途：澄清阶段助手要画图、改图或删图。

任务现在在{{stage}}阶段，这个阶段不能画图、改图或删图

## `gate.stage_diagram.guide`

用途：上一条的指引。forward 是从澄清往前的 part.forward_card 那一句。

图要到整理建模阶段才能画。进入整理建模要由用户在卡片上选「{{enter_modeling}}」，你只能提议：澄清告一段落之后，{{forward}}

## `gate.stage_review.idle`

用途：会话空闲时助手要请求评审。

本会话不属于任何工作项，这时不能请求评审

## `gate.stage_review.idle.guide`

用途：上一条的指引。

评审要在写条目或评审确认这项活动里请求。{{leave_idle}}

## `gate.stage_review.document`

用途：编写文档阶段助手要请求评审。

任务现在在{{stage}}阶段，这个阶段不能请求评审

## `gate.stage_review.document.guide`

用途：上一条的指引。

{{leave_document}}

## `gate.stage_review`

用途：写条目之前的阶段助手要请求评审。

任务现在在{{stage}}阶段，评审要到写条目阶段才能请求

## `gate.stage_review.guide`

用途：上一条的指引。

条目写出来之后再评审。{{reach_writing}}

## `gate.stage_publish.idle`

用途：会话空闲时助手要发布版本。

本会话不属于任何工作项，这时不能发布版本

## `gate.stage_publish.idle.guide`

用途：上一条的指引。

发布版本要在评审确认或编写文档这项活动里做。{{leave_idle}}

## `gate.stage_publish.writing`

用途：写条目阶段助手要发布版本。

任务现在在{{stage}}阶段，发布版本要在评审确认阶段

## `gate.stage_publish.writing.guide`

用途：上一条的指引。forward 是从写条目往前的 part.forward_card 那一句。

条目写完之后，要由用户在卡片上选「{{enter_reviewing}}」进入评审确认，再发布版本。{{forward}}

## `gate.stage_publish`

用途：写条目之前的阶段助手要发布版本。

任务现在在{{stage}}阶段，发布版本要在评审确认阶段

## `gate.stage_publish.guide`

用途：上一条的指引。

要先写条目、再由用户进入评审确认，才能发布版本。{{reach_writing}}

## `gate.activity_done_not_single_activity.idle`

用途：回复里写了 activity_done，而会话空闲（不属于任何工作项）。

回复里写了 activity_done，而本会话不属于任何工作项，没有活动可以汇报做完

## `gate.activity_done_not_single_activity.idle.guide`

用途：上一条的指引。

去掉 activity_done 这一项再回复。启动哪一项活动由用户从任务起点页决定

## `gate.activity_done_not_single_activity`

用途：回复里写了 activity_done，而会话的工作项是工作流程。

回复里写了 activity_done，而本会话的工作项是工作流程，现在在{{stage}}阶段：这一项只在工作项是单项活动时用，流程里的阶段做完了不由你汇报

## `gate.activity_done_not_single_activity.guide`

用途：上一条的指引。next 是 part.done_forward 或 part.done_review。

去掉 activity_done 这一项再回复。{{next}}

## `part.done_forward`

用途：流程的工作项写了 activity_done 被拒时，这一段做完了怎样往前走。

这一段做完了要往前走，{{forward}}，由用户在卡片上点

## `part.done_review`

用途：编写文档阶段写了 activity_done 被拒时怎么办。

这一段做完了，照这一段的说明请用户过目

## `gate.overall_no_viewed_topic.none`

用途：业务说明的最低门过不去：一页主题都没有。

还没有用户看过的主题：业务说明里还没有一页主题

## `gate.overall_no_viewed_topic`

用途：业务说明的最低门过不去：还没有一页贴了标签、写了例子、用户又看过的主题。missing 是最接近的那一页差的几样（part.page_* 用「、」接起）。

还没有用户看过的主题：业务说明里还没有一页贴了标签、写了例子、用户又看过的主题（最接近的是 {{item}}，它{{missing}}）

## `gate.overall_no_viewed_topic.guide`

用途：最低门过不去时的指引（lib/overall_analysis.ts 的 GATE_GUIDANCE）。

先在业务说明里立一页主题、写一个例子，请用户打开那一页看一眼（看过就算确认），再写条目

## `part.page_no_tags`

用途：最低门里一页主题差的一样：还没有贴标签。

还没有贴标签

## `part.page_no_examples`

用途：最低门里一页主题差的一样：还没有例子。

还没有例子

## `part.page_unviewed`

用途：最低门里一页主题差的一样：用户还没有看过。

用户还没有看过

## `save_revision.overall_see_also_without_deprecated`

用途：保存业务说明的一页时，「改看」写了而这一页不是已废弃（overall_analysis.ts 的 pageProblems）。see_also、status、deprecated 是字段名与取值。

「{{see_also}}」写了 {{see}}，但这一页的{{status}}不是{{deprecated}}

## `save_revision.overall_see_also_without_deprecated.guide`

用途：上一条的指引。

「{{see_also}}」只在这一页不再用、由另一页取代时写：把{{status}}改成{{deprecated}}，或者去掉「{{see_also}}」

## `save_revision.overall_settled_without_source`

用途：保存业务说明的一页时，「已经定下的」某一条没有来源指到它。quoted 是那一条（长的只引前 20 字）。

「{{settled}}」的第 {{no}} 条「{{quoted}}」没有出处

## `save_revision.overall_settled_without_source.guide`

用途：上一条的指引。index 是那一条从 0 起的序号。

每一条已经定下的都要有出处：在它出自的那条来源的 supports 里写 {"field": "{{settled}}", "index": {{index}}}；是你补的就加一条助手补充的来源并写理由
