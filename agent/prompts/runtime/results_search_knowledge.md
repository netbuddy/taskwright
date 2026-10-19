# 查找知识库返回给助手的话

查找知识库（`agent/src/lib/knowledge_search.ts`）交还模型的文字：没有可查的、这一次没有做成、开头一句、每个片段的几行、裁剪的说明与末尾的说明。
参数写得不对时的拒绝在 `rejections_search_knowledge.md`。片段正文夹在 `result.search.body_open` 与 `result.search.body_close` 两行之间，摘录从这里面逐字抄。

## `result.search.retry`

用途：这一次没有做成时接在原因后面的话。

可以再查一次；仍然不成时把这个原因告诉用户，这一处先保留材料的原话并记一条问题条目。

## `result.search.no_knowledge`

用途：任务没有知识库。

这个任务没有知识库，没有可查的。

## `result.search.no_documents`

用途：任务选用的知识库里没有文档。

这个任务选用的知识库里没有文档，没有可查的。

## `result.search.unreachable`

用途：联系不上任务服务。retry 是 result.search.retry。

按意思查找这一次没有做成：联系不上系统里负责查找的那一部分。{{retry}}

## `result.search.failed`

用途：任务服务回答了错误。reason 是它给的原因（去掉了末尾的句号）。

按意思查找这一次没有做成：{{reason}}。{{retry}}

## `result.search.service_error`

用途：任务服务回答了错误而没有给原因时的那句原因。

系统回答了错误（HTTP {{status}}）

## `result.search.cancelled`

用途：助手取消了这次查找。

查找被取消了。

## `result.search.not_found`

用途：没有找到相关的片段。

没有找到相关的片段。换一种说法再查一次；换了说法仍然没有，才算知识库里没有。

## `result.search.closing`

用途：列完片段之后末尾的说明。

查到的片段就是逐字的原文：摘录从片段逐字抄，出处照片段给的写法写；不必再读知识库文件核对，保存时系统会逐字核对，对不上会退回并说明原因。

## `result.search.reason_not_selected`

用途：只按字面找的原因：没有选嵌入模型。

没有选嵌入模型

## `result.search.reason_provider_gone`

用途：只按字面找的原因：选定的嵌入模型所在的模型服务不在了。

选定的嵌入模型所在的模型服务不在了

## `result.search.reason_not_offered`

用途：只按字面找的原因：选定的模型服务不提供嵌入模型。

选定的模型服务不提供嵌入模型

## `result.search.reason_timeout`

用途：只按字面找的原因：把要找的话向量化时到时间没有算完。

按意思那一路没有做成：把要找的话向量化成数字串时，到时间没有算完

## `result.search.reason_unreachable`

用途：只按字面找的原因：连不上嵌入模型的模型服务。

按意思那一路没有做成：连不上嵌入模型的模型服务

## `result.search.reason_key_rejected`

用途：只按字面找的原因：模型服务拒绝了密钥。

按意思那一路没有做成：嵌入模型的模型服务拒绝了密钥

## `result.search.reason_service_error`

用途：只按字面找的原因：模型服务回答了错误。

按意思那一路没有做成：嵌入模型的模型服务回答了错误

## `result.search.reason_bad_answer`

用途：只按字面找的原因：模型服务回答的数字串不对。

按意思那一路没有做成：嵌入模型的模型服务回答的数字串不对

## `result.search.reason_other`

用途：只按字面找而原因认不出来时的说法。

按意思那一路没有做成

## `result.search.opening`

用途：开头的一句：这一次在多大的范围里、按哪一路找的。way 是 result.search.way_*；后面可能接还没有向量化、没有查到的几份文档。

查找「{{query}}」：在这个任务选用的 {{libraries}} 个知识库、{{documents}} 份文档、{{chunks}} 个片段里{{way}}。

## `result.search.way_keyword`

用途：这一次只按字面找了。reason 是 result.search.reason_*。

只按字面找（{{reason}}）

## `result.search.way_hybrid`

用途：这一次按两路找。

按意思与按字面两路找

## `result.search.partial`

用途：有几份文档还没有向量化、这一次对它们只按字面找了。pronoun 是 result.search.it 或 result.search.them。

{{documents}}还没有向量化，这一次对{{pronoun}}只按字面找了。

## `result.search.missed`

用途：有几份文档的文件读不出来、这一次没有查到。

{{documents}}这一次没有查到，因为{{pronoun}}的文件读不出来；没有找到不等于知识库里没有。

## `result.search.it`

用途：说到一份文档时的代词。

它

## `result.search.them`

用途：说到几份文档时的代词。

它们

## `result.search.document_name`

用途：一份文档的名字。

《{{name}}》

## `result.search.more_documents`

用途：多于 5 份文档时接在前 5 份后面。

等 {{count}} 份文档

## `result.search.found`

用途：查到了片段时接在开头一句后面的话。

下面是最相关的 {{count}} 个片段。排在前面不等于就是你要找的规定：逐个看正文，对得上的才引用；一个片段里有多条规定时逐条看。

## `result.search.trimmed`

用途：结果超过了字节上限、从末尾去掉了几个片段时的那一行。

（这一次的结果超过了 {{budget}} 字节的上限：还有 {{removed}} 条没有列出，缩小问题再查。）

## `result.search.truncated`

用途：第 1 个片段的正文也放不下、只显示了前几个字时的那一行。

（正文只显示了前 {{chars}} 字；要看后面的内容，把问题缩小再查。）

## `result.search.body_open`

用途：正文前面的记号。

<<<原文开始

## `result.search.body_close`

用途：正文后面的记号。

原文结束>>>

## `result.search.range_one`

用途：片段的位置只有一段、一行。unit 是 result.search.unit_*。

第 {{from}} {{unit}}

## `result.search.range`

用途：片段的位置是几段、几行。

第 {{from}} 到 {{to}} {{unit}}

## `result.search.unit_paragraph`

用途：位置的单位：段。

段

## `result.search.unit_line`

用途：位置的单位：行。

行

## `result.search.pdf_block`

用途：PDF 片段只有一块。

第 {{page}} 页第 {{block}} 块

## `result.search.pdf_blocks`

用途：PDF 片段有几块（片段不跨页）。

第 {{page}} 页第 {{block}} 到 {{last}} 块

## `result.search.position_unknown`

用途：片段的位置不详。

位置不详

## `result.search.empty_cell`

用途：表格结构里一个空格的写法。

（空）

## `result.search.rank_keyword`

用途：这一次只按字面找时的排名。

按字面排第 {{keyword}}

## `result.search.rank_both`

用途：两路都命中时的排名。

按意思排第 {{semantic}}，按字面排第 {{keyword}}

## `result.search.rank_semantic`

用途：只按意思命中时的排名。

按意思排第 {{semantic}}，按字面没有命中

## `result.search.rank_keyword_unconverted`

用途：只按字面命中、这份文档还没有向量化时的排名。

按字面排第 {{keyword}}，按意思没有比（这份文档还没有向量化）

## `result.search.hit_head`

用途：一个片段的第一行（片段没有标题时）。ranks 是 result.search.rank_*。

【第 {{no}} 个片段】知识库「{{library}}」《{{name}}》 · {{ranks}}

## `result.search.hit_head_titled`

用途：一个片段的第一行（片段有标题时）。

【第 {{no}} 个片段】知识库「{{library}}」《{{name}}》 · 标题：{{title}} · {{ranks}}

## `result.search.hit_position`

用途：片段的位置那一行。partial 是 result.search.hit_partial（不是长段的一截时为空）。

位置：{{position}}{{partial}}

## `result.search.hit_partial`

用途：片段是一段很长的文字切出来的一截。

（这一段很长，切成了几个片段，这里是其中的一截，不是全文）

## `result.search.locator_word`

用途：Word 文档的片段引用时出处怎样写。

引用时出处写：{{locator}}#p段落号（写摘录所在那一段的段落号）

## `result.search.locator_pdf`

用途：PDF 文档的片段引用时出处怎样写。

引用时出处写：{{locator}}#p页-块（写摘录所在那一块的页与块，例如 {{locator}}#p{{page}}-{{block}}）

## `result.search.locator`

用途：别的文档的片段引用时出处怎样写。

引用时出处写：{{locator}}

## `result.search.table`

用途：片段里有表格时表格的结构。rows 是各行（每行的各格用竖线隔开，行与行用分号隔开）。

表格结构（每个分号是表格的一行，竖线隔开各格，格里写的是它的段落号；一条来源只抄一格里的字，不要把一行的几格连起来抄）：{{rows}}

## `result.search.table_header`

用途：片段里的表格另带的表头。

这张表的表头（出自{{where}}，只帮你看懂各列，不在这个片段的位置范围里；要引用表头里的字，出处写它自己的段落号）：{{cells}}

## `result.search.body_word`

用途：Word 文档片段正文前的说明。

正文（每行是一段，开头方括号里是这一段的段落号，摘录不带它）：

## `result.search.body_pdf`

用途：PDF 文档片段正文前的说明。

正文（每行是一块，开头方括号里是这一块的页与块，摘录不带它；表格的一行是一块，各格之间隔着空格）：

## `result.search.body`

用途：别的文档片段正文前的说明。

正文：
