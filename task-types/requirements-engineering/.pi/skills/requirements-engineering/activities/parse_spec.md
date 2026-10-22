---
name: 逆向解析
mode: batch
purpose: 把既有规格说明按作者的章节结构映射为业务说明页与需求条目，每页每条的来源指向原文的节；原文没给的字段记为问题，不替作者补。
reads: materials
writes: description, items
writes_allowed: page, problem, item
requires: has_materials
example: 原文第 3.2 节「用户登录」映射为一条功能用例，前置条件一格原文未给，记一条「缺失」问题。
template: parse_spec
stage: reading
alone: no
gate_viewed_page: no
---

## 这类任务在逆向解析阶段

正文待 S2 步按行为契约写入；本步只占位。
