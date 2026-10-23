# 来源核对的拒绝语

保存修订、保存图与回复的建议值依据共用的来源核对（`agent/src/lib/save_revision.ts` 的 checkSources、checkDocxSource、checkPdfSource 等）被拒时的文字。末尾两条是自带的 read 与 grep 按材料的 role 被拦时交给助手的话（`agent/src/hooks/source_roles.ts`）。
键的写法见 `rejections_shared.md` 的开头。where 是说到第几条来源的那几个字（`part.source_no`；回复的依据另有写法）。

## `part.source_no`

用途：拒绝语里说到第几条来源（保存修订与保存图；回复的依据另有写法）。

第 {{no}} 条来源

## `source.missing`

用途：没有写 sources。

缺少 sources，至少要有一条来源

## `source.not_nonempty_list`

用途：sources 不是不为空的列表。

sources 应当是一个不为空的列表，至少要有一条来源

## `source.item_not_object`

用途：一条来源不是对象。where 是 part.source_no 那样的说法。

{{where}}应当是一个对象，有 kind、locator、excerpt 三项

## `part.kinds_guide`

用途：来源种类写错时的指引：能填哪几种。kinds 是各种类（加引号）。

kind 只能是{{kinds}}之一

## `source.kind_user_edit_forbidden`

用途：助手填了只由系统写的「用户直接修改」。

{{where}}的种类写成了「{{kind}}」，这一种助手不能填

## `source.kind_user_edit_forbidden.guide`

用途：上一条的指引。kinds_guide 是 part.kinds_guide 那一句。

{{kinds_guide}}

## `source.kind_figure_in_figure`

用途：图的来源写了「图」。

{{where}}的种类写成了「{{figure}}」，一张图不能把另一张图当作依据

## `source.kind_figure_in_figure.guide`

用途：上一条的指引。

图的来源写它画自的条目（种类「{{item}}」）、用户的话、材料原文或者你补充的理由

## `source.kind_invalid`

用途：种类不是能填的那几种。given 是写的值（JSON）。

{{where}}的 kind 写的是 {{given}}，只能是{{kinds}}之一

## `source.supplement_no_reason`

用途：助手补充没有写理由。

{{where}}的种类是「{{kind}}」，没有写理由

## `source.supplement_no_reason.guide`

用途：上一条的指引。

在 excerpt 里写一句理由：为什么这样补、依据的是什么常识或推断

## `source.locator_or_excerpt_missing`

用途：来源缺出处或摘录。missing 是 part.missing_locator、part.missing_excerpt 用「、」接起。

{{where}}缺少 {{missing}}

## `part.missing_locator`

用途：来源缺的一项：出处。

locator（出处）

## `part.missing_excerpt`

用途：来源缺的一项：摘录。

excerpt（摘录的原文）

## `source.normalized_value_misused`

用途：不是「用户的话」的来源写了 normalized_value。

{{where}}写了 normalized_value；它只用于种类为「用户的话」的来源，别的种类不写

## `source.normalized_value_empty`

用途：normalized_value 是空的。

{{where}}的 normalized_value 应当是一段不为空的文字（写进字段的值），与原话相同就不写

## `source.supports_not_list`

用途：supports 不是列表。

{{where}}的 supports 应当是一个列表，每一项形如 { "field": "字段名", "index": 0 }；支持整个条目就写 [] 或者不写

## `part.supports_item`

用途：说到 supports 的第几项。

{{where}}的 supports 第 {{no}} 项

## `source.supports_item_shape`

用途：supports 的一项形状不对。at 是 part.supports_item。

{{at}}应当是 { "field": "字段名" } 或 { "field": "字段名", "index": 从 0 起的整数 }

## `source.supports_index_invalid`

用途：supports 一项的 index 不是从 0 起的整数。given 是写的值（JSON）。

{{at}}的 index 应当是从 0 起的整数，现在写的是 {{given}}

## `source.supports_inserted_invalid`

用途：supports 一项的 inserted 不是字符串数组，或者里面有空的字符串。

{{at}}的 inserted 应当是字符串数组，每一项写一段补进正文的字，不能是空的

## `source.inserted_not_supplement`

用途：不是助手补充的来源在 supports 里写了 inserted。

{{where}}的 supports 写了 inserted；只有「{{kind}}」的来源写 inserted，别的来源不写

## `source.supports_in_figure`

用途：图的来源写了 supports。

{{where}}写了 supports；图没有字段，图的来源不写 supports

## `source.item_ref_invalid`

用途：种类为「条目」的来源，出处指的条目不能引用。why 是 part.ref_* 那几种原因之一。

{{where}}的种类是「{{kind}}」，出处 {{locator}} {{why}}

## `source.item_ref_invalid.guide`

用途：上一条的指引（原因自己带着指引时用原因的，见 part.ref_deprecated_guide）。

出处写一个还在的条目的编号，例如 OA-001、UC-003；要引用的条目还没有记下，先新增它（排在前面），再引用

## `part.ref_self`

用途：出处指的就是这个条目自己。

指的就是这个条目自己，一个条目不能把自己当作依据

## `part.ref_missing`

用途：出处指的条目不存在。

指向的条目在这个任务里不存在

## `part.ref_self_batch`

用途：出处指的就是这个操作自己要新增的条目。

指的就是这个操作自己要新增的条目，一个条目不能把自己当作依据

## `part.ref_later`

用途：出处指的条目在这一批里排在后面才新增。

指向的条目在这一批里排在第 {{at}} 个操作才新增，在这个操作之后；请把新增它的操作排到前面

## `part.ref_failed`

用途：出处指的条目在这一批里排在前面新增，但那个操作没有通过核对。

指向的条目在这一批里排在前面新增，但那个操作自己没有通过核对

## `part.ref_deleted`

用途：出处指的条目已经删除。

指向的条目已在修订 {{revision}} 删除

## `part.ref_deleted_here`

用途：出处指的条目在这次调用里被删除。

指向的条目在这次调用里被删除

## `part.ref_deprecated`

用途：出处指的主题已废弃。

指向的主题 {{locator}} 已废弃

## `part.ref_deprecated_guide`

用途：出处指的主题已废弃、写了改看时的指引。

改看 {{see}}：把出处改成 {{see}}，摘录照它现在的内容抄

## `part.ref_deprecated_guide_none`

用途：出处指的主题已废弃、没有写改看时的指引。

请改成依据现在在用的主题

## `source.item_excerpt_not_found`

用途：种类为「条目」的来源，摘录在那个条目里找不到。

{{where}}的摘录「{{excerpt}}」在 {{locator}} 的当前修订里找不到

## `source.item_excerpt_not_found.guide`

用途：上一条的指引。

摘录必须逐字一致，包括标点，抄自这个条目某个字段里连续的一段

## `source.figure_ref_invalid`

用途：种类为「图」的来源，出处指的图不能引用。why 是 part.figure_* 那几种原因之一。

{{where}}的种类是「{{kind}}」，出处 {{locator}} {{why}}

## `source.figure_ref_invalid.guide`

用途：上一条的指引。

出处写一张还在的图的编号，例如 D-001；用 get_task_status 可以看到任务里有哪几张图

## `part.figure_not_id`

用途：出处不是图的编号。

不是图的编号

## `part.figure_missing`

用途：出处指的图不存在。

指向的图在这个任务里不存在

## `part.figure_deleted`

用途：出处指的图已经删除。

指向的图已在它的修订 {{revision}} 删除

## `source.figure_excerpt_not_found`

用途：种类为「图」的来源，摘录在图的文本里找不到。

{{where}}的摘录「{{excerpt}}」在图 {{locator}} 现在的 Mermaid 文本里找不到

## `source.figure_excerpt_not_found.guide`

用途：上一条的指引。

摘录逐字抄图里一个节点上的文字（用 get_item 写图的编号可以看到它的文本）；不好抄时可以不写摘录

## `source.user_words_not_found`

用途：引用的用户的话在对话里找不到。

{{where}}引用的用户的话「{{excerpt}}」在对话里没有找到

## `source.user_words_not_found.guide`

用途：上一条的指引。

请逐字摘录用户说过的原话

## `source.docx_projection_locator`

用途：出处写成了 Word 文件生成的文字版。noun 是「材料」或「文档」（知识库）。

{{where}}的出处 {{locator}} 是由 Word 文件生成的文字版，不是{{noun}}本身

## `source.docx_projection_locator.guide`

用途：上一条的指引。file 是 Word 文件。

出处写 Word 文件加段落号，例如 {{file}}#p12

## `source.pdf_projection_locator`

用途：出处写成了 PDF 文件生成的文字版。

{{where}}的出处 {{locator}} 是由 PDF 文件生成的文字版，不是{{noun}}本身

## `source.pdf_projection_locator.guide`

用途：上一条的指引。

出处写 PDF 文件加页与块，例如 {{file}}#p3-2

## `part.copy_kb_locator`

用途：知识库出处读不到时指引里常用的一句。

出处照抄任务现状消息（或查询任务状态）里那份文档后面给出的写法

## `source.knowledge_locator_unreadable.no_root`

用途：知识库出处，但这个任务没有知识库。

{{where}}的出处 {{locator}} 指向知识库里的文档，但这个任务没有知识库

## `source.knowledge_locator_unreadable.no_root.guide`

用途：上一条的指引。

任务现状消息里没有列出知识库时，不要写 knowledge/ 开头的出处

## `source.knowledge_locator_unreadable.bad_form`

用途：知识库出处的写法不对。

{{where}}的出处 {{locator}} 不是知识库文档的写法

## `source.knowledge_locator_unreadable.bad_form.guide`

用途：上一条的指引。copy 是 part.copy_kb_locator。

出处写 knowledge/知识库编号/文档名；{{copy}}

## `source.knowledge_locator_unreadable.gone`

用途：知识库出处指的知识库已经不在了。

{{where}}的出处 {{locator}} 指向的知识库 {{library}} 已经不在了

## `source.knowledge_locator_unreadable.gone.guide`

用途：上一条的指引。

只能引用这个任务选用的知识库里的文档；{{copy}}

## `source.knowledge_locator_unreadable.not_selected`

用途：知识库出处指的知识库这个任务没有选用。

{{where}}的出处 {{locator}} 指向知识库「{{name}}」里的文档，而这个任务没有选用知识库「{{name}}」

## `source.knowledge_locator_unreadable.not_selected.guide`

用途：上一条的指引。

只能引用这个任务选用的知识库里的文档，清单见任务现状消息或查询任务状态

## `source.knowledge_locator_unreadable`

用途：知识库出处指的文档在知识库里找不到。

{{where}}的出处 {{locator}} 指向的文档《{{document}}》在知识库「{{name}}」里找不到

## `source.knowledge_locator_unreadable.guide`

用途：上一条的指引。

{{copy}}；文档已经从知识库删除时，不要把它当作来源

## `source.material_not_found`

用途：文本材料的出处读不到。

{{where}}的出处 {{locator}} 不是任务目录里能读到的材料文件

## `source.material_not_found.guide`

用途：上一条的指引。

出处要写材料文件的路径，例如 inputs/材料.md

## `part.exact_excerpt`

用途：摘录对不上时指引的第一句（模型常自行补句号或改写）。noun 是「材料」或「文档」。

摘录必须与{{noun}}原文逐字一致，包括标点；不要自行补标点或改写

## `part.several_places`

用途：摘录不连续时说明引几处写几条来源。

引了{{noun}}几处就写几条来源

## `source.material_excerpt_not_contiguous`

用途：文本材料里摘录不是连续的一段（摘录里有空行）。file 是文件名。

{{where}}的摘录在 {{file}} 里不是连续的一段原文

## `source.material_excerpt_not_contiguous.guide`

用途：上一条的指引。exact 是 part.exact_excerpt，several 是 part.several_places。

{{exact}}；摘录必须逐字抄自{{noun}}里连续的一段，不要跳句拼接或改字；{{several}}

## `source.material_excerpt_not_found`

用途：文本材料里找不到摘录。

{{where}}的摘录「{{excerpt}}」在 {{file}} 里找不到

## `source.material_excerpt_not_found.guide`

用途：上一条的指引。

{{exact}}；摘录必须逐字抄自{{noun}}里连续的一段，不要跳句拼接或改字；{{several}}

## `source.material_excerpt_in_other_file`

用途：文本材料里找不到摘录，在材料目录的另一份材料里逐字找到了。places 是前几处（part.other_file_place 用「、」接起来），more 是空的或者 part.more_places。

{{where}}的摘录「{{excerpt}}」在 {{file}} 里找不到；这段文字在{{places}}{{more}}

## `source.material_excerpt_in_other_file.guide`

用途：上一条的指引。locator 是找到的第一处的出处写法，confirm 是空的或者 part.other_file_confirm。

出处改写成 {{locator}}{{confirm}}

## `part.docx_pointer_legacy`

用途：Word 材料的段落号在哪里看（早先的纯文本文字版）。file 是文字版的文件名。

段落号见 {{file}} 每行开头的「第 N 段」

## `part.docx_pointer`

用途：Word 材料的段落号在哪里看。

段落号见 {{file}} 里每段前面方括号中的 p 加数字（例如 [p12]）

## `source.docx_no_paragraph`

用途：Word 出处没有写段落号。path 是 Word 文件。

{{where}}的出处 {{path}} 没有写段落号

## `source.docx_no_paragraph.guide`

用途：上一条的指引。pointer 是 part.docx_pointer 那一句。

Word {{noun}}的出处要写段落号，例如 {{path}}#p12；{{pointer}}

## `source.docx_projection_missing.knowledge`

用途：知识库里的 Word 文档找不到它的文字版。

{{where}}的出处 {{path}} 在知识库里找不到由它生成的 {{name}}.md，摘录无从核对

## `source.docx_projection_missing.knowledge.guide`

用途：上一条的指引。

{{copy}}

## `source.docx_projection_missing`

用途：任务目录里的 Word 材料找不到它的文字版。

{{where}}的出处 {{path}} 不是任务目录里能读到的 Word 材料（找不到由它生成的 {{name}}.md）

## `source.docx_projection_missing.guide`

用途：上一条的指引。

出处要写材料目录里的 Word 文件加段落号，例如 inputs/材料.docx#p12

## `source.docx_paragraph_out_of_range`

用途：Word 出处的段落号超出了段数。

{{where}}的出处写的是第 {{n}} 段，{{name}} 一共只有 {{count}} 段

## `source.docx_paragraph_out_of_range.guide`

用途：上一条的指引。

{{pointer}}

## `part.docx_label`

用途：说到 Word 材料的第几段（表格里的另由代码接上「·位置」）。

第 {{n}} 段

## `part.docx_head`

用途：Word 材料里那一段找不到摘录时几种拒绝共用的开头。label 是 part.docx_label。

{{where}}的摘录「{{excerpt}}」在 {{name}} {{label}}里找不到

## `part.more_places`

用途：摘录在好几处、只列出最近几处时接在后面的半句。

等 {{count}} 处

## `part.other_file_place`

用途：摘录在另一份材料里的一处：哪份材料，接着是第几段（part.docx_label）或第几页第几块（part.pdf_label）；文本材料没有位置，label 是空的。

《{{name}}》{{label}}

## `part.other_file_confirm`

用途：摘录在别的材料里有好几处时，接在指引后面的半句。

；这段文字有好几处，请按上下文确认是其中哪一处，出处写那一处

## `source.docx_excerpt_elsewhere_one`

用途：摘录不在写的那一段，只在另一段。head 是 part.docx_head。

{{head}}，它在{{label}}

## `source.docx_excerpt_elsewhere_one.guide`

用途：上一条的指引。

出处改写成 {{path}}#p{{n}}

## `source.docx_excerpt_elsewhere_many`

用途：摘录不在写的那一段，在别的好几段里都有。labels 是那几段（part.docx_label），more 是空的或者 part.more_places。

{{head}}；这段文字在{{labels}}{{more}}都有

## `source.docx_excerpt_elsewhere_many.guide`

用途：上一条的指引。

请按上下文确认是哪一段，出处写那一段的段落号

## `source.docx_excerpt_in_other_file`

用途：Word 材料里哪一段都没有摘录，在材料目录的另一份材料里逐字找到了。head 是 part.docx_head，places 与 more 同 source.material_excerpt_in_other_file。

{{head}}；这段文字在{{places}}{{more}}

## `source.docx_excerpt_in_other_file.guide`

用途：上一条的指引。locator 与 confirm 同 source.material_excerpt_in_other_file.guide。

出处改写成 {{locator}}{{confirm}}

## `source.docx_excerpt_not_contiguous`

用途：Word 材料里摘录不是连续的一段（摘录里有空行）。span 是往后接的段数上限。

{{where}}的摘录在 {{name}} 的 p{{n}} 及其后 {{span}} 段里不是连续的一段原文

## `source.docx_excerpt_not_contiguous.guide`

用途：上一条的指引。

{{several}}，每条各写段落号

## `source.docx_excerpt_in_textbox`

用途：摘录在文本框里。

{{head}}；这段文字在文本框里，文本框里的文字不能作出处

## `source.docx_excerpt_in_textbox.guide`

用途：上一条的指引。

请改引正文里说到同一件事的段落；正文里没有，就不要把这一处当作来源

## `source.docx_excerpt_not_found`

用途：Word 材料里那一段找不到摘录，别处也没有。

{{head}}

## `source.docx_excerpt_not_found.guide`

用途：上一条的指引。

{{exact}}；摘录必须逐字抄自那一段的正文（不带段落号、编号与 #、- 这些标记），不要跳句拼接或改字；{{several}}，每条各写段落号

## `part.pdf_pointer`

用途：PDF 材料的页与块在哪里看。

页与块见 {{name}}.md 里每行开头方括号中的 p页-块（例如 [p3-2] 是第 3 页第 2 块）

## `source.pdf_no_page_block`

用途：PDF 出处没有写页与块。

{{where}}的出处 {{path}} 没有写页与块

## `source.pdf_no_page_block.bad_form`

用途：PDF 出处里页与块的写法不对。

{{where}}的出处 {{locator}} 里页与块的写法不对

## `source.pdf_no_page_block.guide`

用途：上两条的指引。pointer 是 part.pdf_pointer。

PDF {{noun}}的出处要写页与块，例如 {{path}}#p3-2；{{pointer}}

## `source.pdf_projection_missing.knowledge`

用途：知识库里的 PDF 文档找不到它的文字版。

{{where}}的出处 {{path}} 在知识库里找不到由它生成的 {{name}}.md，摘录无从核对

## `source.pdf_projection_missing.knowledge.guide`

用途：上一条的指引。

{{copy}}

## `source.pdf_projection_missing`

用途：任务目录里的 PDF 材料找不到它的文字版。

{{where}}的出处 {{path}} 不是任务目录里能读到的 PDF 材料（找不到由它生成的 {{name}}.md）

## `source.pdf_projection_missing.guide`

用途：上一条的指引。

出处要写材料目录里的 PDF 文件加页与块，例如 inputs/材料.pdf#p3-2

## `part.pdf_label`

用途：说到 PDF 材料的第几页第几块。

第 {{page}} 页第 {{block}} 块

## `source.pdf_block_zero`

用途：PDF 出处写的是没有文字的那一页的块 0。

{{where}}的出处写的是第 {{page}} 页的块 0，那一行只是说明这一页没有文字，不能作出处

## `source.pdf_block_zero.guide`

用途：上一条的指引。

请改引有文字的页；这一页是图片或扫描件时，不要把它当作来源

## `source.pdf_page_block_out_of_range.page`

用途：PDF 出处的页超出了页数。

{{where}}的出处写的是第 {{page}} 页，{{name}} 一共只有 {{pages}} 页

## `source.pdf_page_block_out_of_range`

用途：PDF 出处的块超出了这一页的块数。label 是 part.pdf_label，blocks 是 part.pdf_blocks_on_page 或 part.pdf_no_blocks。

{{where}}的出处写的是{{label}}，{{name}} 的第 {{page}} 页{{blocks}}

## `source.pdf_page_block_out_of_range.guide`

用途：上两条的指引。

{{pointer}}

## `part.pdf_blocks_on_page`

用途：PDF 一页有几块。

只有 {{count}} 块

## `part.pdf_no_blocks`

用途：PDF 一页没有可以作出处的块。

没有可以作出处的块

## `part.pdf_head`

用途：PDF 材料里那一块找不到摘录时几种拒绝共用的开头。

{{where}}的摘录「{{excerpt}}」在 {{name}} {{label}}里找不到

## `source.pdf_excerpt_cross_page`

用途：PDF 摘录跨到了后面的页。

{{where}}的摘录从 {{name}} {{label}}接到了后面的页，摘录不能跨页

## `source.pdf_excerpt_cross_page.guide`

用途：上一条的指引。

一页写一条来源：把摘录在换页的地方分成两段，各写各的页与块

## `source.pdf_excerpt_elsewhere_one`

用途：摘录不在写的那一块，只在另一块。

{{head}}，它在{{label}}

## `source.pdf_excerpt_elsewhere_one.guide`

用途：上一条的指引。

出处改写成 {{path}}#p{{page}}-{{block}}

## `source.pdf_excerpt_elsewhere_many`

用途：摘录不在写的那一块，在别的好几块里都有。

{{head}}；这段文字在{{labels}}{{more}}都有

## `source.pdf_excerpt_elsewhere_many.guide`

用途：上一条的指引。

请按上下文确认是哪一块，出处写那一块的页与块

## `source.pdf_excerpt_in_other_file`

用途：PDF 材料里哪一块都没有摘录，在材料目录的另一份材料里逐字找到了。head 是 part.pdf_head，places 与 more 同 source.material_excerpt_in_other_file。

{{head}}；这段文字在{{places}}{{more}}

## `source.pdf_excerpt_in_other_file.guide`

用途：上一条的指引。locator 与 confirm 同 source.material_excerpt_in_other_file.guide。

出处改写成 {{locator}}{{confirm}}

## `source.pdf_excerpt_not_contiguous`

用途：PDF 材料里摘录不是连续的一段（摘录里有空行）。

{{where}}的摘录在 {{name}} 的{{label}}及其后 {{span}} 块里不是连续的一段原文

## `source.pdf_excerpt_not_contiguous.guide`

用途：上一条的指引。

{{several}}，每条各写页与块

## `source.pdf_excerpt_not_found`

用途：PDF 材料里那一块找不到摘录，别处也没有。

{{head}}

## `source.pdf_excerpt_not_found.guide`

用途：上一条的指引。

{{exact}}；摘录必须逐字抄自那一块的文字（不带行首方括号里的页与块），不要跳句拼接或改字；{{several}}，每条各写页与块

## `source.no_task_record_for_check`

用途：回复的依据要核对，而任务目录还没有任务记录。

这个任务目录还没有任务记录，依据无从核对

## `source.material_role`

用途：当前活动的声明限定了材料的 role（「sources_from_roles」），这一条「文档原文」来源所指的材料的 role 不在里面（lib/source_roles.ts）。material 是材料的路径，role 是它的 role。

{{where}}引用的「{{material}}」是「{{role}}」一类的材料

## `source.material_role.guide`

用途：上一条的指引。roles 是这项活动认的 role，各带书名号，用「、」隔开。

这一步只能引用{{roles}}一类的材料

## `source.read_refused`

用途：当前活动的声明限定了材料的 role，自带的 read 要读的材料的 role 不在里面，这次调用不执行，这句作为工具结果交给助手（hooks/source_roles.ts）。material 是材料的路径，role 是它的 role，roles 是这项活动认的 role。

这一步只读{{roles}}一类的材料：「{{material}}」是「{{role}}」一类的，这次没有读它。

## `source.read_missing_material`

用途：材料表里有这份材料而文件不在（从不带材料的数据包导入、还没补齐），自带的 read 要读它或由它生成的文字版，这次调用不执行，这句作为工具结果交给助手（hooks/missing_material.ts）。name 是那份材料的文件名。

材料 {{name}} 的文件缺失，请用户在材料页补齐后再读；不要凭记忆补写它的内容。

## `source.grep_refused`

用途：同上，自带的 grep 的 path 指向 role 不在里面的材料，或者指向含有这种材料的目录（不写 path 时是任务目录）。kinds 是这项活动认的 role，不带书名号，用「或」隔开。

这一步只读{{roles}}一类的材料：这次要搜的地方有「{{material}}」，它是「{{role}}」一类的，这次没有搜。请把 path 写成那份{{kinds}}。
