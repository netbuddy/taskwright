// 测试夹具：任务服务启动助手时记下的两样事实，由它自己的函数（backend/src/launch.ts）算出，以 JSON 打到标准输出。
// 观测台的测试（test_taskpage.py）拿它们去喂观测台，核对观测台读的正是任务服务实际写下的写法。
// 用法：
//   node launch_facts.mts snapshot <任务目录>                          知识仓库摘要（knowledgeSnapshot）
//   node launch_facts.mts context <任务目录> <命令行 JSON> <环境变量 JSON>  上下文文件（contextFileCandidates）
import { contextFileCandidates, knowledgeSnapshot } from "../../../backend/src/launch.ts";

const [kind, workspace, argv, env] = process.argv.slice(2);
if (kind === "snapshot") process.stdout.write(JSON.stringify(knowledgeSnapshot(workspace)));
else if (kind === "context") process.stdout.write(JSON.stringify(contextFileCandidates(JSON.parse(argv), workspace, JSON.parse(env))));
else {
  process.stderr.write("用法：node launch_facts.mts snapshot <任务目录> | context <任务目录> <命令行 JSON> <环境变量 JSON>\n");
  process.exit(2);
}
