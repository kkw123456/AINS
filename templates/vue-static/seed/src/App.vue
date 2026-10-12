<script setup>
import { ref } from 'vue'

const host = ref(location.host)
</script>

<template>
  <main>
    <h1>webgen · Vue 静态模板跑起来了</h1>
    <p>Host: <code>{{ host }}</code></p>
    <p class="hint">把这段话交给 agent，它就会在这个骨架上改。</p>
  </main>
</template>

<style>
/* 配色和 node-web / fastapi / go-web / java-web 的 seed 保持一致 */
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
  margin: 0;
  color: #94a3b8;
  font-size: 14px;
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
