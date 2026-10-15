# 发布版本的拒绝语

「发布版本」（publish_version）与页面上发布被拒时的文字（`agent/src/lib/publish_version.ts`）。键的写法见 `rejections_shared.md` 的开头。
完成条件与用户同意这四种是守门类（缺前置步骤），别的是输入或时机的问题；存档没有做成、库或任务不在不是输入的问题，不记进拒绝表。

## `part.publish_not_published`

用途：助手在不能发布的阶段要发布时，事实层的说法：前面是第几版没有发布，后面接阶段拒绝的事实（rejections_shared.md 的 gate.stage_publish）。

第 {{version}} 版没有发布：{{fact}}。

## `publish_version.completion_unmet`

用途：完成条件没有全部满足。unread 是 part.publish_unread（没有未读时是空的），others 是 part.publish_others（别的条件都满足时是空的）；两段各自带着末尾的换行，由代码接上。

第 {{version}} 版没有发布。
{{unread}}{{others}}

## `part.publish_unread`

用途：完成条件没有满足时，用户还没看过的条目那一句。

还有 {{count}} 条你从没看过：{{list}}。

## `part.publish_others`

用途：完成条件没有满足时，另外没满足的条件；list 是每条一行的 part.publish_condition，带序号。

另有 {{count}} 条完成条件没有满足：
{{list}}

## `part.publish_condition`

用途：一条没满足的完成条件：集合、条件、现在的情形与还差哪几个条目（part.publish_missing，没有时是空的）。

「{{collection}}」{{condition}}：{{summary}}{{missing}}

## `part.publish_missing`

用途：一条没满足的完成条件还差的条目。

还差 {{items}}。

## `part.publish_unmet_guidance_unread`

用途：完成条件没有满足、有用户没看过的条目时的指引。

请把上面「还有 N 条你从没看过」那句原样告诉用户，请用户打开这几条看一眼；补齐之后再调用「发布版本」。

## `part.publish_unmet_guidance`

用途：完成条件没有满足、没有未读条目时的指引。

请把缺的告诉用户；补齐之后再调用「发布版本」。

## `publish_version.consent_none`

用途：用户还没有在问这个任务是否已经完成的卡片上点同意的那一项。

第 {{version}} 版没有发布：用户还没有在问这个任务是否已经完成的卡片上点「{{agree}}」。

## `publish_version.consent_declined`

用途：用户在最近一张问是否已经完成的卡片上选的是另一项。

第 {{version}} 版没有发布：用户在最近一张问这个任务是否已经完成的卡片上选的是「{{chosen}}」。

## `publish_version.consent_stale`

用途：用户同意之后交付物又有了新的修订。

第 {{version}} 版没有发布：用户在修订 {{agreed_at}} 时点了「{{agree}}」，之后交付物又有了修订 {{latest}}，要重新问。

## `part.publish_consent_guidance`

用途：用户同意那三种拒绝的指引：怎样问用户这个任务是否已经完成（publish_version.ts 的 CONSENT_GUIDANCE）。

请用回复的请选择（choose）问用户这个任务是否已经完成、可以发布了：问句照实写出事实与后果，例如「功能用例、非功能需求、约束一共 12 个条目，都已经评审通过或者由你保留了写法，你也都看过了，没有未解决的问题。这个任务是否已经完成、可以发布第 1 版？发布之后仍然可以接着修改，以后再发布新的一版。」（数字与事实照实填写）；两个选项是 { key: "{{key}}", text: "{{agree}}" } 与「{{decline}}」。用户在卡片上点了「{{agree}}」之后再调用「发布版本」；用户在对话里打字说要发布不算，照样先发卡片。

## `publish_version.page_revision_stale`

用途：用户在页面上发布时，页面看到的修订已经不是现在的（只在页面上发布时出现，说明给用户看）。

这次没有发布：你看到的是修订 {{seen}}，交付物现在已经是修订 {{latest}}。请看过现在的内容再发布。

## `publish_version.version_already_published`

用途：存档写好之后再核对时，别处已经先发布了这一版。

这次没有发布：第 {{version}} 版已经发布过了，请看过现在的版本再发布。

## `publish_version.revision_moved_during_archive`

用途：存档写好之后再核对时，交付物又有了新的修订。

这次没有发布：存档是按修订 {{archived}} 生成的，交付物现在已经是修订 {{now}}。请看过现在的内容再发布。

## `publish_version.archive_failed`

用途：这一版的文档没有存下来（任务服务联系不上、回答了错误等）。不是输入的问题，不记进拒绝表。why 是原因。

第 {{version}} 版没有发布：这一版的文档没有存下来（{{why}}）。这是程序这边的问题，不是交付物有问题。

## `publish_version.archive_failed.guide`

用途：上一条的指引。

请把这件事告诉用户，请用户稍后在页面上点「发布版本」再试。

## `publish_version.no_task`

用途：库里还没有任务记录。不是输入的问题，不记进拒绝表。

库里还没有任务，没有可以发布的版本。

## `publish_version.no_database`

用途：任务目录还没有任务库。不是输入的问题，不记进拒绝表。

这个任务目录还没有任务数据库，没有可以发布的版本。
