import { createSubagentPlugin } from '@harness/subagent'
import { createCoordinatorPlugin } from '@harness/coordinator'

export default [
  createSubagentPlugin({
    subagents: [
      { id: 'coder', name: 'Coder', mode: 'subagent',
        tools: ['read_file', 'write_file', 'edit_file', 'bash'], permission: { '*': 'allow' },
        promptFragments: ['你只完成分配给你的编码任务。'] },
      // …更多 worker，或直接用内联 AgentDefinition
    ],
  }),
  createCoordinatorPlugin({ forceAsync: true }), // 强制所有派工后台化
]