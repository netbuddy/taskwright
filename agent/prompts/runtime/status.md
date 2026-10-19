# 任务状况消息

扩展在会话开始（或续接旧会话）时写进会话的任务状况（`agent/src/lib/task_status.ts`）：新会话写现状，续接写上次之后的变化。
发给助手；页面转一道说法再显示（`backend/src/conversation.ts` 按 `status.head_now`、`status.head_changes`、`status.change_by_executor`、`status.open_acts` 认出要换的地方）。
清单的分隔、句与句的先后由代码定。

## `status.head_now`

用途：新会话的任务现状消息的开头。clock 是写入时的本机时刻（时:分:秒）。

【执行者开始这条会话时（{{clock}}）的任务状况：由扩展写入，不是用户打的字】

## `status.head_changes`

用途：续接旧会话时，上次之后的变化那条消息的开头。

【执行者续接这条会话时（{{clock}}）看到的、上次之后交付物的变化：由扩展写入，不是用户打的字】

## `status.task_line`

用途：任务现状的第一句：任务名、任务类型与任务编号。

任务「{{name}}」（类型：{{type}}），任务编号 {{id}}。

## `status.items_none`

用途：任务现状里交付物还没有条目时的那一句。

交付物还没有任何条目。

## `status.items`

用途：任务现状里交付物的条目数。counts 是各集合的 status.items_count，用「、」接起。

交付物现有 {{total}} 个条目：{{counts}}。

## `status.items_count`

用途：任务现状里一个集合有几个条目。

{{collection}} {{count}} 个

## `status.unresolved`

用途：任务现状里未解决的问题条目数。

未解决的问题条目有 {{count}} 条。

## `status.materials_none`

用途：材料目录里没有文件时的那一句。

材料目录 {{dir}} 里现在没有文件。

## `status.materials`

用途：材料清单那一句。files 是每份材料的 status.material_file；word、pdf 是 Word 与 PDF 材料的说明（没有就是空的）；segments 是每份 Word、PDF 材料的分段情况。

材料目录 {{dir}} 里有 {{count}} 个文件：{{files}}。{{word}}{{pdf}}{{segments}}

## `status.material_file`

用途：材料清单里的一份材料：路径与大小。

{{path}}（{{size}}）

## `status.size_bytes`

用途：不到 1 KB 的文件大小。

{{size}} 字节

## `status.size_kb`

用途：不到 1 MB 的文件大小，保留一位小数。

{{size}} KB

## `status.size_mb`

用途：1 MB 以上的文件大小，保留一位小数。

{{size}} MB

## `status.materials_word`

用途：材料里有 Word 文件时，告诉助手读它的文字版、出处怎样写。first 是第一份 Word 文件。

其中 {{words}} 是 Word 文件，请读由它生成的文字版 {{projections}}（每段一行，段落号写在方括号里）；引用它作来源时，出处写 Word 文件加段落号，例如 {{first}}#p12。

## `status.materials_pdf`

用途：材料里有 PDF 文件而没有 Word 文件时，告诉助手读它的文字版、出处怎样写。

其中 {{pdfs}} 是 PDF 文件，请读由它生成的文字版 {{projections}}（每块一行，行首方括号里是页与块）；引用它作来源时，出处写 PDF 文件加页与块，例如 {{first}}#p3-2。

## `status.materials_pdf_also`

用途：材料里 Word 与 PDF 文件都有时，接在 Word 那一句后面的 PDF 那一句。

{{pdfs}} 是 PDF 文件，请读由它生成的文字版 {{projections}}（每块一行，行首方括号里是页与块）；引用它作来源时，出处写 PDF 文件加页与块，例如 {{first}}#p3-2。

## `status.segments_word`

用途：一份 Word 材料的分段情况。list 是空的或者 status.segments_word_list。

{{path}} 共 {{text_paragraphs}} 段有文字（段落号 1 到 {{paragraphs}}）、{{blocks}} 块{{list}}。

## `status.segments_word_list`

用途：Word 材料有分段清单时，接在分段情况后面的半句。

，分段清单见 {{file}}

## `status.segments_pdf`

用途：一份 PDF 材料的分段情况。no_text 是空的或者 status.segments_pdf_no_text，list 是空的或者 status.segments_pdf_list。

{{path}} 共 {{pages}} 页、{{units}} 块{{no_text}}{{list}}。

## `status.segments_pdf_no_text`

用途：PDF 材料有没有文字的页时，接在分段情况里的半句。

，其中第 {{pages}} 页没有文字

## `status.segments_pdf_list`

用途：PDF 材料有分段清单时，接在分段情况后面的半句。

，分段清单按页，见 {{file}}

## `status.citations`

用途：续接时材料的引用情况那一句。parts 是每份材料的 status.cited_* 那一项，用「；」接起。

材料的引用情况：{{parts}}。

## `status.cited_word_all`

用途：引用情况里，一份 Word 材料每段都有条目引用。

{{path}} 每段都有条目引用

## `status.cited_word_some`

用途：引用情况里，一份 Word 材料还有几段没有被引用。

{{path}} 还有 {{count}} 段没有被任何条目引用

## `status.cited_pdf_all`

用途：引用情况里，一份 PDF 材料每块都有条目引用。

{{path}} 每块都有条目引用

## `status.cited_pdf_some`

用途：引用情况里，一份 PDF 材料还有几块没有被引用。

{{path}} 还有 {{count}} 块没有被任何条目引用

## `status.cited_text`

用途：引用情况里，一份文本材料被引用过几次。

{{path}} 被引用过 {{count}} 次

## `status.knowledge_lead`

用途：「这个任务选用的知识库」一段的开头。里面的规矩与平台说明「知识库怎样用」、查找知识库工具的说明（tools/search_knowledge.md）是同一条，改一处要三处一起改。

这个任务选用的知识库（参考资料，不整理成条目；材料里把具体规定指给了别的文档时，必须到这里把那条规定查出来写进条目并记来源；查知识库用 search_knowledge，不要用 grep 去翻知识库，命中太多也拿不全；查法与来源的写法见平台说明「知识库怎样用」；引用时来源种类写「文档原文」，出处照抄每份文档后面的写法）：

## `status.knowledge_library_empty`

用途：知识库一段里，一个选用的知识库没有文档。

知识库「{{name}}」现在没有文档。

## `status.knowledge_library`

用途：知识库一段里，一个选用的知识库有几份文档；下面每份文档一行。

知识库「{{name}}」有 {{count}} 份文档：

## `status.knowledge_document`

用途：知识库一段里的一份文档（不是 Word 文档）：名字、种类、大小与出处的写法。

- {{name}}（{{kind}}，{{size}}）：用 search_knowledge 查；出处写 {{locator}}

## `status.knowledge_document_word`

用途：知识库一段里的一份 Word 文档，出处另加段落号。

- {{name}}（{{kind}}，{{size}}）：用 search_knowledge 查；出处写 {{locator}} 加段落号，例如 {{locator}}#p12

## `status.knowledge_changed`

用途：续接时知识库变过，在重写一遍的知识库一段前面的引子。

上次之后，这个任务选用的知识库或其中的文档有变化，现在是这样。

## `status.knowledge_changed_empty`

用途：续接时知识库变过，而现在选用的知识库里一份文档都没有。

上次之后，这个任务选用的知识库或其中的文档有变化：现在选用的知识库里没有文档。

## `status.no_changes`

用途：续接时交付物没有变化（只有新材料、知识库变过、开着的提议或者上一次运行被停止）。

交付物没有变化。

## `status.changes`

用途：续接时交付物的变化。pieces 是 status.change_added、status.change_updated、status.change_deleted 用「；」接起，sources 是 status.change_by_user、status.change_by_executor 用「，」接起。

{{pieces}}。这些改动来自 {{count}} 次修订：{{sources}}。

## `status.change_added`

用途：变化里新增的条目。

新增 {{count}} 个条目（{{items}}）

## `status.change_updated`

用途：变化里修改的条目。items 是每个条目的 status.change_updated_item。

修改 {{count}} 个（{{items}}）

## `status.change_updated_item`

用途：变化里一个修改的条目从哪次修订改到哪次修订。

{{item}} 修订 {{from}} → 修订 {{to}}

## `status.change_deleted`

用途：变化里删除的条目。

删除 {{count}} 个（{{items}}）

## `status.change_by_user`

用途：变化的来处之一：用户在界面上直接做的修订。

用户在界面上直接做的 {{count}} 次

## `status.change_by_executor`

用途：变化的来处之一：助手在别的会话里做的修订（页面上把「执行者」换成「助手」）。

执行者在别的会话里做的 {{count}} 次

## `status.new_materials`

用途：续接时上次之后新放进来的材料。

其中上次之后新放进来的是：{{files}}。

## `status.last_run_stopped`

用途：续接时上一次运行被用户停止，变化消息里加的那一句（页面照原样显示）。

上一次运行被用户停止，没有做完。

## `status.open_acts`

用途：消息末尾列出这条会话里还在等用户回应的执行者行为（页面上整行不显示）。list 是每一项的 status.open_act，用「；」接起。

还在等回应的执行者行为 {{count}} 条（你问过、用户还没有回应的）：{{list}}。

## `status.open_act`

用途：还在等回应的一项：行为编号、种类与摘要。

{{act}} {{function}}「{{summary}}」
