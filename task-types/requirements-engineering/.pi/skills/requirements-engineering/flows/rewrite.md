---
flow: rewrite
name: 需求再工程
purpose: 把一份对目标系统有效力的既有规格说明按作者的结构解析为业务说明页与需求条目，对照补充证据审查，补全后发布新版。
applies: 存在一份对目标系统有效力的既有规格说明。
steps: parse_spec, reading, clarifying, modeling, writing, reviewing, document, publish
inputs: 既有规格说明（必填）、补充证据（可选）、目标系统描述
slot.spec: name=既有规格说明; accepts=materials; required=true; role=既有规格说明
slot.evidence: name=补充证据; accepts=materials; required=false; role=证据
slot.goal: name=目标系统描述; accepts=text; required=false; role=
cases: 我有一份旧版规格说明
requires:
example: 第 1 天上传《需求规格说明书 v1.0》，解析出 9 节、28 条条目、6 个「原文未给」问题；第 2 天核读两份评审纪要，记 3 处不一致；第 3 到 4 天澄清与修订；第 5 天评审并发布第 2 版。
---
