import { useCallback, useEffect, useRef, useState } from 'react'
import { ApiError, getPreviewUrl, startPreview } from '../api/client.ts'
import type { PreviewState } from '../api/types.ts'

export interface PreviewController {
  state: PreviewState
  url: string
  kind: string
  /** 正在等容器/路由就绪 */
  busy: boolean
  /** 真实失败（容器起不来、edge 路由没生效），不是"还在等" */
  error: string | null
  errorLogs: string | null
  /** 换 key 强制 iframe 重载 */
  refreshKey: number
  refresh: () => void
  retry: () => void
}

/**
 * 预览的三态由后端说了算（`GET /preview-url` 的 `state: none|cold|ready`），前端不猜。
 *
 * 两个必须守住的点：
 *  ① **生成中绝对不要去拉容器**。agent 每次 verify 都会把沙箱删掉重建
 *     （见 agent/service.ts 的 verify），这时候我们再去 createSandbox 就会打架，
 *     可能拿到一个建到一半的容器。生成中就只显示骨架屏，等 `done` 再动。
 *  ② `/wait` 的 504 是真实失败（容器起来了但 edge 路由没生效），
 *     必须显示出来并给重试，不能静默转圈。
 */
export function usePreview(
  projectId: string | undefined,
  running: boolean,
  enabled: boolean,
): PreviewController {
  const [state, setState] = useState<PreviewState>('none')
  const [url, setUrl] = useState('')
  const [kind, setKind] = useState('service')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [errorLogs, setErrorLogs] = useState<string | null>(null)
  const [refreshKey, setRefreshKey] = useState(0)
  const [retryTick, setRetryTick] = useState(0)

  const probe = useCallback(async () => {
    if (!projectId) return null
    const r = await getPreviewUrl(projectId)
    setUrl(r.url)
    setKind(r.kind)
    setState(r.state)
    return r
  }, [projectId])

  useEffect(() => {
    if (!projectId || !enabled) return
    let cancelled = false

    const run = async () => {
      try {
        const r = await probe()
        if (cancelled || !r) return

        if (r.state === 'ready') {
          setError(null)
          return
        }
        if (running) return // 生成中：只显示骨架屏，别碰容器

        setBusy(true)
        setError(null)
        try {
          // ★ 拉的是**预览**（`p-<id>`），不是编辑容器（`d-<id>`）。
          // 拆分之前两者是同一个容器，所以老代码调的是 editor/start ——
          // 那样在拆分之后会去重启 agent 正在折腾的那份，而预览压根没起来。
          await startPreview(projectId, true)
          if (cancelled) return
          await probe()
        } catch (e) {
          if (cancelled) return
          const err = e as ApiError
          setError(err.message)
          setErrorLogs(err.logs ?? null)
          setState('cold')
        } finally {
          if (!cancelled) setBusy(false)
        }
      } catch (e) {
        if (!cancelled) setError((e as Error).message)
      }
    }

    // 每轮生成结束后都要重新探测：verify 重建过容器，内容变了
    void run()
    return () => {
      cancelled = true
    }
  }, [projectId, enabled, running, probe, retryTick])

  // 生成结束后强制刷新一次 iframe（内容变了，但 URL 没变）
  const prevRunning = useRef(running)
  useEffect(() => {
    if (prevRunning.current && !running) setRefreshKey((k) => k + 1)
    prevRunning.current = running
  }, [running])

  return {
    state,
    url,
    kind,
    busy,
    error,
    errorLogs,
    refreshKey,
    refresh: () => setRefreshKey((k) => k + 1),
    retry: () => setRetryTick((t) => t + 1),
  }
}
