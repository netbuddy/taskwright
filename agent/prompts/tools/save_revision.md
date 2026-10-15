# 工具：保存修订（save_revision）

登记工具时读入（agent/src/tools/save_revision.ts）。正文每一段是一整行：发给模型的文字里没有换行。

## `save_revision.description`

用途：工具的总说明，登记工具时交给 pi，随工具清单发给模型。

把交付物的一批改动存成一次新修订。改动的单位是条目：新增一个条目、修改某个条目的某几个字段、删除一个条目；一次调用可以带多个操作，整批只产生一次修订。条目编号由工具生成。每个新增的条目至少带一条来源。修改与删除时要写 base_revision（你所见的这个条目当前所在的修订号）。它只核对集合、字段、类型、必填与来源是否齐全，不评判内容好坏，也不代表任务完成。有任何一个操作不对，整批都不写入，它会逐条告诉你哪个操作的哪一处不对。

## `save_revision.snippet`

用途：pi 的 promptSnippet：工具清单里这个工具的一句话。

把交付物的一批按条目的改动存成一次新修订

## `save_revision.param.operations`

用途：参数 operations 的说明，随参数结构发给模型。

这次要保存的操作列表，至少一个。整批操作一起形成一次修订；有一个不对，整批都不写入。

## `save_revision.param.operations.op`

用途：参数 operations.op 的说明，随参数结构发给模型。

操作的种类：add 是新增一个条目，update 是修改一个条目，delete 是删除一个条目。

## `save_revision.param.operations.collection`

用途：参数 operations.collection 的说明，随参数结构发给模型。

新增时写条目所属的集合名，例如「功能用例」。修改与删除时不写。

## `save_revision.param.operations.item`

用途：参数 operations.item 的说明，随参数结构发给模型。

修改与删除时写条目编号，例如 UC-001。新增时不写，编号由工具生成。

## `save_revision.param.operations.base_revision`

用途：参数 operations.base_revision 的说明，随参数结构发给模型。

修改与删除时必须写：你所见的这个条目当前所在的修订号（返回与通知里「UC-001 现在是修订 N」的那个 N）。与库里的不符时整批拒绝，说明是谁把它改到了哪次修订。新增时不写。

## `save_revision.param.operations.fields`

用途：参数 operations.fields 的说明，随参数结构发给模型。

字段内容，键是任务定义里声明的字段名。新增时写全部必填字段；修改时只写要改的字段。文本写字符串，文本列表写字符串数组，枚举写取值之一，条目引用写条目编号的数组（例如 ["UC-001"]，可以是空数组），每个编号都要指向已有且没有删除的条目。

## `save_revision.param.operations.sources`

用途：参数 operations.sources 的说明，随参数结构发给模型。

这个条目的来源，至少一条。新增时必须给；修改时省略就沿用它当前的全部来源；给了就只替换这次改到的字段上的来源，没改的字段的来源沿用（只给 sources、不改字段时整体替换）。

## `save_revision.param.operations.sources.kind`

用途：参数 operations.sources.kind 的说明，随参数结构发给模型。

来源的种类，只能是「文档原文」「用户的话」「助手补充」「条目」「图」五者之一。

## `save_revision.param.operations.sources.locator`

用途：参数 operations.sources.locator 的说明，随参数结构发给模型。

出处：文档原文写文件路径；条目写所依据的那个条目的编号，例如 OA-002、UC-003；图写所依据的那张图的编号，例如 D-002。种类是「助手补充」时不用写；种类是「用户的话」时不要写，工具会在对话里找到那句话并代填。

## `save_revision.param.operations.sources.excerpt`

用途：参数 operations.sources.excerpt 的说明，随参数结构发给模型。

摘录的原文。用户的话要逐字照抄用户说过的一段原话；条目要逐字照抄那个条目当前内容里的一段，包括标点；图可以写空文字，也可以逐字照抄图里一个节点上的文字；助手补充在这里写一句理由：为什么这样补、依据的是什么常识或推断。

## `save_revision.param.operations.sources.normalized_value`

用途：参数 operations.sources.normalized_value 的说明，随参数结构发给模型。

只用于种类为「用户的话」的来源：你写进字段的值与用户原话不同时（例如原话是「应该是三十天吧」，写入的是「30 天」），在这里写写入的值。摘录仍要逐字照抄原话。写入的值与原话相同就不写。

## `save_revision.param.operations.sources.supports`

用途：参数 operations.sources.supports 的说明，随参数结构发给模型。

这条来源支持哪几处：每项写一个字段名，列表型字段还可以写 index 指到其中一项。这条来源支持整个条目时不写或写 []。

## `save_revision.param.operations.sources.supports.field`

用途：参数 operations.sources.supports.field 的说明，随参数结构发给模型。

这条来源支持的字段名，必须是这个集合声明的字段。

## `save_revision.param.operations.sources.supports.index`

用途：参数 operations.sources.supports.index 的说明，随参数结构发给模型。

列表型字段（文本列表、条目引用）里的第几项，从 0 起。不写表示支持整个字段。
