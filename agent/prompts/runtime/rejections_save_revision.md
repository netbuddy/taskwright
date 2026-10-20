# 保存修订的拒绝语

「保存修订」（save_revision）与页面上直接修改被拒时的文字（`agent/src/lib/save_revision.ts`）。键的写法见 `rejections_shared.md` 的开头。
一次保存被拒时逐个操作列原因：每个操作一行事实、一行指引，前后各有一句（`part.save_head`、`part.save_tail`）；后端的过程摘要按这几句的写法拆（`backend/src/work_summary.ts`）。
来源的核对在 `rejections_source.md`；按阶段与工作项拦的在 `rejections_shared.md`。

## `part.save_head`

用途：保存修订被拒时整条拒绝语的第一行。

这次「保存修订」什么都没有写入，因为有 {{count}} 个操作不对：

## `part.save_guidance`

用途：拒绝语里一个操作的指引那一行（代码在前面缩进两格）。

怎么办：{{guidance}}。

## `part.save_tail`

用途：保存修订被拒时整条拒绝语的最后一句。

请把这些地方改正之后，把整批操作重新提交一次。

## `part.op_label`

用途：拒绝语里一个操作的标签：操作不是对象、种类不对时。

操作 {{no}}

## `part.op_add`

用途：拒绝语里操作的称呼：新增。

新增

## `part.op_update`

用途：拒绝语里操作的称呼：修改。

修改

## `part.op_delete`

用途：拒绝语里操作的称呼：删除。

删除

## `part.op_restore`

用途：拒绝语里操作的称呼：恢复。

恢复

## `part.actor_user`

用途：修订过期的拒绝语里，改动那一版的是用户。

用户

## `part.actor_executor`

用途：修订过期的拒绝语里，改动那一版的是助手（拒绝语的事实一层也给人看，所以执行者写作「助手」）。

助手

## `part.op_label_add`

用途：拒绝语里一个新增操作的标签。

操作 {{no}}（新增，集合「{{collection}}」）

## `part.op_label_item`

用途：拒绝语里一个修改、删除或恢复操作的标签。op 是操作的中文名。

操作 {{no}}（{{op}}，条目 {{item}}）

## `part.subject_add`

用途：一个新增操作的几条原因里都没有点到条目时，补在前面的主语。

新增到「{{collection}}」的条目

## `part.subject_join`

用途：一个操作的事实层里没有点到主语时，主语与事实之间的写法。

{{subject}}：{{fact}}

## `save_revision.no_database`

用途：任务目录里还没有任务库。不是输入的问题，不记进拒绝表。

这个任务目录里还没有任务记录，所以没有地方保存修订，什么都没有写入。任务由用户在界面上创建，你没有创建任务的工具；请把这个情况如实告诉用户。

## `save_revision.no_task`

用途：库里没有任务记录。不是输入的问题，不记进拒绝表。

库里没有任务记录，所以没有地方保存修订，什么都没有写入。请把这个情况如实告诉用户。

## `save_revision.several_tasks`

用途：库里有不止一个任务。不是输入的问题，不记进拒绝表。

这个任务目录里有 {{count}} 个任务（{{ids}}），同一时刻只应当有一个，库里的记录有问题，所以没有写入。请把这个情况告诉用户。

## `save_revision.operations_empty`

用途：operations 不是不为空的列表。

operations 应当是一个不为空的操作列表，现在不是，所以什么都没有写入。每个操作是新增、修改、删除三种之一，例如 { "op": "add", "collection": "集合名", "fields": { … }, "sources": [ … ] }。

## `save_revision.op_not_object`

用途：一个操作不是对象。

操作 {{no}}：它应当是一个对象，现在不是

## `save_revision.restore_by_assistant`

用途：助手用了只给用户撤销用的恢复操作。

助手用了恢复操作（restore），它只给用户在界面上的撤销用

## `save_revision.restore_by_assistant.guide`

用途：上一条的指引。

要改条目请用 update

## `save_revision.op_kind_invalid`

用途：操作的种类写得不对。given 是写的值（JSON）。

操作 {{no}} 的种类写成了 {{given}}

## `save_revision.op_kind_invalid.guide`

用途：上一条的指引。

op 只能是 "add"（新增）、"update"（修改）、"delete"（删除）之一

## `save_revision.collection_unknown`

用途：新增时写的集合不存在。

没有名叫「{{collection}}」的集合

## `save_revision.collection_unknown.guide`

用途：上一条的指引。collections 是可用的集合（各加引号）。

可用的集合是：{{collections}}

## `save_revision.add_item_given`

用途：新增时写了 item。

新增时不要写 item，条目编号由工具生成

## `save_revision.add_fields_not_object`

用途：新增时 fields 不是对象。

fields 应当是一个对象，键是字段名，值是字段内容

## `save_revision.required_field_empty`

用途：新增时必填字段没有填。

必填字段「{{field}}」没有填或者是空的

## `save_revision.add_base_revision_given`

用途：新增时写了 base_revision。

新增时不要写 base_revision，新条目还没有所在的修订

## `save_revision.item_id_missing`

用途：修改、删除时没有写条目编号。op 是操作的中文名。

助手要{{op}}条目，但没写是哪个条目

## `save_revision.item_id_missing.guide`

用途：上一条的指引。

item 应当写要{{op}}的条目编号，例如 UC-001

## `save_revision.item_not_found`

用途：修改、删除时写的条目不存在。

这个任务里没有条目 {{item}}

## `save_revision.item_not_found.guide`

用途：上一条的指引。alive 是现有的条目，一个都没有时是 part.no_items。

现有的条目是：{{alive}}

## `save_revision.restore_not_deleted`

用途：要恢复的条目没有被删除。

{{item}} 没有被删除，不需要恢复

## `save_revision.item_already_deleted`

用途：要修改或删除的条目已经删除了。

助手想{{op}} {{item}}，但它已在修订 {{revision}} 删除

## `save_revision.item_duplicate_in_batch`

用途：同一次保存里一个条目出现了两次。

同一次保存里 {{item}} 出现了两次（操作 {{at}} 已经处理了它）

## `save_revision.item_duplicate_in_batch.guide`

用途：上一条的指引。

一个条目在一次调用里只能有一个操作

## `save_revision.base_revision_missing`

用途：修改、删除时没有写 base_revision。

助手{{op}} {{item}} 时没写它看到的是哪次修订

## `save_revision.base_revision_missing.guide`

用途：上一条的指引。

修改与删除时要写 base_revision，也就是你所见的这个条目当前所在的修订号（整数），它写在「保存修订」的返回与界面操作的通知里（「UC-001 现在是修订 N」）

## `save_revision.base_revision_invalid`

用途：base_revision 不是从 1 起的整数。given 是写的值（JSON）。

助手{{op}} {{item}} 时写的修订号 {{given}} 不对

## `save_revision.base_revision_invalid.guide`

用途：上一条的指引。

base_revision 应当是一个从 1 起的整数

## `save_revision.base_revision_stale.older`

用途：助手看到的修订已经被别人改过了。actor 是改它的一方（用户、助手）。

{{item}} 已经被{{actor}}改到修订 {{now}}，助手看到的还是修订 {{seen}}

## `save_revision.base_revision_stale`

用途：助手写的修订号比条目现在所在的修订还新。

{{item}} 现在是修订 {{now}}，助手写的修订 {{seen}} 不是它当前所在的修订

## `save_revision.base_revision_stale.guide`

用途：修订号对不上时的指引（两种情形同一句）。fields 是它现在的内容（JSON）。

请先读最新内容再改。它在修订 {{now}} 的内容是：{{fields}}

## `save_revision.update_fields_not_object`

用途：修改时 fields 不是对象。

fields 应当是一个对象，只写要改的字段

## `save_revision.required_field_cleared`

用途：修改把必填字段改空了。

必填字段「{{field}}」改完之后是空的，必填字段不能清空

## `save_revision.update_sources_missing`

用途：修改之后条目一条来源也没有了。

{{item}} 改完之后一条来源也没有

## `save_revision.update_sources_missing.guide`

用途：上一条的指引。

请在这个操作里给出 sources，每个条目至少一条来源

## `save_revision.update_noop`

用途：修改与原来的内容和来源完全一样。

助手对 {{item}} 的修改与它在修订 {{revision}} 的内容和来源完全一样，没有改动任何东西

## `save_revision.update_noop.guide`

用途：上一条的指引。

不需要改就去掉这个操作

## `save_revision.overall_intro_duplicate`

用途：业务说明里一章已经有一页在用的导语页。

「{{chapter}}」这一章已经有一页在用的导语页：{{owners}}

## `save_revision.overall_intro_duplicate.guide`

用途：上一条的指引。

一章只立一页导语页，请改那一页，不要另立

## `save_revision.overall_intro_duplicate_in_batch`

用途：同一批里前面的操作已经给这一章新增了一页导语页。ops 是那几个操作的序号，owners 是它们新增后会得到的编号（还没有存进库）。

「{{chapter}}」这一章的导语页，这一批里第 {{ops}} 个操作已经在新增（新增后编号会是 {{owners}}；这一批被拒，它还没有存进库，查看条目查不到）

## `save_revision.overall_intro_duplicate_in_batch.guide`

用途：上一条的指引。

一章只立一页导语页：这一批里只让一页当这一章的导语页，别的页讲的是这一章里的内容，不当导语页

## `save_revision.intro_page_not_now`

用途：编写文档之外的位置（空闲也算）新增导语页、把一页改成导语页，或者改既有导语页的字段。只把既有导语页停用（status_field 改为 deprecated）不拦。stage 是会话现在的位置；intro_field、status_field、deprecated 是那几个字段名与取值。

现在在{{stage}}，不能新立导语页，也不能改既有导语页（「{{intro_field}}」有值的页）

## `save_revision.intro_page_not_now.guide`

用途：上一条的指引。

导语页在编写文档时写；这一页讲的内容不填「{{intro_field}}」照常立页。要停用一页既有导语页，只把它的「{{status_field}}」改成「{{deprecated}}」，别的字段不动

## `save_revision.page_needs_tag_and_example`

用途：核读材料时新增或改动的页缺了 tags 或 examples 那一栏（只查新增的页与这次传入的这两个字段）。tags、examples 是两个字段名，missing 是缺的那几个（各加引号）。

{{stage}}时立的页至少要贴一个「{{tags}}」、写一项「{{examples}}」（反例、例外也算），这一页缺{{missing}}

## `save_revision.page_needs_tag_and_example.guide`

用途：上一条的指引。

「{{tags}}」拿不准就贴最接近的一个，并在问题条目里记一句为什么拿不准；「{{examples}}」没有现成的，写材料里的一个具体情形或反例并给来源；材料里确实没有时，写一条你推断的情形，来源种类写「助手补充」并写理由（自动待核实）

## `save_revision.page_sentence_ungrounded`

用途：核读材料时写进页的正文有句子没有着落（句末没有括注，也不以「这意味着」「由此看」起头）。what 是正文那个字段名，count 是这样的句子有几句，sentences 是前三句（各加引号、过长的截断）。

{{stage}}时页的「{{what}}」每一句都要有着落：句末括注出处（材料简称加页码或段落号，或者「（你）」），或者以「这意味着」「由此看」起头的推断；这一页有 {{count}} 句没有：{{sentences}}

## `save_revision.page_sentence_ungrounded.guide`

用途：上一条的指引。

给这几句补上句末括注；写不出出处的，要么改写成以「这意味着」起头的推断，要么删掉。材料没写的事不进正文，记成问题条目

## `save_revision.problem_edit_restricted`

用途：问题条目写下之后改了只能改的几个字段之外的字段。fields 是改到的字段（各加引号），editable 是能改的字段。

助手想改 {{item}} 的{{fields}}，但问题条目写下后只能改{{editable}}

## `save_revision.problem_edit_restricted.guide`

用途：上一条的指引。

用户的回答要写进它牵涉的条目（关联条目里列的那些），改完再问用户这个问题是否已解决

## `save_revision.problem_not_blocking_needs_revisit`

用途：问题条目写了不阻断，却没有写何时回看。

「{{blocking}}」写的是「{{not_blocking}}」，「{{revisit}}」却没有写

## `save_revision.problem_not_blocking_needs_revisit.guide`

用途：上一条的指引。

不阻断的问题是推后再看的，请在「{{revisit}}」里写什么时候回来看它，例如「评审确认时」

## `save_revision.problem_resolved_needs_landed`

用途：问题条目改成已解决，却没有写落实到哪里。

状态改成了「{{resolved}}」，「{{landed}}」却没有写

## `save_revision.problem_resolved_needs_landed.guide`

用途：上一条的指引。

请在「{{landed}}」里写这个问题的答案写进了哪里：页、条目或图的编号加一句话，例如「OA-006 已经定下的第 2 条：保留期遇闭馆日顺延」

## `part.changed_to`

用途：问题条目点头之后，它或它牵涉的条目又改过的说法（接在 gate.problem_consent_stale 里）。

改到了修订 {{revision}}

## `part.deleted_at`

用途：问题条目点头之后，它牵涉的条目又被删除的说法。

在修订 {{revision}} 删除了

## `save_revision.field_unknown`

用途：集合没有这个字段。fields 是可用的字段（各加引号）。

集合「{{collection}}」没有字段「{{field}}」，可用的字段是{{fields}}

## `save_revision.field_ref_not_array`

用途：条目引用字段写的不是数组。given 是写的值（JSON）。

字段「{{field}}」是条目引用类型，应当写成条目编号的数组，例如 ["UC-001"]；现在写的是 {{given}}，只有一个编号也要放进数组里，不关联任何条目就写 []

## `save_revision.field_ref_over_single`

用途：只许一个编号的条目引用字段写了好几个。

字段「{{field}}」最多写一个条目编号，现在写了 {{count}} 个

## `save_revision.field_ref_over_single.guide`

用途：上一条的指引。

只留一个

## `part.field_ref`

用途：条目引用字段里某个编号不能用时的整句。id 是写的编号（JSON），why 是不能用的原因（save_revision.field_ref_* 那几种的事实层）。

字段「{{field}}」是条目引用类型，第 {{no}} 个编号 {{id}} {{why}}

## `save_revision.field_ref_target_missing.not_id`

用途：条目引用里写的不是条目编号（接在 part.field_ref 里）。

应当写一个条目编号

## `save_revision.field_ref_target_missing`

用途：条目引用指向的条目不存在（接在 part.field_ref 里）。

指向的条目在这个任务里不存在

## `save_revision.field_ref_self.batch`

用途：条目引用指向这个操作自己要新增的条目（接在 part.field_ref 里）。

指向的就是这个操作自己要新增的条目

## `save_revision.field_ref_self.batch.guide`

用途：上一条的指引。

一个条目不能引用自己

## `save_revision.field_ref_target_order`

用途：条目引用指向这一批里排在后面才新增的条目（接在 part.field_ref 里）。

指向的条目 {{item}} 在这一批里排在第 {{at}} 个操作才新增，在这个操作之后

## `save_revision.field_ref_target_order.guide`

用途：上一条的指引。

请把新增 {{item}} 的操作排到前面

## `save_revision.field_ref_target_deleted`

用途：条目引用指向已经删除的条目（接在 part.field_ref 里）。

指向的条目已在修订 {{revision}} 删除

## `save_revision.field_ref_target_deleted.here`

用途：条目引用指向在这次调用里被删除的条目（接在 part.field_ref 里）。

指向的条目在这次调用里被删除

## `save_revision.field_ref_self`

用途：条目引用字段指向这个条目自己。

字段「{{field}}」的第 {{no}} 个编号 {{id}} 指的就是这个条目自己

## `save_revision.field_ref_wrong_collection`

用途：只许本集合的条目引用字段指向了别的集合的条目。

字段「{{field}}」只能指向「{{collection}}」里的条目，{{id}} 是「{{target}}」里的

## `save_revision.field_ref_wrong_collection.guide`

用途：上一条的指引。

请写「{{collection}}」里的一个条目编号，或者不写

## `save_revision.field_ref_cycle`

用途：顺着条目引用字段会绕回这个条目自己。path 是绕过的编号（用 → 接起）。

字段「{{field}}」写成 {{id}} 之后会绕回这个条目自己（{{path}} → {{self}}）

## `save_revision.field_ref_cycle.guide`

用途：上一条的指引。

请换一个不在这条线上的条目，或者不写

## `save_revision.field_text_type`

用途：文本字段写的不是字符串。

字段「{{field}}」是文本类型，应当写一个字符串

## `save_revision.field_text_list_type`

用途：文本列表字段写的不是字符串数组。

字段「{{field}}」是文本列表类型，应当写一个字符串数组，一步或一条一项

## `save_revision.field_list_value_not_allowed`

用途：文本列表字段的某一项不在可以选的值里。given 是写的值（JSON）。

字段「{{field}}」的第 {{no}} 项写的是 {{given}}，不在可以选的值里

## `save_revision.field_list_value_not_allowed.guide`

用途：上一条的指引。values 是可以选的值（各加引号）。

只能从{{values}}里选，可以选几个

## `save_revision.field_list_value_duplicate`

用途：文本列表字段里同一个值写了两次。

字段「{{field}}」里「{{value}}」写了两次

## `save_revision.field_list_value_duplicate.guide`

用途：上一条的指引。

同一个值只写一次

## `save_revision.field_enum_invalid`

用途：枚举字段写的不是取值之一。

字段「{{field}}」是枚举类型，写的是 {{given}}，只能是{{values}}之一

## `save_revision.supplement_inserted_not_in_text`

用途：助手补充的来源在 supports 一处的 inserted 里写的字串不在那一处的正文里（insertedProblems）。source 是 part.quote_label，place 是 result.save_revision.field_place 或 result.save_revision.field_item_place。

{{source}}写的补进正文的「{{inserted}}」不在{{place}}的正文里

## `save_revision.supplement_inserted_not_in_text.guide`

用途：上一条的指引。

inserted 里每一段都要照那一处的正文一字不差地抄出你补进去的字，并在 supports 里写对是哪个字段的第几项；理由里怎样写都可以，不必用引号

## `save_revision.supplement_inserted_missing`

用途：助手补充的来源在 supports 里没有一处写了 inserted（insertedProblems）。source 是 part.quote_label。

{{source}}没有写补进了正文的哪些字

## `save_revision.supplement_inserted_missing.guide`

用途：上一条的指引。

在 supports 里写明支持哪个字段（列表型字段写第几项），并用 inserted 逐字列出你补进那一处正文的字，例如 { "field": "字段名", "inserted": ["补进去的字"] }

## `part.quote_label`

用途：说到一条来源：摘录（长的只引前 30 字）加种类。

「{{excerpt}}」（{{kind}}）

## `part.inherited`

用途：依据字段的拒绝里，说的是沿用下来的来源时接在前面的几个字。

沿用下来的

## `part.support_tail`

用途：沿用下来的来源指错了字段时，接在事实层末尾的半句。

；请在这个操作里重新给出 sources

## `save_revision.support_field_unknown`

用途：来源说它支持的字段，集合里没有。where 是 part.source_no（沿用的前面加 part.inherited），tail 是空的或者 part.support_tail。

{{where}}说它支持字段「{{field}}」，集合「{{collection}}」没有这个字段，可用的字段是{{fields}}{{tail}}

## `save_revision.support_field_empty`

用途：来源说它支持的字段在改后的内容里是空的（这次新给的来源）。

{{where}}说它支持字段「{{field}}」，这个字段在改后的内容里是空的

## `save_revision.support_field_empty.guide`

用途：上一条的指引。

不要让来源指到空字段

## `save_revision.support_field_empty.inherited`

用途：沿用下来的来源说它支持的字段在改后的内容里是空的。

{{where}}说它支持字段「{{field}}」，这个字段在改后的内容里是空的

## `save_revision.support_field_empty.inherited.guide`

用途：上一条的指引。

请在这个操作里重新给出 sources

## `save_revision.support_index_on_non_list`

用途：给不是列表型的字段写了 index。type 是字段类型。

{{where}}给字段「{{field}}」写了 index，这个字段是{{type}}类型，只有列表型的字段才能指到其中一项{{tail}}

## `save_revision.support_index_out_of_range`

用途：index 超出了字段改后的项数。

{{where}}指到字段「{{field}}」的第 {{index}} 项（从 0 起），这个字段改后只有 {{length}} 项，index 最大是 {{max}}{{tail}}
