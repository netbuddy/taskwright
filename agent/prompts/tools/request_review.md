# 工具：请求评审（request_review）

登记工具时读入（agent/src/tools/request_review.ts）。正文每一段是一整行：发给模型的文字里没有换行。

## `request_review.description`

用途：工具的总说明，登记工具时交给 pi，随工具清单发给模型。

只在用户在对话里要求评审时调用，请评审者按规则清单评审条目的当前内容；items 不写就评全部待评审的条目。它逐条返回合规或不合规，以及每条发现（规则编号、字段、问题、改法），发现分问题（必选规则）与建议（可选规则）两类。评审平时由用户在界面上发起，不要主动调用。

## `request_review.snippet`

用途：pi 的 promptSnippet：工具清单里这个工具的一句话。

用户在对话里要求评审时，请评审者按规则清单评审条目

## `request_review.param.items`

用途：参数 items 的说明，随参数结构发给模型。

要评审的条目，每项是 { item_id, revision_no }；不写就评全部待评审的条目。

## `request_review.param.items.item_id`

用途：参数 items.item_id 的说明，随参数结构发给模型。

条目编号，例如 UC-001。

## `request_review.param.items.revision_no`

用途：参数 items.revision_no 的说明，随参数结构发给模型。

条目当前所在的修订号。
