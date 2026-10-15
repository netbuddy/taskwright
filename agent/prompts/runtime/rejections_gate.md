# 守门的拒绝语

缺了前置步骤时工具的拒绝：这一轮还没有写下对用户那句话的理解（`agent/src/lib/dialogue_acts.ts` 的 requireUnderstanding），
助手要改问题条目的状态而用户还没有在卡片上点头（`agent/src/lib/problem_consent.ts`），以及回复里写了 activity_done 而任务没有活动（`agent/src/lib/stage_read.ts`）。
阶段与工作项的守门在 `rejections_shared.md`。键的写法见那份文件的开头：键就是原因码，加 `.guide` 是指引层，`part.` 开头的是共用的半句。

## `gate.understanding_missing`

用途：这一轮一个理解的片段都没有写就调用了写入类的工具。label 是工具的中文名，said 是 part.user_said（用户的话为空时是空的）。

{{label}}没有执行：先按 schema 写下你对用户这句话的理解{{said}}。这一轮还没有写理解。

## `gate.understanding_missing.guide`

用途：上一条的指引。tool 是被拒的工具名。

请按平台说明「先写理解」一节的格式，在你的文字输出里写一个 JSON 对象，写下你对用户这句话的理解，写完接着调用 {{tool}}。

## `gate.understanding_invalid`

用途：这一轮写了 JSON 片段，但都不是合格的理解。which 是 part.understanding_recent 或 part.understanding_each，problems 是各片段的问题（带序号）。

{{label}}没有执行：先按 schema 写下你对用户这句话的理解{{said}}。这一轮写了 {{count}} 个 JSON 片段，都不是合格的理解。{{which}}的问题：{{problems}}。

## `gate.understanding_invalid.guide`

用途：上一条的指引。

请按平台说明「先写理解」一节的格式，在你的文字输出里写一个 JSON 对象，写下你对用户这句话的理解，写完接着调用 {{tool}}。

## `part.user_said`

用途：守门拒绝里引出用户那句原话（助手被拒几次之后容易忘了要理解的是哪一句）。

：「{{text}}」

## `part.understanding_recent`

用途：片段多于列出的几个时，只列最近几个。

最近 {{count}} 个

## `part.understanding_each`

用途：片段都列出时的说法。

各片段

## `part.ask_problem_resolved`

用途：要把问题条目改为「已解决」被拒时，怎样问用户（problem_consent.ts 的 askGuidance）。

请用回复的请选择（choose）问用户这个问题是否已解决：在 items 里点名 {{item}}，三个选项是「{{resolved}}」「{{continue}}」「{{keep}}」；用户点了「{{option}}」之后再把状态改为「{{status}}」。用户在对话里打字说已经解决不算，照样先发卡片

## `part.ask_problem_keep`

用途：要把问题条目改为「用户决定保留」被拒时，怎样问用户。

请用回复的请选择（choose）问用户这个问题是否已解决：在 items 里点名 {{item}}，三个选项是「{{resolved}}」「{{continue}}」「{{keep}}」；用户点了「{{option}}」之后再把状态改为「{{status}}」。用户在对话里打字说先不管不算，照样先发卡片

## `gate.problem_consent_missing`

用途：助手要改问题条目的状态，而用户还没有在问它是否已解决的卡片上点那一项。

助手想把 {{item}} 的状态改为「{{status}}」，但用户还没有在问 {{item}} 是否已解决的卡片上点「{{option}}」

## `gate.problem_consent_missing.guide`

用途：上一条的指引。ask 是 part.ask_problem_* 那一句。

{{ask}}

## `gate.problem_consent_wrong_option`

用途：用户在最近一张问是否已解决的卡片上选的是别的一项。

助手想把 {{item}} 的状态改为「{{status}}」，但用户在最近一张问 {{item}} 是否已解决的卡片上选的是「{{chosen}}」

## `gate.problem_consent_wrong_option.guide`

用途：上一条的指引。

{{ask}}

## `gate.problem_consent_stale`

用途：用户点头之后，问题条目或它牵涉的条目又改过。change 是「改到了修订 9」「在修订 9 删除了」这样的说法。

助手想把 {{item}} 的状态改为「{{status}}」，但用户点「{{option}}」之后，{{other}} 又{{change}}，要重新问

## `gate.problem_consent_stale.guide`

用途：上一条的指引。

{{ask}}

## `gate.problem_consent_batch_conflict`

用途：同一批操作里还改了问题条目牵涉的条目，用户点头时还没有这些改动。

助手想把 {{item}} 的状态改为「{{status}}」，但这一批操作里还改了它牵涉的 {{items}}，用户点「{{option}}」时还没有这些改动，要重新问

## `gate.problem_consent_batch_conflict.guide`

用途：上一条的指引。

先单独保存对 {{items}} 的修改；{{ask}}

## `gate.problem_new_status_direct`

用途：新增问题条目时状态直接写成了要用户点头的那两种之一。

新增的问题条目状态不能直接写成「{{status}}」

## `gate.problem_new_status_direct.guide`

用途：上一条的指引。unresolved 是这个集合里表示未解决的取值（加引号），集合里没有时是「未解决」三个字。

先按{{unresolved}}记下，用问这个问题是否已解决的卡片问过用户、用户点了「{{option}}」之后再改状态

## `gate.activity_done_not_single_activity.no_stages`

用途：回复里写了 activity_done，而这个任务没有阶段（或者库还不在）。

回复里写了 activity_done，而这个任务没有活动可以汇报做完

## `gate.activity_done_not_single_activity.no_stages.guide`

用途：上一条的指引。

去掉 activity_done 这一项再回复
