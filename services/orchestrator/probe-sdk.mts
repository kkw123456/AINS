// 临时探针：SDK 自带的 claude 二进制，在 WSL 里能不能通过本地代理认证？
import { query } from '@anthropic-ai/claude-agent-sdk'

const q = query({
  prompt: 'reply with exactly: SDKOK',
  options: { cwd: '/tmp', maxTurns: 1, permissionMode: 'bypassPermissions' },
})

for await (const m of q) {
  console.log('[event]', m.type, JSON.stringify(m).slice(0, 160))
}
