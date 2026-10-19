# 回复的拒绝语

回复（`agent/src/lib/reply.ts` 的 checkReply 与 decideReply）不合格时的拒绝：一次回复里逐条列出哪里不对，前面一句、给模型的指引另起一行写「怎么办：」（`part.save_guidance`）。
单独调用的核对（`agent/src/lib/speak.ts` 的 requireAlone）也在这里，用户 agent 的「回应」（`sim/tools/respond.ts`）共用它。
给建议值的依据按来源核对同一套规则（`rejections_source.md`），只在没有接任务目录时（单元测试）用这里的 `reply.basis_*` 几句核对形状。
阶段参数停用与汇报活动做完的拒绝在 `rejections_shared.md`。键的写法见那份文件的开头。

## `part.reply_head`

用途：回复被拒时给模型的正文的第一行。

这次回复的形式不对，没有送达。请按下面几处改好后重新单独调用 reply：

## `part.reply_fact_head`

用途：回复被拒时事实一层的第一行（记进拒绝记录）。

这次回复的形式不对，没有送达：

## `part.reply_guide_head`

用途：回复被拒时指引一层的第一行（记进拒绝记录）。

请按这几处改好后重新单独调用 reply

## `part.broken_key_hint`

用途：键名里带着引号、冒号或空白时接在拒绝理由后面的半句（多半是模型把 JSON 写坏了）。

；这个键名里带着引号、冒号或空白，像是 JSON 写坏了，请把整个 act 重新写一遍，键名里只写字母

## `part.kind_ask`

用途：拒绝理由里怎样称呼提问。

提问（ask）

## `part.kind_confirm`

用途：拒绝理由里怎样称呼请确认。

请确认（confirm）

## `part.kind_suggest`

用途：拒绝理由里怎样称呼给建议值。

给建议值（suggest）

## `part.kind_choose`

用途：拒绝理由里怎样称呼请选择。

请选择（choose）

## `part.kind_propose`

用途：拒绝理由里怎样称呼提议。

提议（propose）

## `part.inform_where`

用途：拒绝理由里说到第几条告知。

informs 的第 {{no}} 条

## `part.list_item_where`

用途：拒绝理由里说到某个列表（act.items、某条告知的 items）的第几项。

{{label}} 的第 {{no}} 项

## `part.basis_where`

用途：拒绝理由里说到给建议值的第几条依据。

act.basis 的第 {{no}} 条

## `part.preview_where`

用途：拒绝理由里说到提议预览的第几项。

act.preview 的第 {{no}} 项

## `part.now_at`

用途：点名的修订号不是条目当前所在的修订时，补上它现在在哪个修订。

，它现在是修订 {{revision}}

## `reply.not_alone`

用途：说话类工具（回复、用户 agent 的回应）与别的工具在同一轮里调用了。label 是工具的中文名，tool 是工具名，others 是同一轮的其余工具名。

{{label}}必须单独调用，不能与其他工具同一轮。这一轮里除了{{label}}还调用了：{{others}}

## `reply.not_alone.guide`

用途：上一条的指引。

请先把那些工具调用完、看到结果之后，再在下一次单独调用 {{tool}}。这次{{label}}没有送达

## `reply.params_not_object`

用途：回复的参数不是一个对象。

回复的参数应当是一个对象，有 informs、act、text 三项。这次回复没有送达。

## `reply.extra_key`

用途：回复里多了不认识的一项。hint 是 part.broken_key_hint（键名正常时为空）。

多了「{{key}}」这一项，回复只有 informs、act、text 三项{{hint}}

## `reply.activity_done_invalid`

用途：activity_done 写的不是 true、false 或 null。

activity_done 只能写 true 或 false：本会话的工作项是单项活动、这项活动做够了、要汇报做完时写 true，别的时候不写

## `reply.informs_missing`

用途：回复里没有 informs。

缺少 informs；没有要告知的事时写空列表 []

## `reply.informs_not_list`

用途：informs 不是列表。

informs 应当是一个列表，每条是 { text, items }

## `reply.text_missing`

用途：回复里没有成文的话。

缺少 text，或者 text 全是空白；text 是给用户读的成文的话，必须写

## `reply.act_missing`

用途：回复里没有 act。

缺少 act；你不等用户回应时写 null

## `reply.act_echoes_inform`

用途：卡片上的话只是把某条告知再说一遍。

卡片里写的是你刚说过的话，不是要用户回应的东西；不需要用户回应就把 act 写 null，要回应就把要用户回答的那句话写进 act

## `reply.inform_empty`

用途：一条写成纯文字的告知是空的。where 是 part.inform_where。

{{where}}是空的，每条告知都要是一句完整的话

## `reply.inform_not_object`

用途：一条告知既不是文字也不是对象。

{{where}}应当是 { text, items }，text 是一句完整的话

## `reply.inform_extra_key`

用途：一条告知里多了不认识的一项。

{{where}}里多了「{{key}}」这一项，告知只有 text 与 items 两项{{hint}}

## `reply.inform_text_empty`

用途：一条告知的 text 是空的或者不是文字。

{{where}}的 text 是空的或者不是文字，每条告知都要是一句完整的话

## `reply.act_not_object`

用途：act 既不是 null 也不是对象。

act 应当是 null 或者一个对象

## `reply.act_broken_key`

用途：act 里有一个写坏的键名。

act 里有一个键名写成了「{{key}}」{{hint}}

## `reply.act_kind_invalid`

用途：act.kind 不是五种之一。

act.kind 写的是 {{given}}，只能是 {{kinds}} 五者之一

## `reply.act_key_not_for_kind`

用途：act 里写了只属于别的几种的一项。name 是这一种的称呼，owners 是那一项所属的几种。

{{name}}不写 act.{{key}}；{{key}} 只属于{{owners}}

## `reply.act_extra_key`

用途：act 里多了不认识的一项。

act 里多了「{{key}}」这一项，act 只有 kind、text、items、options、value、basis、preview、resends 这几项

## `reply.act_text_empty`

用途：act.text 是空的。

act.text 是空的；{{name}}要写明问的、请确认的、建议的或提议的是什么

## `reply.ask_closed_question`

用途：提问写成了是非题或者征求同意的话（字面规则，见 lib/reply.ts 的 closedQuestion）。said 是那句问话（长的只引前 40 字）。

提问（ask）写的是一句是非题或者征求同意的话：「{{said}}」

## `reply.ask_closed_question.guide`

用途：上一条的指引。末尾那半句是给确实是开放问题、只是用了这些词的问句留的路。

是非题用请选择，征求同意用提议，把答案写成按钮；提问只给开放问题。确是开放问题的，把问句改写成不带这些词的形式

## `reply.ask_many_questions`

用途：一张提问卡片问了不止一件事：点名的问题条目多于一个，或者正文里有两个以上序号起头的分句、两个以上问号（lib/reply.ts 的 askedCount）。count 是问了几件。

这张提问卡片问了 {{count}} 件事

## `reply.ask_many_questions.guide`

用途：上一条的指引。

一次只问一条：先用告知列出全部问题条目（items 写它们的编号），再用提问只问第一条；用户答完改条目再问下一条

## `reply.resends_blank`

用途：act.resends 写了但是空的。

act.resends 写了就应当是原来那张卡片的行为编号（例如 r3-2）；这张卡片不是重发的就不写这一项

## `reply.resends_not_open`

用途：act.resends 指的不是一张还开着、可以重发的卡片。why 是原因（lib/dialogue_acts.ts 的 resendFact）。

act.resends 写的是 {{given}}，{{why}}

## `reply.resends_kind_mismatch`

用途：重发的卡片与原来那张不是同一种。

act.resends 写的 {{given}} 是{{was}}，这次发的是{{name}}；重发要与原来那张是同一种

## `reply.scope_invalid`

用途：act.scope 写的不是 "general"。

act.scope 写的是 {{given}}，只能写 "general"（表示与任何条目都无关），或者不写

## `reply.scope_general_with_items`

用途：act.scope 写了 "general"，又在 items 里点名了条目。

act.scope 写了 "general"，表示与任何条目都无关，就不要再在 items 里点名条目；二者只能选一个

## `reply.items_missing.confirm`

用途：请确认没有点名条目。

请确认（confirm）要写 act.items，点名要确认的是哪几个条目，每项是 { item_id, revision_no }，revision_no 写条目当前所在的修订

## `reply.items_missing`

用途：提问、给建议值或提议没有点名条目，也没有写 scope: "general"。what 是提问、建议或提议，verb 是问或说，unrelated 是问题或建议、提议。

{{what}}要写明{{verb}}的是哪个条目或问题条目：在 act.items 里点名，每项是 { item_id, revision_no }，revision_no 写它当前所在的修订；与条目无关的{{unrelated}}请写 scope: "general"

## `reply.options_too_few`

用途：请选择的选项不到两个。

请选择（choose）要写 act.options，至少两个选项，每项是 { key, text }

## `reply.option_incomplete`

用途：请选择的某个选项缺 key 或 text。

act.options 的第 {{no}} 项要有不为空的 key 与 text

## `reply.option_key_duplicate`

用途：请选择的两个选项 key 相同。

act.options 里的 key「{{key}}」重复了，每个选项的 key 要不一样

## `reply.suggest_value_missing`

用途：给建议值没有写建议的值。

给建议值（suggest）要写 act.value，也就是你建议的那个值

## `reply.suggest_basis_missing`

用途：给建议值没有写依据。

给建议值（suggest）要写 act.basis，至少一条依据，每条是 { kind, locator, excerpt }

## `reply.basis_supplement_no_reason`

用途：没有接任务目录时核对依据的形状：种类是助手补充而没有写理由。

{{where}}的种类是「{{kind}}」，没有写理由：在 excerpt 里写一句为什么这样补、依据的是什么常识或推断

## `reply.preview_not_list`

用途：提议的 preview 写了但不是不为空的列表。

act.preview 写了就应当是一个不为空的列表，每项是 { effect, text }

## `reply.preview_item_not_object`

用途：预览的某一项不是对象。where 是 part.preview_where。

{{where}}应当是一个对象，有 effect 与 text 两项

## `reply.preview_effect_invalid`

用途：预览某一项的 effect 不是 remove、add、change 之一。

{{where}}的 effect 写的是 {{given}}，只能是 {{effects}} 之一

## `reply.preview_text_empty`

用途：预览某一项的 text 是空的。

{{where}}的 text 是空的

## `reply.items_not_list`

用途：一串条目点名写了但不是列表。label 是 act.items 或某条告知的 items。

{{label}}写了就应当是一个列表，每项是 { item_id, revision_no }

## `reply.item_id_missing`

用途：点名的某一项没有写条目编号。where 是 part.list_item_where。

{{where}}要写 item_id（条目编号，例如 UC-001）

## `reply.item_revision_missing`

用途：点名的某一项没有写修订号。

{{where}}（{{item}}）缺少 revision_no；写这个条目当前所在的修订号

## `reply.item_revision_invalid`

用途：点名的某一项修订号不是从 1 起的整数。

{{where}}（{{item}}）的 revision_no 应当是一个从 1 起的整数，现在写的是 {{given}}

## `reply.no_database`

用途：点名了条目，而任务目录里还没有库。

这个任务目录还没有任务数据库，库里没有任何条目，没有东西可以点名

## `reply.item_not_found`

用途：点名的条目在库里没有。

{{where}}：库里没有条目 {{item}}

## `reply.item_deleted`

用途：点名的条目已经删除。

{{where}}：条目 {{item}} 已经删除了，不能再点名它

## `reply.item_revision_not_current`

用途：点名的修订号不是条目当前所在的修订。now 是 part.now_at（查不到当前修订时为空）。

{{where}}：条目 {{item}} 现在不是修订 {{revision}}{{now}}；只能点名条目当前所在的修订

## `reply.plain_text_only`

用途：这一次运行里「回复」连续第 3 次起没有送达，给模型的正文。previous 是上一次拒绝的全文。

这是这一次回应里「回复」连续第 {{attempt}} 次没有送达。请不要再写告知与要的回应：只写成文的话 text，informs 写 []，act 写 null，单独调用 reply。上一次的问题是：
{{previous}}

## `part.plain_text_only_fact`

用途：连续第 3 次起没有送达时事实一层（记进拒绝记录）。previous 是上一次拒绝的事实。

「回复」连续第 {{attempt}} 次没有送达。{{previous}}

## `part.plain_text_only_guide`

用途：连续第 3 次起没有送达时指引一层（记进拒绝记录）。

不要再写告知与要的回应：只写成文的话 text，informs 写 []，act 写 null，单独调用 reply
