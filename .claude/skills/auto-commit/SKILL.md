---
name: auto-commit
description: 'AI 改动完成后自动提交 Git。当用户说"自动提交"、"commit"、"提交代码"、"提交改动"，或在 AI 完成一轮代码修改后主动调用。'
argument-hint: '可选：自定义 commit message'
user-invocable: true
---

# Auto Commit

AI 每次完成代码改动后，自动将相关文件提交到 Git。

## 硬性规则

1. **人类是作者。** 遵循 `CONTRIBUTING.md`：你只是辅助工具，commit 的 author 是用户本人（`git config user.name` / `user.email`），不是 AI。
2. **不 push。** 只做本地提交，除非用户明确要求 push。
3. **提交前 diff。** 先展示改动摘要，让用户知道要提交什么，再执行。
4. **不提交无关文件。** 只 stage 本次改动相关的文件，不混入不相关的变更。
5. **不提交敏感信息。** 检查 diff 中是否有密钥、token、密码等敏感内容，有则警告。

## 执行流程

### 1. 检查状态

```bash
git status --short
git diff --stat
git diff --cached --stat
git stash list
```

确认：
- 有待提交的改动（否则直接结束）
- 工作区干净（没有冲突标记 `<<<<<<<`、`>>>>>>>`）

### 2. 展示改动摘要

简洁列出即将提交的改动：

| 文件 | 状态 | 行数变化 |
|------|------|----------|
| xxx.ts | M | +12 -3 |

### 3. 安全检查

以下情况必须**先警告用户，待确认后再继续**：

- 改动涉及 `packages/core/` 或 `packages/extension/`（vibe coding 禁区，需人工 review）
- diff 超过 500 行
- 包含 `TODO`、`FIXME`、`console.log`、`.only` 等调试残留
- 改动文件超过 10 个
- 当前不在 feature 分支上

### 4. 生成 Commit Message

沿用仓库的 commit 风格（参考最近 20 条 `git log --oneline`）：

- 格式：`type: 中文描述`
- type 选择：`feat` / `fix` / `chore` / `docs` / `refactor`
- 描述简洁（一行），说明改了什么
- 示例：`chore: 新增自动提交 skill`

**如果用户提供了 message**，直接使用用户的。

### 5. 暂存并提交

```bash
git add <file1> <file2> ...
git commit -m "type: 描述"
```

### 6. 报告结果

- commit hash + 简短摘要
- 当前分支名
- 提醒：如需 push，用户需自行执行

## 反模式

| 不要 | 要 |
|------|-----|
| 跳过 diff 直接 commit | 先展示改动摘要 |
| 编造测试结果 | 如实报告 |
| 提交敏感文件（`.env`、密钥等） | 警告并跳过 |
| 把所有文件一股脑 add | 按改动意图分组 stage |

## 完成检查

- [ ] 只提交了本次改动相关的文件
- [ ] commit message 符合仓库风格
- [ ] 没有敏感信息泄露
- [ ] 用户已知晓提交内容
