# 界面操作说明

用户在页面上做了一件事之后，往会话里追加的那条说明（给助手看，开头写明「不是用户打的字」），以及系统替用户发给助手的那句话。
页面另按操作的种类写给用户看的话，不显示这里的大多数句子；页面也显示的那几句在 `runtime/shared.md`。
条目清单的分隔（「、」）、引号与字段内容的排法由代码定，这里只放整句话与句中带字的片段。

## `ui_ops.stop_run`

用途：用户在界面上停止了助手正在进行的这一次运行之后，留在会话里的那句话（lib/user_ops.ts 的 STOP_RUN_NOTE）。

界面操作（不是用户打的字）：用户在界面上停止了你这一次的工作，停下时正在做的那一步没有做完。

## `ui_ops.edit_fields`

用途：用户在界面上改了一个条目的字段。fields 是改到的字段名（各加引号），confirmed 是 ui_ops.confirmed 那一句，content 是改后的各字段内容。

界面操作（不是用户打的字）：用户改了 {{item}} 的{{fields}}，产生修订 {{revision}}，{{item}} 现在是修订 {{revision}}。{{confirmed}}改后的内容是：
{{content}}

## `ui_ops.delete_items`

用途：用户在界面上删除了条目。items 是 ui_ops.deleted_item 的清单。

界面操作（不是用户打的字）：用户删除了 {{items}}，产生修订 {{revision}}。这些条目已删除，不再算在交付物里。

## `ui_ops.deleted_item`

用途：删除说明里的一个条目：编号与删除前所在的修订。

{{item}}（删除前在修订 {{revision}}）

## `ui_ops.keep_pending`

用途：用户在界面上把问题条目标为先不管。status 是改成的状态值，confirmed 是 ui_ops.confirmed 那一句。

界面操作（不是用户打的字）：用户把 {{items}} 标为先不管（状态改为「{{status}}」），产生修订 {{revision}}，{{items}} 现在是修订 {{revision}}。{{confirmed}}

## `ui_ops.confirmed`

用途：改字段与标为先不管的说明里的那一句：用户亲手改出来的内容，同时算作用户看过并认可了。items 是 ui_ops.item_at_revision 的清单。

这次修改同时算作用户看过并认可了 {{items}}。

## `ui_ops.item_at_revision`

用途：说明里点名一个条目在哪次修订：编号与修订号。

{{item}}（修订 {{revision}}）

## `ui_ops.mark_viewed`

用途：用户在卡片上点「这几条都看过了」之后，留在会话里的那条说明（系统另替用户发 ui_ops.viewed_notice 那句话）。

界面操作（不是用户打的字）：用户在卡片上表示看过了 {{items}}，已记为已读。

## `ui_ops.undo`

用途：用户撤销了一次修订。changes 是 ui_ops.undo_deleted、ui_ops.undo_updated、ui_ops.undo_restored 的清单；contents 是各条目现在的内容（每个条目一段 ui_ops.undo_content，各自另起一行），没有时是空的。

界面操作（不是用户打的字）：用户撤销了修订 {{undone}}，产生修订 {{revision}}：{{changes}}。{{contents}}

## `ui_ops.undo_deleted`

用途：撤销说明里的一项：撤销的那次修订新增了这个条目，撤销时删除它。

删除 {{item}}（这是修订 {{undone}} 新增的）

## `ui_ops.undo_updated`

用途：撤销说明里的一项：撤销的那次修订改了这个条目，撤销时改回原来的内容。

改回 {{item}}（{{item}} 退回修订 {{back_to}} 的内容，现在是修订 {{revision}}）

## `ui_ops.undo_restored`

用途：撤销说明里的一项：撤销的那次修订删除了这个条目，撤销时恢复它。

恢复 {{item}}（{{item}} 退回修订 {{back_to}} 的内容，现在是修订 {{revision}}）

## `ui_ops.undo_content`

用途：撤销说明末尾，一个条目现在的内容。

{{item}} 现在的内容是：
{{fields}}

## `ui_ops.waive`

用途：用户保留了评审不合规的条目现在的写法，没有写理由。items 是 ui_ops.item_at_revision 的清单。

界面操作（不是用户打的字）：用户保留了 {{items}}现在的写法，没有写理由。这条按用户的决定算通过；条目再改动，评审要重做。

## `ui_ops.waive_reason`

用途：用户保留了评审不合规的条目现在的写法，写了理由。

界面操作（不是用户打的字）：用户保留了 {{items}}现在的写法，理由：「{{reason}}」。这条按用户的决定算通过；条目再改动，评审要重做。

## `ui_ops.unwaive`

用途：用户撤销了对条目的保留。

界面操作（不是用户打的字）：用户撤销了对 {{items}} 的保留，这些条目重新算作评审不通过。

## `ui_ops.activity_start`

用途：一次启动工作项或者一次流程换站之后，往会话里追加的那句说明。sentence 是 runtime/shared.md 里 stage.start_* 那一句，reason 是空的或者 ui_ops.reason，scope 是空的或者 stage.scope 那一句。

界面操作（不是用户打的字）：{{sentence}}{{reason}}{{scope}}

## `ui_ops.reason`

用途：流程换站时用户写了理由，接在那一句后面。

理由：{{reason}}

## `ui_ops.work_item_continued`

用途：用户新建一条会话接着做一个工作项时，往会话里追加的那句说明。sentence 是 stage.continued 或 stage.continued_at，scope 是空的或者 stage.scope 那一句。

界面操作（不是用户打的字）：{{sentence}}{{scope}}

## `ui_ops.work_item_deleted`

用途：用户删除一个工作项时，往会话里追加的那句说明。sentence 是 stage.deleted 或 stage.deleted_archived。

界面操作（不是用户打的字）：{{sentence}}

## `ui_ops.publish`

用途：用户在页面上发布了一个版本，没有写发布说明。

界面操作（不是用户打的字）：用户在页面上发布了第 {{version}} 版（修订 {{revision}}）。发布之后任务照常可以修改，以后可以再发布新的一版。

## `ui_ops.publish_note`

用途：用户在页面上发布了一个版本，写了发布说明。

界面操作（不是用户打的字）：用户在页面上发布了第 {{version}} 版（修订 {{revision}}），发布说明：{{note}}。发布之后任务照常可以修改，以后可以再发布新的一版。

## `ui_ops.review_rules`

用途：用户改了一个集合的评审规则。change 是 ui_ops.rules_off、ui_ops.rules_promote（两样都有时用「；」接起）或者 ui_ops.rules_none。

界面操作（不是用户打的字）：用户改了集合「{{collection}}」的评审规则，现在{{change}}。之后的评审按新规则；规则改了，这个集合的条目都要重新评审，已有的评审记录不变。

## `ui_ops.rules_off`

用途：改评审规则的说明里，关闭了哪几条规则。

关闭 {{rules}}

## `ui_ops.rules_promote`

用途：改评审规则的说明里，哪几条规则升为必选。

升为必选 {{rules}}

## `ui_ops.rules_none`

用途：改评审规则之后，没有关闭、也没有升为必选的规则。

没有关闭或升为必选的规则

## `ui_ops.continue_back`

用途：用户在提议退回的卡片上选了留在本段（lib/user_stage.ts）。enter 是退回那一项的字，stay 是留下那一项的字，stage 是提议退回的那个阶段。

界面操作（不是用户打的字）：用户在提议「{{enter}}」的卡片上选了「{{stay}}」，没有退回{{stage}}。这个提议仍然开着，用户要退回时会自己点，不用再发同一张卡片。

## `ui_ops.continue_review_ok`

用途：用户在请过目的卡片上选了「看过了，生成文档」那一项。

界面操作（不是用户打的字）：用户在请你过目的卡片上选了「{{option}}」：卡片点名的页已经记为看过。生成文档由用户在界面上按，你不用为此再做什么。

## `ui_ops.continue_review_fix`

用途：用户在请过目的卡片上选了「需要修改」那一项。

界面操作（不是用户打的字）：用户在请你过目的卡片上选了「{{option}}」。等用户说要改哪里，照着改，改完再发一次请过目的卡片。

## `ui_ops.continue_idle`

用途：会话空闲时，用户在提议开始一项活动的卡片上选了不开始的那一项。

界面操作（不是用户打的字）：用户在提议「{{enter}}」的卡片上选了「{{stay}}」，没有开始{{stage}}，任务仍然空闲。这个提议仍然开着，用户要开始时会自己点，不用再发同一张卡片。

## `ui_ops.continue_stay`

用途：用户在提议进入下一段的卡片上选了「继续本阶段」。

界面操作（不是用户打的字）：用户在提议「{{enter}}」的卡片上选了「{{stay}}」，没有进入{{stage}}。这个提议仍然开着，用户要进入时会自己点，不用再发同一张卡片。

## `ui_ops.edit_diagram`

用途：用户在界面上改了一张图的 Mermaid 文本（lib/user_diagram.ts）。

界面操作（不是用户打的字）：用户在界面上改了图 {{diagram}}「{{name}}」的 Mermaid 文本，{{diagram}} 现在是修订 {{revision}}。要看现在的文本，用 get_item 写 {{diagram}}。

## `ui_ops.ui_click_option`

用途：用户在回复的卡片上点了一个选项，记下的那条界面点击（hooks/user_commands.ts）。option 是选项的字（有键时带键），已加引号。

界面点击（不是用户打的字）：用户在回复 {{reply}} 的卡片上选了{{option}}。

## `ui_ops.ui_click_button`

用途：用户在回复的卡片上点了一个没有选项文字的按钮。

界面点击（不是用户打的字）：用户在回复 {{reply}} 的卡片上点了一个按钮。

## `ui_ops.review_done`

用途：用户在界面上发起的评审结束后，往会话里追加的那句说明。result 是 ui_ops.review_counts、ui_ops.review_counts_unfinished、评审出错的原话或 ui_ops.review_not_finished。

界面操作（不是用户打的字）：用户在界面上发起的评审结束了。{{result}}各条发现可以用查询任务状态查看。

## `ui_ops.review_counts`

用途：界面发起的评审全部评完时的结论；也是终端界面里弹出的那一句。

评审完成：{{passed}} 条合规、{{failed}} 条不合规（问题 {{problems}} 处、建议 {{advice}} 条）。

## `ui_ops.review_counts_unfinished`

用途：界面发起的评审有几条没有评完时的结论。

评审完成：{{passed}} 条合规、{{failed}} 条不合规（问题 {{problems}} 处、建议 {{advice}} 条），{{unfinished}} 条没有评完。

## `ui_ops.review_not_finished`

用途：界面发起的评审没有结果、也没有出错原话时的结论。

评审没有做完。

## `ui_ops.keep_pending_notice`

用途：用户在页面上点「先不管这条」之后，后端替用户发给助手的那句话（backend/src/executor.ts）。后端与助手按它的开头认出这句不是用户打的字。

我先不管 {{items}}，请接着往下做。
