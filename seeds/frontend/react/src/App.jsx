import { useEffect, useState } from 'react'

/**
 * 这一页的**唯一目的**是证明那条链是通的：
 *   浏览器 → nginx（对外唯一的口）→ 后端进程（容器内的另一个口）
 * 所以它一挂载就打 `/api/hello`。
 *
 * ⚠️ 路径必须是**相对**的 —— 写绝对地址就绕过 nginx 了，
 * 那样就算 nginx 配错了这一页也照样是绿的，等于没验。
 */
export default function App() {
  const [hello, setHello] = useState(null)
  const [visits, setVisits] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    // 两个请求分开各自处理：计数接口挂了不该把后端那条真实响应也盖掉
    fetch('/api/hello')
      .then((r) => {
        if (!r.ok) throw new Error(`/api/hello 返回 ${r.status}`)
        return r.json()
      })
      .then(setHello)
      .catch((e) => setError(String(e.message ?? e)))

    fetch('/api/visits')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => d && setVisits(d))
      .catch(() => {
        /* 无所谓，它只是演示 */
      })
  }, [])

  return (
    <main>
      <h1>webgen · 组合项目跑起来了</h1>
      <p className="sub">React 前端 + 你选的后端，在**同一个容器**里，由 nginx 统一对外。</p>

      {error ? (
        <p className="err">调后端失败：{error}</p>
      ) : hello ? (
        <p className="ok">
          后端说：<code>{hello.message}</code>
        </p>
      ) : (
        <p className="sub">正在调后端…</p>
      )}

      {visits && (
        <p className="sub">
          访问计数：<code>{visits.visits}</code> · 存储：<code>{visits.storage}</code>
        </p>
      )}
      <p className="hint">把这段话交给 agent，它就会在这个骨架上改。</p>
    </main>
  )
}
