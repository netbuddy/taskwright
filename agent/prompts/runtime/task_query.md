# 查看条目与查询任务状态的文字

「查看条目」（get_item）与「查询任务状态」（get_task_status）两个工具返回给助手的文字（`agent/src/lib/task_query.ts`）。
查不到条目、修订号不对之类的拒绝不在这里；行首的缩进与序号由代码写。

## `query.diagram_brief`

用途：查询任务状态里说图的那一行中的一张图：编号、图名、种类与它自己现在的修订号。

{{diagram}}「{{name}}」（{{kind}}，修订 {{revision}}）

## `query.diagrams`

用途：查询任务状态里说图的那一行。list 是每张图的 query.diagram_brief。

图 {{count}} 张：{{list}}。图不是条目，不评审，不算进完成条件；要看一张图的 Mermaid 文本，用 get_item 写它的编号。

## `query.diagram_head_latest`

用途：查看条目看一张图的最新内容时的第一行。

图 {{diagram}}「{{name}}」（{{kind}}），修订 {{revision}}，是最新内容。图的修订号是图自己的，与条目的修订号无关。

## `query.diagram_head_old`

用途：查看条目看一张图的旧内容时的第一行。

图 {{diagram}}「{{name}}」（{{kind}}），修订 {{revision}}，是旧内容。图的修订号是图自己的，与条目的修订号无关。

## `query.diagram_revisions`

用途：看一张图时列出它改动过的修订（代码在前面缩进两格）。list 是每次的 query.diagram_revision。

改动过的修订：{{list}}。

## `query.diagram_revision`

用途：图的一次修订：修订号与发起方。

修订 {{revision}}（发起方 {{actor}}）

## `query.diagram_note`

用途：看一张图时的说明一行。

说明：{{note}}

## `query.diagram_note_none`

用途：看一张图时，这张图没有写说明。

说明：（没有写）

## `query.diagram_mermaid_label`

用途：看一张图时，Mermaid 文本前面的那一行（文本夹在 <<< 与 >>> 之间，由代码写）。

Mermaid 文本：

## `query.sources_count`

用途：看一张图时来源的标题行。

来源（{{count}} 条）：

## `query.sources_none`

用途：看一张图时，这一次修订没有来源（代码在前面缩进两格）。

（这一次修订没有来源）

## `query.source_line`

用途：来源的一行：种类不是文档原文、也不是条目（代码在前面写序号与缩进）。quote 是空的或者 query.source_quote。

{{kind}}{{quote}}

## `query.source_line_document`

用途：来源的一行：文档原文，写出处。

{{kind}}，出处 {{locator}}{{quote}}

## `query.source_line_item`

用途：来源的一行：依据一个条目，写出处与那个条目现在的情形（query.source_item_*）。

条目，出处 {{locator}}{{quote}}（{{state}}）

## `query.source_quote`

用途：来源的一行里的摘录。

：「{{excerpt}}」

## `query.source_item_deleted`

用途：依据的条目已经删除。

{{locator}} 已经删除

## `query.source_item_changed`

用途：依据的条目在引用之后改过。

依据已变：引用时 {{locator}} 是修订 {{then}}，现在是修订 {{now}}

## `query.source_item_same`

用途：依据的条目在引用之后没有改过。then 不知道时代码写「？」。

引用时 {{locator}} 是修订 {{then}}，之后没有改过

## `query.diagram_drawn`

用途：看一张图时，图里画了哪些条目。

图里画了 {{count}} 个条目：{{items}}。

## `query.diagram_drawn_none`

用途：看一张图时，图里没有写条目编号。

图里没有写条目编号。

## `query.diagram_edit_latest`

用途：看一张图的最新内容时的最后一行：要改它时怎样写。

{{diagram}} 现在是修订 {{revision}}。要修改或删除这张图时用 save_diagram，diagram 写 {{diagram}}，base_revision 写 {{revision}}；修改时只写要改的那几项。

## `query.diagram_edit_old`

用途：看一张图的旧内容时的最后一行。

这是旧内容；{{diagram}} 现在是修订 {{revision}}，要修改时先看最新内容，base_revision 写 {{revision}}。

## `query.item_edit_latest`

用途：查看条目看最新内容时，末尾说要改它时怎样写。

{{item}} 现在是修订 {{revision}}。要修改或删除这个条目时，base_revision 写 {{revision}}。修改时 fields 只写要改的字段，列表型字段要写改后的完整列表。

## `query.item_edit_old`

用途：查看条目看旧内容时，末尾那一句。

这是旧内容；{{item}} 现在是修订 {{revision}}，要修改时先看最新内容，base_revision 写 {{revision}}。

## `query.item_raw_fields`

用途：查看条目末尾，各字段的原值。json 是字段的 JSON。

这份内容各字段的原值（JSON）：{{json}}

## `query.task_line`

用途：查询任务状态的第一行。

任务 {{id}}「{{name}}」（类型：{{type}}）。

## `query.collection_items`

用途：查询任务状态里一个集合的条目。items 是每个条目的 query.item_at_revision。

{{collection}} {{count}} 个：{{items}}。

## `query.collection_empty`

用途：查询任务状态里一个还没有条目的集合。

{{collection}} {{count}} 个。

## `query.item_at_revision`

用途：查询任务状态里点名一个条目在哪次修订。

{{item}}（修订 {{revision}}）

## `query.unresolved_none`

用途：查询任务状态里没有未解决的问题条目。

未解决的问题条目：没有。

## `query.unresolved`

用途：查询任务状态里未解决的问题条目。list 是每条一行的 query.unresolved_item（代码在前面缩进两格）。

未解决的问题条目 {{count}} 条：
{{list}}

## `query.unresolved_item`

用途：未解决的一条问题条目：编号、修订与标题。

{{item}}（修订 {{revision}}）：{{title}}

## `query.unread_none`

用途：查询任务状态里没有未读的条目。

未读的条目：没有，每个条目用户都看过。

## `query.unread`

用途：查询任务状态里未读的条目。

未读的条目 {{count}} 条（用户从没打开看过它们；问用户要不要发布版本之前，先告诉用户还有几条没看）：{{list}}。

## `query.hint`

用途：查询任务状态里完成条件之外、不挡发布版本的一条提示。

提示（不挡发布版本）：{{summary}}

## `query.last_revision`

用途：查询任务状态里最近一次修订。

最近一次修订是修订 {{revision}}（事件序号 {{seq}}）。

## `query.no_revision`

用途：查询任务状态里交付物还没有修订。

交付物还没有任何修订。

## `query.materials_lead`

用途：查询任务状态里材料的分段与引用情况的标题行。

材料的分段与引用情况（Word 材料按分段清单逐块列出，PDF 材料按分段清单逐段列出；行号是文字版文件里的行号，read 的 offset 用它）：

## `query.material_text`

用途：一份文本材料被引用过几次（代码在前面缩进两格）。

{{path}}：被引用过 {{count}} 次。

## `query.material_pdf`

用途：一份 PDF 材料的分段与引用情况。no_text 是空的或者 query.material_pdf_no_text，cited 是 query.material_pdf_all 或 query.material_pdf_some。

{{path}}（读 {{projection}}）：共 {{pages}} 页、{{units}} 块{{no_text}}，{{cited}}

## `query.material_pdf_no_text`

用途：PDF 材料有没有文字的页。

，第 {{pages}} 页没有文字

## `query.material_pdf_all`

用途：PDF 材料每块都有条目引用。

每块都有条目引用。

## `query.material_pdf_some`

用途：PDF 材料还有几块没有被引用。

还有 {{count}} 块没有被任何条目引用。

## `query.material_pdf_block`

用途：PDF 材料分段清单里的一段（代码在前面缩进四格）。heading 是空的或者加了引号的标题，uncited 是空的或者 query.material_pdf_block_uncited。

第 {{index}} 段 第 {{first_page}}–{{last_page}} 页（第 {{first_line}}–{{last_line}} 行）{{heading}}：{{units}} 块，被 {{items}} 个条目引用{{uncited}}。

## `query.material_pdf_block_uncited`

用途：PDF 材料的一段里有几块没有被引用。

，{{count}} 块没有引用

## `query.material_word`

用途：一份 Word 材料的分段与引用情况。cited 是 query.material_word_all 或 query.material_word_some。

{{path}}（读 {{projection}}）：共 {{text_paragraphs}} 段有文字、{{blocks}} 块，{{cited}}

## `query.material_word_all`

用途：Word 材料每段都有条目引用。

每段都有条目引用。

## `query.material_word_some`

用途：Word 材料还有几段没有被引用。

还有 {{count}} 段没有被任何条目引用。

## `query.material_word_block`

用途：Word 材料分段清单里的一块（代码在前面缩进四格）。heading 是加了引号的标题或者 query.material_word_before_heading，uncited 是空的或者 query.material_word_block_uncited。

第 {{index}} 块 p{{first}}–p{{last}}（第 {{first_line}}–{{last_line}} 行）{{heading}}：{{paragraphs}} 段，被 {{items}} 个条目引用{{uncited}}。

## `query.material_word_before_heading`

用途：Word 材料第一个标题之前的那一块。

（第一个标题之前）

## `query.material_word_block_uncited`

用途：Word 材料的一块里有几段没有被引用。

，{{count}} 段没有引用

## `query.findings_lead`

用途：查询任务状态里评审不通过、还没处理的条目与发现的标题行。

评审不通过、还没处理的条目与发现（问题要改；建议告诉用户，由用户定）：

## `query.findings_none`

用途：查询任务状态里没有评审不通过、还没处理的条目。

评审不通过、还没处理的条目：没有。

## `query.failed_item`

用途：评审不通过的一个条目（代码在前面缩进两格，下面逐条列发现）。

{{item}}（修订 {{revision}}）：

## `query.failed_item_batch`

用途：评审不通过的一个条目，写明是第几次评审。

{{item}}（修订 {{revision}}，第 {{no}} 次评审）：

## `query.kept`

用途：查询任务状态里评审不通过、用户保留了写法的条目。items 是每个条目的 query.kept_item 或 query.kept_item_reason。

评审不通过、用户保留了写法的条目（这些按用户的决定算通过，不用改；条目再改动，评审要重做）：{{items}}。

## `query.kept_item`

用途：用户保留了写法的一个条目，没有写理由。

{{item}}（修订 {{revision}}）

## `query.kept_item_reason`

用途：用户保留了写法的一个条目，写了理由。

{{item}}（修订 {{revision}}，理由：{{reason}}）
