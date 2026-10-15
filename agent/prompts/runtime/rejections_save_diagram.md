# 保存图的拒绝语

保存图（`agent/src/lib/save_diagram.ts`）不通过时的拒绝：给模型的正文是 `part.diagram_head` 一句，有指引时另起一行写「怎么办：」（`part.save_guidance`）。
来源的核对与保存修订同一套（`rejections_source.md`）；按阶段拦的在 `rejections_shared.md`（`gate.stage_diagram`）。
Mermaid 文本没有通过校验的那几句另有固定的写法：工具从会话记录里数连续几次没有通过校验时认的是 `part.mermaid_failed_head`，后端的过程摘要也按它认（`backend/src/work_summary.ts`）。
键的写法见 `rejections_shared.md` 的开头。

## `part.diagram_head`

用途：保存图被拒时给模型的正文的第一句。

这张图没有保存：{{fact}}。

## `part.mermaid_failed_head`

用途：Mermaid 文本没有通过校验时正文的开头（后面接校验给的话）。

这张图没有保存：Mermaid 文本没有通过校验。

## `part.mermaid_fix`

用途：校验没有通过、还没到上限时正文的最后一句。

照上面说的改了再保存。

## `part.mermaid_give_up`

用途：这一轮里图连续没有通过校验到了上限时的话。limit 是上限（几次）。

这一轮里图已经连续 {{limit}} 次没有通过校验，不要再试：用 reply 告诉用户这张图哪里画不出来，问用户要不要换一种图或者画得小一些。

## `part.mermaid_not_checked`

用途：已经到了上限还来保存时，接在 part.mermaid_failed_head 后面的半句。

这一次没有再校验。

## `part.diagram_missing_name`

用途：新画一张图时缺的一项：图名。

name（图名）

## `part.diagram_missing_kind`

用途：新画一张图时缺的一项：图的种类。

kind（图的种类）

## `part.diagram_missing_mermaid`

用途：新画一张图时缺的一项：Mermaid 文本。

mermaid（Mermaid 文本）

## `part.diagram_have`

用途：说到图的编号写错、图不在时，列出任务里现有的图。list 是图的编号（用「、」接起）或 part.diagram_none。

现有的图是：{{list}}

## `part.diagram_none`

用途：任务里一张图都没有时的说法。

（一张都没有）

## `part.diagram_op_delete`

用途：拒绝语里说到删除图。

删除

## `part.diagram_op_update`

用途：拒绝语里说到修改图。

修改

## `part.drawn_missing`

用途：Mermaid 文本里写的条目编号在任务里不存在的那一半句。

{{items}} 在这个任务里不存在

## `part.drawn_deleted`

用途：Mermaid 文本里写的条目编号已经删除的那一半句。

{{items}} 已经删除

## `part.them`

用途：图里画了几个条目而来源里没有写时的代词（不止一个）。

它们

## `part.it`

用途：图里画了一个条目而来源里没有写时的代词。

它

## `save_diagram.delete_not_boolean`

用途：delete 写的不是真或假。

delete 写的不是真或假

## `save_diagram.delete_not_boolean.guide`

用途：上一条的指引。

删除一张图时写 delete 为 true，别的时候不写

## `save_diagram.delete_without_diagram`

用途：要删除图而没有写是哪一张。

要删除图，但没有写是哪一张

## `save_diagram.delete_without_diagram.guide`

用途：上一条的指引。

diagram 写要删除的图的编号，例如 D-001

## `save_diagram.add_base_revision_given`

用途：新画一张图时写了 base_revision。

新画一张图时写了 base_revision

## `save_diagram.add_base_revision_given.guide`

用途：上一条的指引。

新画的图还没有修订号，不要写 base_revision；要改已有的图就写上 diagram

## `save_diagram.add_fields_missing`

用途：新画一张图缺了图名、种类或 Mermaid 文本。missing 是缺的几项（part.diagram_missing_*，用「、」接起）。

新画一张图缺少 {{missing}}

## `save_diagram.diagram_id_invalid`

用途：diagram 写的不是图的编号。have 是 part.diagram_have。

diagram 写的 {{given}} 不是图的编号

## `save_diagram.diagram_id_invalid.guide`

用途：上一条的指引。

图的编号是 D-001 这样的；{{have}}。新画一张图时不要写 diagram

## `save_diagram.diagram_not_found`

用途：任务里没有这张图。

这个任务里没有图 {{id}}

## `save_diagram.diagram_not_found.guide`

用途：上一条的指引：列出现有的图。

{{have}}

## `save_diagram.diagram_deleted`

用途：这张图已经删除了。

图 {{id}} 已经在它的修订 {{revision}} 删除了

## `save_diagram.diagram_deleted.guide`

用途：上一条的指引：列出现有的图。

{{have}}

## `save_diagram.base_revision_missing`

用途：修改或删除图时没有写 base_revision，或者写的不是整数。op 是 part.diagram_op_*。

{{op}}图 {{id}} 时没有写 base_revision，或者写的不是整数

## `save_diagram.base_revision_missing.guide`

用途：上一条的指引。

{{id}} 现在是修订 {{now}}，base_revision 写 {{now}}

## `save_diagram.base_revision_stale`

用途：图在助手看过之后又改过。

图 {{id}} 现在是修订 {{now}}，你写的 base_revision 是 {{given}}，它在你看过之后又改过

## `save_diagram.base_revision_stale.guide`

用途：上一条的指引。

先用 get_item 看 {{id}} 现在的样子，再决定怎样改

## `save_diagram.delete_extra_fields`

用途：删除图时还写了别的几项。

删除图 {{id}} 时还写了 {{fields}}

## `save_diagram.delete_extra_fields.guide`

用途：上一条的指引。

删除时只写 diagram、base_revision 与 delete

## `save_diagram.nothing_changed`

用途：对图的修改与它现在的内容完全一样。

对图 {{id}} 的修改与它在修订 {{revision}} 的内容完全一样，没有改动任何东西

## `save_diagram.nothing_changed.guide`

用途：上一条的指引。

只写要改的那几项；不需要改就不用保存

## `save_diagram.name_empty`

用途：图名是空的或者不是文字。

name（图名）是空的，或者不是文字

## `save_diagram.name_too_long`

用途：图名太长。

图名有 {{length}} 个字，超过了 {{limit}} 个字

## `save_diagram.name_too_long.guide`

用途：上一条的指引。

图名写短一些，要解释的话写进 note

## `save_diagram.name_multiline`

用途：图名里有换行。

图名里有换行

## `save_diagram.name_multiline.guide`

用途：上一条的指引。

图名写成一行

## `save_diagram.kind_invalid`

用途：图的种类写得不对。

kind（图的种类）写的是 {{given}}

## `save_diagram.kind_invalid.guide`

用途：上一条的指引。kinds 是各种图的写法与中文名。

kind 只能是 {{kinds}} 之一

## `save_diagram.mermaid_empty`

用途：Mermaid 文本是空的或者不是文字。

mermaid（Mermaid 文本）是空的，或者不是文字

## `save_diagram.note_not_text`

用途：说明不是文字。

note（说明）不是文字

## `save_diagram.note_too_long`

用途：说明太长。

说明有 {{length}} 个字，超过了 {{limit}} 个字

## `save_diagram.note_too_long.guide`

用途：上一条的指引。

说明写一两句话

## `save_diagram.drawn_item_invalid`

用途：Mermaid 文本里写的条目编号不存在或者已经删除。parts 是 part.drawn_missing、part.drawn_deleted 用「，」接起。

Mermaid 文本里写的条目编号{{parts}}

## `save_diagram.drawn_item_invalid.guide`

用途：上一条的指引。

图里只写任务里现有的条目编号；用 get_task_status 可以看到现有的条目

## `save_diagram.drawn_item_uncited`

用途：图里画了的条目在来源里没有写。pronoun 是 part.it 或 part.them。

图里画了 {{items}}，来源里没有写{{pronoun}}

## `save_diagram.drawn_item_uncited.guide`

用途：上一条的指引。first 是第一个没有写的条目编号。

画进图里的每个条目各写一条种类为「条目」的来源，出处写条目编号，不用写摘录，例如 {"kind": "条目", "locator": "{{first}}"}；修改图时给了 sources 就是整份替换，要把还用得着的来源一起写上

## `part.diagram_sources_guide`

用途：新画一张图而来源没有通过核对时的指引（事实一层是来源核对的原因，见 rejections_source.md）。

图至少要有一条来源：用户要你画图的那句话写一条「用户的话」，画进图里的每个条目各写一条种类为「条目」的来源

## `save_diagram.mermaid_invalid`

用途：Mermaid 文本没有通过校验（记进拒绝记录的事实一层）。message 是校验给的话。

Mermaid 文本没有通过校验：{{message}}

## `save_diagram.mermaid_invalid.guide`

用途：上一条的指引（还没到上限时）。

照校验说的改了再保存

## `save_diagram.mermaid_over_limit`

用途：这一轮已经连续到了上限还来保存，不再校验（记进拒绝记录的事实一层；指引一层是 part.mermaid_give_up）。

图已经连续几次没有通过校验，这一次没有再校验

## `save_diagram.validation_unavailable`

用途：校验没有做成（不算输入问题）。message 是没有做成的原因。

这张图没有保存。{{message}}不要改了文本再试，用 reply 把这个情况告诉用户。

## `save_diagram.no_task`

用途：库里没有任务记录（不算输入问题）。

库里没有任务记录，所以图没有保存。请把这个情况如实告诉用户。

## `save_diagram.several_tasks`

用途：库里有几个任务（不算输入问题）。

这个任务目录里有 {{count}} 个任务，库里的记录有问题，所以图没有保存。请把这个情况告诉用户。

## `save_diagram.no_database`

用途：任务目录里还没有库（不算输入问题）。

这个任务目录里还没有任务记录，所以没有地方保存图，什么都没有写入。请把这个情况如实告诉用户。
