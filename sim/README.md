# sim：用户 agent（模拟用户）

一个扮演用户的 agent，按一份用户画像（user persona）与执行者多轮对话，用来积累执行者的失败样本。它用 pi 以 RPC 方式跑，
只有两个工具：「看界面」（look）与「回应」（respond），两个工具都走后端任务服务的 HTTP 接口，与网页前端走同一条路。
演练结束后由代码做第一层（用户 agent 有没有按画像演）与第二层（库里的事实）判定。

## 目录

| 路径 | 是什么 |
|---|---|
| `extension.ts` | 用户 agent 的扩展入口，只登记 look 与 respond。 |
| `tools/look.ts`、`tools/respond.ts` | 两个工具。respond 的「单独调用、合格即结束本轮」骨架引用 `agent/src/lib/speak.ts`。 |
| `lib/screen.ts` | 界面渲染与回应翻译的纯函数（执行者的话怎样显示、按钮走 actions 还是 messages）。 |
| `lib/backend.ts` | 两个工具访问后端的小函数（Node 自带 fetch），后端地址等从环境变量取。 |
| `profiles/user_agent.json` | 用户 agent 的启动配置（模型 gpt-6-luna、思考档位 medium、工具只有 look,respond）。 |
| `prompts/user_agent_system_prompt.md` | 用户 agent 的系统提示；`{{用户画像}}` 处由 `launch_user.py` 填入画像里给扮演者读的部分。 |
| `personas/librarian.json` | 示例用户画像，与 examples/library-lending 配套。隐藏事实的关键词与接受底线的判据给判定程序用，不给扮演者看。 |
| `launch_user.py` | 起用户 agent 的 pi（复用 `server/taskwright_server/launch.py` 经会话类组装命令行）。 |
| `run.py` | 驾驭程序：跑一次演练。 |
| `judge.py` | 判定程序：第一、二层判定，出判定报告。 |
| `tests/` | 单元测试与集成测试。 |

## 跑一次演练

```bash
# 在代码仓根目录下；Langfuse 可选，接法见 docs/deployment.md
python3 -m sim.run --persona sim/personas/librarian.json --materials-dir examples/library-lending --port 8791
```

驾驭程序自己起一个后端任务服务（端口由 `--port` 给），建任务、上传材料、新建会话，起用户 agent，每轮用一句固定的话唤起它，
直到停止条件；记录写进 `<sim-root>/sim-<序号>/`（`--sim-root` 缺省为当前目录下的 `sim-runs`），最后出 `判定报告.md` 并往 `<sim-root>/sim-summary.jsonl` 追加一行。
Langfuse 环境标签是 `sim-<序号>`，执行者与用户 agent 两边相同。单独重出判定报告：`python3 -m sim.judge <演练目录>`。

## 测试

```bash
cd sim && node --test 'tests/*.test.ts'
cd .. && python3 -m pytest sim -q
```
