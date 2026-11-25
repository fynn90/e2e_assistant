/**
 * 调试示例脚本：演示如何用 VSCode Run and Debug 调试 agent 包内任意文件/函数。
 *
 * 用法：
 *   1. 打开本文件，在下方任意断点行（如 `console.log` 处）打断点；
 *   2. VSCode 运行和调试侧边栏选择「agent: 调试 scratch 脚本」后按 F5；
 *   3. 命中断点后可单步、查看变量（Watch / Variables 面板）。
 *
 * 想调试别的文件/函数时：
 *   - 直接修改本文件中的 import 与调用即可；
 *   - 或打开目标 TS 文件，选择「agent: 调试当前打开的 TS 文件」按 F5。
 */
import { resourceLoader } from '../src/resourceLoader'

// 示例：加载并查看 e2e_test_case 技能（与 src/agents/authineE2E-agent.ts 同源逻辑）
const skill = resourceLoader.getSkill('e2e_test_case')
console.log('skill name:', skill.name)
console.log('skill description:', skill.description)

// 示例：加载系统提示词
const prompt = resourceLoader.getPrompt('authineE2E-agent')
console.log('prompt length:', prompt.length)

// 在这里打断点，逐步进入 getSkill / getPrompt 内部查看实现
debugger
console.log('debug 完成 ✔')
