# 软件需求规格说明编制：任务目录的起始文件

本目录里的相对路径就是这些文件在任务目录里的相对路径；建任务目录时整个复制过去，本文件除外。

- `docs/task-definitions/srs-authoring.json`：任务定义。创建任务的核心函数与「保存修订」读它；执行者用 read 读它了解字段。
- `.pi/skills/srs-authoring/SKILL.md`：执行者的 skill。
- `.pi/settings.json`：pi 的项目设置，`followUpMode` 为 `all`（执行者工作时排队的几句话一起交给它）。pi 只在项目被信任时读它，后端启动 pi 时带 `--approve`。
- `docs/domain-knowledge/`：两份领域规矩，执行者与评审者读同一份。
- `docs/templates/srs.md`：文档模板。

这里的任务定义、skill 与领域规矩是执行者行为的一部分，改动时连同 docs/capabilities.md 与测试一起更新。
