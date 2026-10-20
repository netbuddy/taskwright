# 系统提示里的固定几段

按会话拼系统提示时（`agent/src/lib/context_assemble.ts`）用到的几段固定文字。每一段带着自己的 Markdown 标题，所以正文写在围栏里。

## `stage_prompt.scope`

用途：用户启动工作项时写了范围说明：这个工作项各条会话的系统提示里，按活动拼的几段后面接这一段。scope 是用户写的范围说明（去掉首尾的空白）。

````text
## 本次范围说明

用户启动这个工作项时写了范围说明。这一次照它说的范围做；它没有说到的，照上面的说明。

本次范围说明：{{scope}}
````

## `stage_prompt.compose_failed`

用途：按会话拼系统提示没有拼成（模块缺了、头写得不对、重名、次序号相同、活动或工作流的定义读不成）时，停下这次运行，写进会话给用户看的那一句。reason 是拼不成的原因。这次运行不调用模型，也不沿用以前拼好的任何一份说明。

````text
这一次助手没有开始工作：拼它的工作说明时出了错，没有拼成。原因：{{reason}} 说明文件修好之前，在这条会话里说话助手都不会工作；请把这句话转给维护这台服务的人。
````

## `stage_prompt.position`

用途：系统提示里紧接系统提示之后、由程序生成的位置说明：本次会话在哪里、主要做什么、获准做哪几类写入。where 是在哪里的那半句（下面三个 where_ 之一），main 是主要工作（活动的头里「写」一栏各类资产的名字，空闲时是 main_idle），allowed 是获准能力（下面几个 can_ 用顿号接起来）。

````text
## 本次会话

本次会话在{{where}}。主要工作：{{main}}。获准的写入：{{allowed}}；别的写入工具会拒绝。
````

## `stage_prompt.where_flow`

用途：位置说明里，会话的工作项是一条工作流程时的「在哪里」。flow 是流程的名字，node 是现在这一站的名字。

````text
工作流程「{{flow}}」的「{{node}}」这一站
````

## `stage_prompt.where_single`

用途：位置说明里，会话的工作项是单项活动时的「在哪里」。activity 是活动的名字。

````text
单项活动「{{activity}}」里
````

## `stage_prompt.where_idle`

用途：位置说明里，自由讨论的会话（或者归档的会话）的「在哪里」。

````text
自由讨论中，不属于任何工作项
````

## `stage_prompt.main_idle`

用途：位置说明里，空闲时的主要工作。

````text
没有指定，照用户说的做
````

## `stage_prompt.can_page`

用途：位置说明里获准能力的一项：业务说明的页。

````text
立页、改页
````

## `stage_prompt.can_problem`

用途：位置说明里获准能力的一项：问题条目。

````text
记问题条目
````

## `stage_prompt.can_diagram`

用途：位置说明里获准能力的一项：图。

````text
画图、改图
````

## `stage_prompt.can_item`

用途：位置说明里获准能力的一项：别的集合的条目。

````text
写条目、改条目
````

## `stage_prompt.can_review`

用途：位置说明里获准能力的一项：请求评审。

````text
请求评审
````

## `stage_prompt.can_publish`

用途：位置说明里获准能力的一项：发布版本。

````text
发布版本
````

## `stage_prompt.flow_prev`

用途：「各步之间的转移」模块里说上一步的那半句。name 是上一步的活动名。

````text
上一步是「{{name}}」。
````

## `stage_prompt.flow_first`

用途：同上，现在是第一步时。

````text
这是第一步，前面没有别的步。
````

## `stage_prompt.flow_next`

用途：「各步之间的转移」模块里说下一步的那一句：提议进入时卡片上的两个选项。name 是下一步的活动名。

````text
下一步是「{{name}}」：提议进入时选项固定两个，`next_step`「进入下一步：{{name}}」、`stay`「继续本步」。
````

## `stage_prompt.flow_next_user_only`

用途：同上，下一步是只能由用户发起的活动（发布）时：只说明条件，不发卡片。name 是那项活动的名字，requires 是它声明里 requires 一栏的说法。

````text
下一步是「{{name}}」，只能由用户发起：这一步做完了，在成文的话里说明怎样{{name}}（{{requires}}），不发进入它的卡片。
````

## `stage_prompt.flow_last`

用途：同上，现在是最后一步时。

````text
这是最后一步，后面没有别的步。
````

## `stage_prompt.division_line`

用途：「各步之间的转移」模块里分工表的一行：一类资产由这条工作流里哪几步负责。asset 是资产的名字，steps 是活动名（用顿号接起来）。

````text
- {{asset}}：{{steps}}
````

## `stage_prompt.definition_view_note`

用途：助手读任务定义文件时，扩展换上的本会话视图开头的那段说明（lib/definition_view.ts）。position 是会话的位置（阶段名或空闲）。

````text
这是本会话（{{position}}）的任务定义视图，由任务服务按本会话能做的事给出，原文件没有改。只列本会话要参照或能写的集合：「可写」为真的集合本会话能新增或修改，字段与取值照这里写；为假的只供参照。没有列出的集合本会话用不到。
````
