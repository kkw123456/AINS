import { config } from './config.ts'
import { nodeInfo } from './routes/node.ts'

/**
 * 向 orchestrator 上报本节点状态（§1.1 节点注册 + 心跳）。
 * 单机、orchestrator 没起来时静默失败——**心跳不该拖垮 executor**。
 */
export function startHeartbeat(): void {
  if (!config.orchestratorUrl) return

  const tick = async (): Promise<void> => {
    try {
      const node = await nodeInfo()
      await fetch(`${config.orchestratorUrl}/internal/nodes/heartbeat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // 带上自己的可达地址：orchestrator 才知道该往哪儿回调（多节点必需）
        body: JSON.stringify({ ...node, url: config.advertiseUrl }),
      })
    } catch {
      // 忽略：orchestrator 还没起来是正常现象
    }
  }

  void tick()
  setInterval(() => void tick(), config.heartbeatMs).unref()
}
