import { randomUUID } from 'node:crypto'
import { pool, type RowDataPacket } from '@webgen/db'
import { parseStack, type DepKind, type Stack } from '@webgen/shared'
import type {
  Health,
  InstanceKind,
  InstanceRole,
  InstanceState,
  ProjectStatus,
  SnapshotBy,
} from '@webgen/shared'

export interface ProjectRow {
  id: string
  owner: string
  name: string
  slug: string
  /**
   * 模板名。组合项目这里是**组合名**（`stack-go-vue-sqlite`，见 shared 的 stackTemplateName）——
   * 下游那十来处按字符串模板名工作的地方因此一行都不用改。
   */
  template: string
  /**
   * 组合项目才有（模板项目是 null）。**发布期还要靠它重新解析镜像 tag**，
   * 所以它是持久化字段，不是内存状态。
   */
  stack: Stack | null
  kind: InstanceKind
  status: ProjectStatus
  /**
   * 工作区布局版本（S4）：1 = 旧的扁平布局，2 = 新的 `backend/`+`frontend/`+`deploy/`。
   * spec / 种子落点 / nginx.conf 位置都按它分支（见 executor 的 recipe.ts / seed.ts）。
   * 老项目保持 1，新项目写 2 —— 这就是"冻结旧 spec、不迁移工作区"。
   */
  layoutVersion: number
  createdAt: string
  /**
   * 「最近改动时间」。**不加列、不加迁移**——`packages/db` 的迁移是追加式的，
   * 为一个纯展示字段动 schema 不划算。直接在查询里现算（见 UPDATED_AT_SQL）。
   */
  updatedAt: string
}

export interface InstanceRow {
  id: string
  projectId: string
  role: InstanceRole
  kind: InstanceKind
  version: number
  sandboxId: string | null
  containerId: string | null
  nodeId: string | null
  port: number | null
  state: InstanceState
  health: Health
  lastUsedAt: string | null
}

type DbProject = RowDataPacket & {
  id: string
  owner: string
  name: string
  slug: string
  template: string
  /** MySQL 的 JSON 列经 mysql2 回来时**已经是解析好的对象**，不是字符串 */
  stack: unknown
  kind: string
  status: string
  layout_version: number
  created_at: Date
  /** 由 UPDATED_AT_SQL 现算出来；只有带那段 SQL 的查询才有 */
  updated_at?: Date
}

type DbInstance = RowDataPacket & {
  id: string
  project_id: string
  role: string
  kind: string
  version: number
  sandbox_id: string | null
  container_id: string | null
  node_id: string | null
  port: number | null
  state: string
  health: string
  last_used_at: Date | null
}

const now = () => new Date()

// ---------------------------------------------------------------- projects

export async function insertProject(p: {
  id: string
  owner: string
  name: string
  slug: string
  template: string
  /** 组合项目才给。给了就写 JSON 列。 */
  stack?: Stack | null
  kind: InstanceKind
  status: ProjectStatus
  /** 工作区布局版本（S4）。新建项目一律 2；缺省也按 2（只有迁移前的老行是 1）。 */
  layoutVersion?: number
}): Promise<void> {
  await pool().execute(
    `INSERT INTO projects (id, owner, name, slug, template, stack, kind, status, layout_version, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      p.id,
      p.owner,
      p.name,
      p.slug,
      p.template,
      p.stack ? JSON.stringify(p.stack) : null,
      p.kind,
      p.status,
      p.layoutVersion ?? 2,
      now(),
    ],
  )
}

/**
 * 最近改动 = max(创建时间, 最后一条消息, 编辑实例最后一次用)。三者都在现有表里，
 * 不用加列。GREATEST 传 NULL 会返回 NULL，所以每一项都 COALESCE 回 created_at。
 *
 * 用子查询而不是 LEFT JOIN + GROUP BY：项目数有上限（默认 50），两个相关子查询
 * 走 idx_messages_seq / idx_instances_project 就够了，加 join 反而容易写错聚合。
 */
const UPDATED_AT_SQL = `GREATEST(
  p.created_at,
  COALESCE((SELECT MAX(m.created_at) FROM messages  m WHERE m.project_id = p.id), p.created_at),
  COALESCE((SELECT MAX(i.last_used_at) FROM instances i WHERE i.project_id = p.id), p.created_at)
) AS updated_at`

export async function listProjects(owner: string): Promise<ProjectRow[]> {
  const [rows] = await pool().query<DbProject[]>(
    `SELECT p.*, ${UPDATED_AT_SQL} FROM projects p WHERE p.owner = ? ORDER BY p.created_at DESC`,
    [owner],
  )
  return rows.map(toProject)
}

export async function getProject(id: string): Promise<ProjectRow | null> {
  const [rows] = await pool().query<DbProject[]>(
    `SELECT p.*, ${UPDATED_AT_SQL} FROM projects p WHERE p.id = ?`,
    [id],
  )
  return rows[0] ? toProject(rows[0]) : null
}

export async function setProjectStatus(id: string, status: ProjectStatus): Promise<void> {
  await pool().execute(`UPDATE projects SET status = ? WHERE id = ?`, [status, id])
}

export async function deleteProject(id: string): Promise<void> {
  await pool().execute(`DELETE FROM projects WHERE id = ?`, [id])
}

export async function countProjects(owner: string): Promise<number> {
  const [rows] = await pool().query<RowDataPacket[]>(
    `SELECT COUNT(*) AS n FROM projects WHERE owner = ?`,
    [owner],
  )
  return Number(rows[0]?.n ?? 0)
}

/** 服务型项目常驻成本高，单独一条更严的上限（§2.4 ②） */
export async function countServiceProjects(owner: string): Promise<number> {
  const [rows] = await pool().query<RowDataPacket[]>(
    `SELECT COUNT(*) AS n FROM projects WHERE owner = ? AND kind = 'service'`,
    [owner],
  )
  return Number(rows[0]?.n ?? 0)
}

// --------------------------------------------------------------- instances

/**
 * 一个项目在一期内只有 role='edit' 一条实例（预览/生产是 S3 的事）。
 * 因此 id 是确定性的，直接用 UPSERT，省掉一套查找逻辑。
 */
export async function upsertInstance(i: {
  projectId: string
  role: InstanceRole
  kind: InstanceKind
  sandboxId?: string | null
  containerId?: string | null
  nodeId?: string | null
  port?: number | null
  state: InstanceState
  health?: Health
  /**
   * 这个实例当前伺服的是哪个版本（= 快照的 seq）。
   * **只有显式传了才更新** —— 见下面的 versionClause。
   */
  version?: number | null
}): Promise<string> {
  const id = `${i.projectId}:${i.role}`

  // ⚠️ version 不能无脑写在 ON DUPLICATE KEY UPDATE 里：INSERT 那一侧是
  // `COALESCE(?, 1)`，不传就是 1，每次 upsert 都会把已有版本号打回 1。
  // 所以只有调用方明确给了版本号时才更新它。
  const versionClause = i.version == null ? '' : ',\n       version = VALUES(version)'

  await pool().execute(
    `INSERT INTO instances
       (id, project_id, role, kind, version, sandbox_id, container_id, node_id, port, state, health, last_used_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       sandbox_id = VALUES(sandbox_id),
       container_id = VALUES(container_id),
       node_id = VALUES(node_id),
       port = VALUES(port),
       state = VALUES(state),
       health = VALUES(health),
       last_used_at = VALUES(last_used_at)${versionClause}`,
    [
      id,
      i.projectId,
      i.role,
      i.kind,
      i.version ?? 1,
      i.sandboxId ?? null,
      i.containerId ?? null,
      i.nodeId ?? null,
      i.port ?? null,
      i.state,
      i.health ?? 'unknown',
      now(),
      now(),
    ],
  )
  return id
}

export async function listInstances(projectId: string): Promise<InstanceRow[]> {
  const [rows] = await pool().query<DbInstance[]>(
    `SELECT * FROM instances WHERE project_id = ? ORDER BY role`,
    [projectId],
  )
  return rows.map(toInstance)
}

export async function getInstance(
  projectId: string,
  role: InstanceRole,
): Promise<InstanceRow | null> {
  const [rows] = await pool().query<DbInstance[]>(
    `SELECT * FROM instances WHERE project_id = ? AND role = ?`,
    [projectId, role],
  )
  return rows[0] ? toInstance(rows[0]) : null
}

export async function deleteInstances(projectId: string): Promise<void> {
  await pool().execute(`DELETE FROM instances WHERE project_id = ?`, [projectId])
}

// ---------------------------------------------------------------- messages

export interface MessageRow {
  seq: number
  role: 'user' | 'assistant' | 'system'
  content: string
  costUsd: number | null
  createdAt: string
}

type DbMessage = RowDataPacket & {
  seq: number
  role: string
  content: string
  cost_usd: string | number | null
  created_at: Date
}

export async function appendMessage(m: {
  projectId: string
  role: MessageRow['role']
  content: string
  costUsd?: number | null
}): Promise<number> {
  const [rows] = await pool().query<RowDataPacket[]>(
    `SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM messages WHERE project_id = ?`,
    [m.projectId],
  )
  const seq = Number(rows[0]?.next ?? 1)
  await pool().execute(
    `INSERT INTO messages (project_id, seq, role, content, cost_usd, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [m.projectId, seq, m.role, m.content, m.costUsd ?? null, now()],
  )
  return seq
}

export async function listMessages(projectId: string, limit = 200): Promise<MessageRow[]> {
  const [rows] = await pool().query<DbMessage[]>(
    `SELECT * FROM messages WHERE project_id = ? ORDER BY seq ASC LIMIT ?`,
    [projectId, limit],
  )
  return rows.map((r) => ({
    seq: r.seq,
    role: r.role as MessageRow['role'],
    content: r.content,
    costUsd: r.cost_usd === null ? null : Number(r.cost_usd),
    createdAt: r.created_at.toISOString(),
  }))
}

export async function deleteMessages(projectId: string): Promise<void> {
  await pool().execute(`DELETE FROM messages WHERE project_id = ?`, [projectId])
}

/** SDK 会话 id：下一轮 resume 用它接回上下文 */
export async function setSdkSessionId(projectId: string, sdkSessionId: string): Promise<void> {
  await pool().execute(`UPDATE projects SET sdk_session_id = ? WHERE id = ?`, [
    sdkSessionId,
    projectId,
  ])
}

export async function getSdkSessionId(projectId: string): Promise<string | null> {
  const [rows] = await pool().query<RowDataPacket[]>(
    `SELECT sdk_session_id FROM projects WHERE id = ?`,
    [projectId],
  )
  const v = rows[0]?.sdk_session_id
  return typeof v === 'string' && v ? v : null
}

// --------------------------------------------------------------- snapshots

export interface SnapshotRow {
  id: string
  projectId: string
  /** 项目内递增，就是"版本号" */
  seq: number
  label: string
  gitRef: string
  createdBy: SnapshotBy
  createdAt: string
}

type DbSnapshot = RowDataPacket & {
  id: string
  project_id: string
  seq: number
  label: string
  git_ref: string
  created_by: string
  created_at: Date
}

/**
 * 取下一个版本号。**并发下要小心**：两个 auto 提交同时进来会算出同一个 seq，
 * 靠 `uk_snapshots_seq` 唯一键挡住，插失败的那个退回去重算。
 * 一期一个项目同时只跑一轮生成（AgentService 按 projectId 有互斥锁），够用；
 * 手动打点和自动提交撞上时也会被唯一键兜住。
 */
export async function nextSnapshotSeq(projectId: string): Promise<number> {
  const [rows] = await pool().query<RowDataPacket[]>(
    `SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM snapshots WHERE project_id = ?`,
    [projectId],
  )
  return Number(rows[0]?.next ?? 1)
}

export async function insertSnapshot(s: {
  id: string
  projectId: string
  seq: number
  label: string
  gitRef: string
  createdBy: SnapshotBy
}): Promise<void> {
  await pool().execute(
    `INSERT INTO snapshots (id, project_id, seq, label, git_ref, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [s.id, s.projectId, s.seq, s.label, s.gitRef, s.createdBy, now()],
  )
}

export async function listSnapshots(projectId: string): Promise<SnapshotRow[]> {
  const [rows] = await pool().query<DbSnapshot[]>(
    `SELECT * FROM snapshots WHERE project_id = ? ORDER BY seq DESC`,
    [projectId],
  )
  return rows.map(toSnapshot)
}

export async function getSnapshot(id: string): Promise<SnapshotRow | null> {
  const [rows] = await pool().query<DbSnapshot[]>(`SELECT * FROM snapshots WHERE id = ?`, [id])
  return rows[0] ? toSnapshot(rows[0]) : null
}

export async function deleteSnapshots(projectId: string): Promise<void> {
  await pool().execute(`DELETE FROM snapshots WHERE project_id = ?`, [projectId])
}

export async function updateSlug(projectId: string, slug: string): Promise<void> {
  await pool().execute(`UPDATE projects SET slug = ? WHERE id = ?`, [slug, projectId])
}

export async function slugTaken(slug: string, exceptProjectId: string): Promise<boolean> {
  const [rows] = await pool().query<RowDataPacket[]>(
    `SELECT id FROM projects WHERE slug = ? AND id <> ? LIMIT 1`,
    [slug, exceptProjectId],
  )
  return rows.length > 0
}

// ------------------------------------------------------------- deployments

export interface DeploymentRow {
  id: string
  projectId: string
  snapshotId: string
  version: number
  kind: InstanceKind
  instanceId: string | null
  url: string
  path: string
  active: boolean
  createdAt: string
}

type DbDeployment = RowDataPacket & {
  id: string
  project_id: string
  snapshot_id: string
  version: number
  kind: string
  instance_id: string | null
  url: string
  path: string
  active: number
  created_at: Date
}

export async function insertDeployment(d: {
  id: string
  projectId: string
  snapshotId: string
  version: number
  kind: InstanceKind
  instanceId?: string | null
  url: string
  path: string
}): Promise<void> {
  await pool().execute(
    `INSERT INTO deployments (id, project_id, snapshot_id, version, kind, instance_id, url, path, active, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
    [d.id, d.projectId, d.snapshotId, d.version, d.kind, d.instanceId ?? null, d.url, d.path, now()],
  )
}

export async function listDeployments(projectId: string): Promise<DeploymentRow[]> {
  const [rows] = await pool().query<DbDeployment[]>(
    `SELECT * FROM deployments WHERE project_id = ? ORDER BY version DESC`,
    [projectId],
  )
  return rows.map(toDeployment)
}

export async function getActiveDeployment(projectId: string): Promise<DeploymentRow | null> {
  const [rows] = await pool().query<DbDeployment[]>(
    `SELECT * FROM deployments WHERE project_id = ? AND active = 1 ORDER BY version DESC LIMIT 1`,
    [projectId],
  )
  return rows[0] ? toDeployment(rows[0]) : null
}

/**
 * 把某一条切为"当前线上版本"。两条 UPDATE 要在**同一个连接**上跑才有意义——
 * 中间那一瞬没有 active（或者有两条），所以先清后置，且必须包在事务里，
 * 否则并发的发布/回滚会让线上指向一个不存在的版本。
 */
export async function setActiveDeployment(projectId: string, deploymentId: string): Promise<void> {
  const conn = await pool().getConnection()
  try {
    await conn.beginTransaction()
    await conn.execute(`UPDATE deployments SET active = 0 WHERE project_id = ?`, [projectId])
    await conn.execute(`UPDATE deployments SET active = 1 WHERE id = ? AND project_id = ?`, [
      deploymentId,
      projectId,
    ])
    await conn.commit()
  } catch (err) {
    await conn.rollback()
    throw err
  } finally {
    conn.release()
  }
}

export async function deleteDeployments(projectId: string): Promise<void> {
  await pool().execute(`DELETE FROM deployments WHERE project_id = ?`, [projectId])
}

// -------------------------------------------------- 依赖服务 / 环境变量（S4，§7）

export interface ProjectServiceRow {
  id: string
  projectId: string
  kind: DepKind
  dbName: string | null
  roleName: string | null
  createdAt: string
}

export interface ProjectEnvRow {
  id: string
  projectId: string
  key: string
  /** **密文**（或用前缀标记的明文），入库就是这个样子 */
  valueEncrypted: string
  scope: 'build' | 'runtime'
  updatedAt: string
}

export async function listProjectServices(projectId: string): Promise<ProjectServiceRow[]> {
  const [rows] = await pool().query<DbProjectService[]>(
    `SELECT * FROM project_services WHERE project_id = ? ORDER BY created_at`,
    [projectId],
  )
  return rows.map(toProjectService)
}

export async function insertProjectService(s: {
  projectId: string
  kind: DepKind
  dbName?: string | null
  roleName?: string | null
}): Promise<void> {
  // UPSERT：同一项目同一 kind 只留一行（重复供给就更新，不报错）
  await pool().execute(
    `INSERT INTO project_services (id, project_id, kind, db_name, role_name, created_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE db_name = VALUES(db_name), role_name = VALUES(role_name)`,
    [randomUUID(), s.projectId, s.kind, s.dbName ?? null, s.roleName ?? null, now()],
  )
}

export async function deleteProjectServices(projectId: string): Promise<void> {
  await pool().execute(`DELETE FROM project_services WHERE project_id = ?`, [projectId])
}

export async function listProjectEnv(projectId: string): Promise<ProjectEnvRow[]> {
  const [rows] = await pool().query<DbProjectEnv[]>(
    `SELECT * FROM project_env WHERE project_id = ? ORDER BY env_key`,
    [projectId],
  )
  return rows.map(toProjectEnv)
}

export async function upsertProjectEnv(e: {
  projectId: string
  key: string
  /** 已加密的值（调用方负责 encryptSecret） */
  valueEncrypted: string
  scope: 'build' | 'runtime'
}): Promise<void> {
  await pool().execute(
    `INSERT INTO project_env (id, project_id, env_key, value_encrypted, scope, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE value_encrypted = VALUES(value_encrypted), scope = VALUES(scope), updated_at = VALUES(updated_at)`,
    [randomUUID(), e.projectId, e.key, e.valueEncrypted, e.scope, now()],
  )
}

export async function deleteProjectEnv(projectId: string): Promise<void> {
  await pool().execute(`DELETE FROM project_env WHERE project_id = ?`, [projectId])
}

type DbProjectService = RowDataPacket & {
  id: string
  project_id: string
  kind: string
  db_name: string | null
  role_name: string | null
  created_at: Date
}

type DbProjectEnv = RowDataPacket & {
  id: string
  project_id: string
  env_key: string
  value_encrypted: string
  scope: string
  updated_at: Date
}

function toProjectService(r: DbProjectService): ProjectServiceRow {
  return {
    id: r.id,
    projectId: r.project_id,
    kind: r.kind as DepKind,
    dbName: r.db_name,
    roleName: r.role_name,
    createdAt: r.created_at.toISOString(),
  }
}

function toProjectEnv(r: DbProjectEnv): ProjectEnvRow {
  return {
    id: r.id,
    projectId: r.project_id,
    key: r.env_key,
    valueEncrypted: r.value_encrypted,
    scope: r.scope as 'build' | 'runtime',
    updatedAt: r.updated_at.toISOString(),
  }
}

// ----------------------------------------------------------------- mapping

function toSnapshot(r: DbSnapshot): SnapshotRow {
  return {
    id: r.id,
    projectId: r.project_id,
    seq: r.seq,
    label: r.label,
    gitRef: r.git_ref,
    createdBy: r.created_by as SnapshotBy,
    createdAt: r.created_at.toISOString(),
  }
}

function toDeployment(r: DbDeployment): DeploymentRow {
  return {
    id: r.id,
    projectId: r.project_id,
    snapshotId: r.snapshot_id,
    version: r.version,
    kind: r.kind as InstanceKind,
    instanceId: r.instance_id,
    url: r.url,
    path: r.path,
    active: r.active === 1,
    createdAt: r.created_at.toISOString(),
  }
}

function toProject(r: DbProject): ProjectRow {
  return {
    id: r.id,
    owner: r.owner,
    name: r.name,
    slug: r.slug,
    template: r.template,
    // 读回来的组合**再走一遍 parseStack**，不直接信 DB 里的 JSON：
    // 万一手工改过 DB、或者以后合并了枚举取值，这里会明确变成 null（退回模板路），
    // 而不是把一个残缺的 stack 对象喂给 recipe 生成出诡异的 Dockerfile。
    stack: parseStackOrNull(r.stack),
    kind: r.kind as InstanceKind,
    status: r.status as ProjectStatus,
    // 迁移把老行默认成 1；万一某处漏了列，也退回 1（老布局最安全）。
    layoutVersion: r.layout_version ?? 1,
    createdAt: r.created_at.toISOString(),
    updatedAt: (r.updated_at ?? r.created_at).toISOString(),
  }
}

function parseStackOrNull(raw: unknown): Stack | null {
  if (raw === null || raw === undefined) return null
  try {
    return parseStack(raw)
  } catch {
    return null
  }
}

function toInstance(r: DbInstance): InstanceRow {
  return {
    id: r.id,
    projectId: r.project_id,
    role: r.role as InstanceRole,
    kind: r.kind as InstanceKind,
    version: r.version,
    sandboxId: r.sandbox_id,
    containerId: r.container_id,
    nodeId: r.node_id,
    port: r.port,
    state: r.state as InstanceState,
    health: r.health as Health,
    lastUsedAt: r.last_used_at ? r.last_used_at.toISOString() : null,
  }
}
