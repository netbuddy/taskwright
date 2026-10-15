# 查看条目的拒绝语

「查看条目」（get_item）被拒时的文字（`agent/src/lib/task_query.ts`）；「查询任务状态」与它共用开头两句（库或任务不在，不是输入的问题，不记进拒绝表）。
键的写法见 `rejections_shared.md` 的开头。

## `get_item.no_database`

用途：任务目录里还没有任务库。不是输入的问题，不记进拒绝表。

这个任务目录里还没有任务记录，没有东西可以查。任务由用户在界面上创建，请把这个情况如实告诉用户。

## `get_item.no_task`

用途：库里还没有任务记录。不是输入的问题，不记进拒绝表。

库里还没有任务记录，没有东西可以查。

## `get_item.item_id_missing`

用途：没有写条目编号。

item_id 要写条目编号，例如 UC-001。

## `get_item.revision_no_invalid`

用途：revision_no 写得不对。given 是写的值（JSON）。

revision_no 应当是从 1 起的整数，或者不写（看最新内容），现在写的是 {{given}}。

## `get_item.item_not_found`

用途：任务里没有这个条目。alive 是现有的条目（用「、」接起），一个都没有时是 part.no_items。

这个任务里没有条目 {{item}}。现有的条目是：{{alive}}。

## `part.no_items`

用途：任务里一个条目都没有时的说法。

（一个都没有）

## `get_item.item_deleted`

用途：条目已经删除了。

条目 {{item}} 已在修订 {{revision}} 删除，不在交付物里了。

## `get_item.revision_beyond_latest`

用途：要看的修订比最新的修订还晚。

这个任务还没有修订 {{wanted}}，最新是修订 {{newest}}。

## `get_item.item_absent_at_revision`

用途：要看的那次修订时还没有这个条目。list 是它改动过的修订（每个是 part.revision_no）。

修订 {{wanted}} 时还没有条目 {{item}}；它在这些修订里改动过：{{list}}。

## `part.revision_no`

用途：列出修订时的一个修订号。

修订 {{revision}}

## `get_item.diagram_not_found`

用途：任务里没有这张图。alive 是现有的图，一张都没有时是 part.no_diagrams。

这个任务里没有图 {{diagram}}。现有的图是：{{alive}}。

## `part.no_diagrams`

用途：任务里一张图都没有时的说法。

（一张都没有）

## `get_item.diagram_deleted`

用途：这张图已经删除了。

图 {{diagram}} 已经在它的修订 {{revision}} 删除了。现有的图是：{{alive}}。

## `get_item.diagram_revision_missing`

用途：这张图没有要看的那次修订。list 是它有的修订（每个是 part.revision_no）。

图 {{diagram}} 没有修订 {{wanted}}；它有这些修订：{{list}}（图的修订号是图自己的）。
