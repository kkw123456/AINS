import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import { ContainersPage } from './pages/ContainersPage.tsx'
import { HomePage } from './pages/HomePage.tsx'
import { ProjectsPage } from './pages/ProjectsPage.tsx'
import { TemplatesPage } from './pages/TemplatesPage.tsx'
import { WorkbenchPage } from './pages/WorkbenchPage.tsx'

/**
 * 路由。四个管理面页面（新建 / 项目 / 容器 / 模板）共用一个导航壳，
 * 工作台 `/p/:id` 用自己的顶栏 —— 它的三栏布局把横向空间吃满了，再加导航会挤掉预览。
 */
export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/projects" element={<ProjectsPage />} />
        <Route path="/containers" element={<ContainersPage />} />
        <Route path="/templates" element={<TemplatesPage />} />
        <Route path="/p/:id" element={<WorkbenchPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  )
}
