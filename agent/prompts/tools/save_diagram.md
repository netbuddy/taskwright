# 工具：保存图（save_diagram）

登记工具时读入（agent/src/tools/save_diagram.ts）。正文每一段是一整行：发给模型的文字里没有换行。

## `save_diagram.description`

用途：工具的总说明，登记工具时交给 pi，随工具清单发给模型。

保存一张图：新画一张、修改一张已有的图，或者删除一张图。什么时候画图照说明里写的做。图用 Mermaid 文本写，种类是系统边界图（context，用流程图的写法画）、用例图（use_case，用流程图的写法画）、对象关系图（class，用类图的写法画）、状态图（state）、时序图（sequence）、流程图（flowchart）之一。新画一张图时必须写来源（sources），至少一条，不写就不保存。保存前系统校验 Mermaid 文本的写法，不对就不保存，并告诉你第几行附近错在哪里。图的编号由工具生成（D-001 这样）；修改与删除时写图的编号与 base_revision。图里画了某个条目时，把条目编号写在节点的文字里，并给它写一条种类为「条目」的来源。图不是条目：不评审，不算进完成条件。

## `save_diagram.snippet`

用途：pi 的 promptSnippet：工具清单里这个工具的一句话。

保存一张图（新画、修改或删除），保存前校验 Mermaid 文本

## `save_diagram.param.diagram`

用途：参数 diagram 的说明，随参数结构发给模型。

修改或删除一张已有的图时写它的编号，例如 D-001。新画一张图时不写，编号由工具生成。

## `save_diagram.param.base_revision`

用途：参数 base_revision 的说明，随参数结构发给模型。

修改或删除时写你所见的这张图现在的修订号（图自己的修订号）。新画时不写。

## `save_diagram.param.name`

用途：参数 name 的说明，随参数结构发给模型。

图名，一行字。新画时必填。

## `save_diagram.param.kind`

用途：参数 kind 的说明，随参数结构发给模型。

图的种类，只能是 {{kinds}} 之一。新画时必填。用例图用流程图的写法画。

## `save_diagram.param.mermaid`

用途：参数 mermaid 的说明，随参数结构发给模型。

Mermaid 文本。新画时必填。图里的节点画的是某个条目时，把条目编号写在节点的文字里，例如 r1(["REQ-001 提交申请"])。

## `save_diagram.param.note`

用途：参数 note 的说明，随参数结构发给模型。

一两句说明：这张图画的是什么。可以不写。

## `save_diagram.param.sources`

用途：参数 sources 的说明，随参数结构发给模型。

这张图的来源。新画时必填，至少一条：用户要你画图的那句话写一条「用户的话」，画进图里的每个条目各写一条种类为「条目」的来源（出处写条目编号）。不写 supports。修改时写 null 就沿用原来的，写了就是整份替换。删除时写 null。

## `save_diagram.param.sources.kind`

用途：参数 sources.kind 的说明，随参数结构发给模型。

来源的种类，只能是「文档原文」「用户的话」「助手补充」「条目」四者之一。

## `save_diagram.param.sources.locator`

用途：参数 sources.locator 的说明，随参数结构发给模型。

出处：文档原文写文件路径；条目写条目编号。种类是「用户的话」「助手补充」时不写。

## `save_diagram.param.sources.excerpt`

用途：参数 sources.excerpt 的说明，随参数结构发给模型。

摘录的原文：用户的话逐字照抄；助手补充在这里写理由。种类是「条目」时可以不写。

## `save_diagram.param.delete`

用途：参数 delete 的说明，随参数结构发给模型。

删除这张图时写 true，同时写 diagram 与 base_revision，别的都不写。
