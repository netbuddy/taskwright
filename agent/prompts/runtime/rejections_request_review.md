# 请求评审的拒绝语

「请求评审」（request_review）与页面上发起评审被拒时的文字（`agent/src/lib/review.ts`）。键的写法见 `rejections_shared.md` 的开头。
评审规矩读不出来、库或任务不在不是输入的问题，不记进拒绝表。

## `part.review_refused`

用途：助手在不能评审的阶段请求评审时的整句：事实与怎么办两段（rejections_shared.md 的 gate.stage_review）。

什么都没有评：{{fact}}。
怎么办：{{guidance}}。

## `request_review.items_not_nonempty_list`

用途：items 写了，但不是不为空的列表。

items 要么不写（评全部待评审的条目），要么写一个不为空的列表，每项是 { item_id, revision_no }。什么都没有评。

## `request_review.item_id_missing`

用途：items 的某一项没有写条目编号。no 从 1 起。

items 的第 {{no}} 项要写 item_id（条目编号，例如 UC-001）。什么都没有评。

## `request_review.revision_no_invalid`

用途：items 的某一项没有写从 1 起的整数修订号。

items 的第 {{no}} 项（{{item}}）要写 revision_no，一个从 1 起的整数。什么都没有评。

## `request_review.item_duplicate`

用途：items 里同一个条目写了两次。

items 里 {{item}} 写了两次。什么都没有评。

## `part.review_nothing_because`

用途：点名的条目有不能评的，几条原因用「；」接起之后的整句。

什么都没有评，因为：{{problems}}。

## `request_review.item_not_found`

用途：点名的条目在库里没有（接在 part.review_nothing_because 里）。

库里没有条目 {{item}}

## `request_review.item_deleted`

用途：点名的条目已经删除了。

条目 {{item}} 已经删除了

## `request_review.collection_not_reviewed`

用途：点名的条目所在的集合不要求评审。

条目 {{item}} 所在的集合「{{collection}}」不要求评审

## `request_review.revision_stale`

用途：点名时写的修订号不是条目现在所在的修订。

条目 {{item}} 现在是修订 {{now}}，你写的是修订 {{given}}；只能评条目当前所在的修订

## `request_review.already_reviewed`

用途：点名的条目在当前修订、当前规则下已经评过。

{{item}} 在当前修订上已经评过，内容和规则都没变；同一次修订、同一套规则只评审一次

## `request_review.rules_unreadable`

用途：集合的评审规矩读不出来。不是输入的问题，不记进拒绝表。

集合「{{collection}}」的评审规矩读不出来：{{why}}

## `request_review.nothing_to_review`

用途：一个要评审的条目也没有。

没有需要评审的条目：要评审的集合里，每个条目在当前所在的修订、当前规则下都已经有评审记录了。

## `request_review.no_database`

用途：任务目录还没有任务库。不是输入的问题，不记进拒绝表。

这个任务目录还没有任务数据库，没有条目可以评审。

## `request_review.no_task`

用途：库里还没有任务记录。不是输入的问题，不记进拒绝表。

库里还没有任务，没有条目可以评审。
