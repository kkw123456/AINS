<script setup>
import { onMounted, ref } from 'vue'

// 这一页的**唯一目的**是证明那条链是通的：
//   浏览器 → nginx（对外唯一的口）→ 后端进程（容器内的另一个口）
// 所以它一挂载就打 `/api/hello`。**相对路径**是关键 —— 写绝对地址就绕过 nginx 了，
// 那样就算 nginx 配错了这一页也照样是绿的。
const hello = ref(null)
const visits = ref(null)
const error = ref(null)

onMounted(async () => {
  try {
    const r = await fetch('/api/hello')
    if (!r.ok) throw new Error(`/api/hello 返回 ${r.status}`)
    hello.value = await r.json()
  } catch (e) {
    error.value = String(e.message ?? e)
  }
  // 单独 try：计数接口挂了不该把上面那条真实的后端响应也盖掉
  try {
    const r = await fetch('/api/visits')
    if (r.ok) visits.value = await r.json()
  } catch {
    /* 无所谓，它只是演示 */
  }
})
</script>

<template>
  <main>
    <h1>webgen · 组合项目跑起来了</h1>
    <p class="sub">Vue 前端 + 你选的后端，在**同一个容器**里，由 nginx 统一对外。</p>

    <p v-if="error" class="err">调后端失败：{{ error }}</p>
    <p v-else-if="hello" class="ok">
      后端说：<code>{{ hello.message }}</code>
    </p>
    <p v-else class="sub">正在调后端…</p>

    <p v-if="visits" class="sub">
      访问计数：<code>{{ visits.visits }}</code> · 存储：<code>{{ visits.storage }}</code>
    </p>
    <p class="hint">把这段话交给 agent，它就会在这个骨架上改。</p>
  </main>
</template>

<style>
/* 配色和种子里的其他骨架保持一致 */
* {
  box-sizing: border-box;
}
body {
  margin: 0;
  min-height: 100vh;
  display: grid;
  place-items: center;
  font-family: system-ui, -apple-system, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif;
  background: #0f172a;
  color: #e2e8f0;
}
main {
  text-align: center;
  padding: 24px;
}
h1 {
  margin: 0 0 8px;
  font-size: 28px;
  font-weight: 600;
}
p {
  margin: 0 0 6px;
  color: #94a3b8;
  font-size: 14px;
}
.ok {
  color: #86efac;
}
.err {
  color: #fca5a5;
}
.hint {
  margin-top: 12px;
}
code {
  background: #1e293b;
  padding: 2px 6px;
  border-radius: 4px;
  color: #7dd3fc;
  font-size: 13px;
}
</style>
