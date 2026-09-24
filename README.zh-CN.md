# Taskwright

Taskwright 是一个通用的任务型智能体。给它一份**任务定义**，它就与人对话，产出任务定义所描述的交付物；交付物里的每一条内容都**有出处**、**经人确认**，改动**留痕且不可篡改**。它基于 [pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) 开发。随附的第一个任务类型是「编制软件需求规格说明」。

[English](README.md)

**许可证。** 核心代码采用 [GNU AGPL-3.0](LICENSE) 许可；商业许可另行签订，见 [COMMERCIAL-LICENSE.md](COMMERCIAL-LICENSE.md)。

> 状态：0.1.0-alpha，各版本之间接口仍可能变化。

## 它做什么

- 读一份任务定义就能工作：任务定义声明交付物由哪些条目集合组成、每个条目有哪些字段、什么条件算完成、方法与领域规矩写在哪些文件里。换一份任务定义，就是另一种任务。
- 在对话中产出条目，每个条目的每一版都带来源：材料里逐字摘录的原话、用户说过的话、明确标注的「执行者补充」，或者用户自己的直接修改。
- 用户可以在界面上直接修改、确认、撤销条目；每次改动都存成新的一版，历史只追加不改写，写入与它的事件记录在同一个事务里。
- 完成与否由代码按任务定义里的完成条件核对，交付物按模板渲染成文档，两者都不经过模型。
- 整个过程可以回看：每次运行、每一轮、每次工具调用与拒绝都有记录。

随附的任务类型「编制软件需求规格说明」在此之上规定了四个条目集合、用例与 EARS 的写法，以及执行者的工作方式。当前版本能做什么、还不能做什么，完整清单见[功能说明](docs/capabilities.zh-CN.md)。

## 组件

**智能体**（`agent/`）基于 pi 开发：pi 提供 agent 循环、模型接入与会话记录，Taskwright 的工具与扩展作为 pi 的扩展加载，是唯一写任务数据库的代码。**服务端**（`server/`）启动并看护 pi，提供 HTTP/SSE 接口；**网页**（`web/`）与只读的**观测台**（`observatory/`）负责展示；**模拟用户**（`sim/`）以用户身份驱动智能体；`task-types/` 放每种任务类型的起始文件。细节见[架构](docs/architecture.zh-CN.md)。

## 最短安装路径

```bash
npm install -g @earendil-works/pi-coding-agent@0.85.1   # 装好后在 pi 里接入一个模型
git clone https://github.com/netbuddy/taskwright.git && cd taskwright
python3 -m venv .venv && . .venv/bin/activate
make install                                            # 即 npm ci 加 pip install -e 'observatory[test]' -e 'server[test]'
scripts/dev.sh                                          # 然后打开 http://localhost:5680
# 每开一个新终端，先执行 `. .venv/bin/activate`
```

依赖、模型接入、端口与常见故障见[部署](docs/deployment.zh-CN.md)。

## 目录

```
agent/         pi 的工具、扩展与命令行入口（src/），提示与测试
server/        taskwright_server：任务服务、创建任务、终端客户端、TUI、假模型端点
observatory/   taskwright_observatory：只读网页应用与读库模块；archive-format.md
web/           浏览器界面
sim/           模拟用户、演练驱动、判定程序、示例画像
task-types/    srs-authoring：任务定义、skill、领域规矩、文档模板
examples/      library-lending：示例材料与脚本化的一次完整运行
docs/          功能说明、部署、用户手册、接口参考、架构（英文版与中文译本）
scripts/       check-public.sh、dev.sh、test-all.sh
```

## 文档

给使用者：

- [功能说明](docs/capabilities.zh-CN.md)（[英文版](docs/capabilities.md)）：当前版本能做什么、还不能做什么
- [部署](docs/deployment.zh-CN.md)（[英文版](docs/deployment.md)）：依赖、模型接入、启动服务、常见故障
- [用户手册](docs/user-guide.zh-CN.md)（[英文版](docs/user-guide.md)）：网页流程、示例、其他操作方式、观测台

给集成者与贡献者：

- [接口参考](docs/api.zh-CN.md)（[英文版](docs/api.md)）：HTTP 接口、事件流、错误
- [架构](docs/architecture.zh-CN.md)（[英文版](docs/architecture.md)）：组件、数据流、库表
- [归档格式](observatory/archive-format.md)：后端写的 JSONL 归档
- [CONTRIBUTING.md](CONTRIBUTING.md)：开发环境、测试、代码边界

## 参与贡献与安全报告

见 [CONTRIBUTING.md](CONTRIBUTING.md)。安全漏洞请按 [SECURITY.md](SECURITY.md) 私下报告，不要发公开 issue。本项目遵守 [Contributor Covenant](CODE_OF_CONDUCT.md) 行为准则。
