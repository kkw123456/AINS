/**
 * 平台自身的库。**全小写表名**——`lower_case_table_names` 在 Linux / Windows
 * 上默认值不同，跨平台会突然报错（§7.1），别赌那个开关。
 *
 * ⚠️ MySQL 的 DDL 隐式提交、**不能回滚**，所以这里的建表语句必须可重复执行
 * （一律 IF NOT EXISTS），改表要另写幂等的迁移。
 */

import mysql from 'mysql2/promise'

let _pool: mysql.Pool | null = null

export function pool(): mysql.Pool {
  if (_pool) return _pool
  _pool = mysql.createPool({
    host: process.env.MYSQL_HOST?.trim() || '127.0.0.1',
    port: Number(process.env.MYSQL_PORT || 3306),
    user: process.env.MYSQL_USER?.trim() || 'webgen',
    password: process.env.MYSQL_PASSWORD?.trim() || 'webgen_pass',
    database: process.env.MYSQL_DATABASE?.trim() || 'webgen',
    waitForConnections: true,
    connectionLimit: Number(process.env.MYSQL_POOL_SIZE || 10),
    // 这里只写字符集，不写 collation —— mysql2 的 charset 选项不认
    // 'utf8mb4_0900_ai_ci' 这种 collation 名，写了会连不上。
    // collation 由服务端启动参数统一指定（见 infra/docker-compose.yml）。
    charset: 'utf8mb4',
    timezone: 'Z',
    supportBigNumbers: true,
  })
  return _pool
}

export async function closePool(): Promise<void> {
  await _pool?.end()
  _pool = null
}

export const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS projects (
     id          VARCHAR(32)  NOT NULL,
     owner       VARCHAR(64)  NOT NULL,
     name        VARCHAR(128) NOT NULL,
     slug        VARCHAR(64)  NOT NULL,
     template    VARCHAR(64)  NOT NULL,
     kind        VARCHAR(16)  NOT NULL COMMENT 'static | service，服务型另有一条更严的项目数上限',
     status      VARCHAR(16)  NOT NULL,
     created_at  DATETIME     NOT NULL,
     PRIMARY KEY (id),
     UNIQUE KEY uk_projects_slug (slug),
     KEY idx_projects_owner (owner)
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,

  `CREATE TABLE IF NOT EXISTS instances (
     id            VARCHAR(40) NOT NULL,
     project_id    VARCHAR(32) NOT NULL,
     role          VARCHAR(16) NOT NULL COMMENT 'edit | preview | production：同一套生命周期',
     kind          VARCHAR(16) NOT NULL,
     version       INT         NOT NULL DEFAULT 1,
     sandbox_id    VARCHAR(40) NULL,
     container_id  VARCHAR(80) NULL,
     node_id       VARCHAR(64) NULL,
     port          INT         NULL,
     state         VARCHAR(16) NOT NULL,
     health        VARCHAR(16) NOT NULL DEFAULT 'unknown',
     last_used_at  DATETIME    NULL,
     created_at    DATETIME    NOT NULL,
     PRIMARY KEY (id),
     KEY idx_instances_project (project_id, role)
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,
] as const

export async function initSchema(): Promise<void> {
  const p = pool()
  for (const stmt of SCHEMA) await p.query(stmt)
  for (const stmt of MIGRATIONS) {
    try {
      await p.query(stmt)
    } catch (err) {
      // MySQL 不支持 ADD COLUMN IF NOT EXISTS，重复执行会报 ER_DUP_FIELDNAME —— 忽略即可。
      // 注意 MySQL 的 DDL **不能回滚**（§7.1），所以每条迁移都必须写成本身幂等的。
      if ((err as { code?: string }).code !== 'ER_DUP_FIELDNAME') throw err
    }
  }
}

/**
 * 追加式迁移。**不要改上面 SCHEMA 里已有的建表语句**——那只对新库生效，
 * 已有库不会重建。要加列/加表一律往这里追加。
 */
const MIGRATIONS = [
  `ALTER TABLE projects ADD COLUMN sdk_session_id VARCHAR(80) NULL`,

  /**
   * 组合项目的技术栈（S3.5）。模板项目这里是 NULL。
   *
   * ★ 它**必须落库**，不能只活在内存里：组合决定了镜像 tag，而镜像在生产期
   *   （重新起发布容器 / 回滚）也要能重新解析到 —— 存 DB 是唯一活得够久的落点。
   *   存 JSON 而不是拆三列：组合的取值域是要长的（前端/后端/数据各自会加），
   *   每加一个拆列就要一次迁移，而它整体只被 `parseStack` 消费，结构不该外泄到 schema。
   *
   * 注意 template 那一列**同时也要写**（写组合名，见 shared 的 stackTemplateName）：
   * 它是 NOT NULL，而且下游十来处都按"一个字符串模板名"工作。
   */
  `ALTER TABLE projects ADD COLUMN stack JSON NULL`,

  // ---------------------------------------------------------------- S4（工程化模板）

  /**
   * 工作区布局版本。
   *   1 = **旧的扁平布局**：种子铺在工作区**根**（server.mjs / app.py / dist / nginx.conf 都在根）。
   *   2 = **新的分层布局**：`backend/` + `frontend/` + `deploy/`（见 executor 的 recipe.ts）。
   *
   * ★ 默认 1 是刻意的：迁移前建的老项目**自动落到老路径**，一行工作区都不用动
   *   （spec / 种子落点 / nginx.conf 位置都按 layout 分支，见 executor 的 recipe.ts / seed.ts）。
   *   新建项目显式写 2。这就是"冻结旧 spec"——不迁移工作区，只让两套布局并存。
   */
  `ALTER TABLE projects ADD COLUMN layout_version INT NOT NULL DEFAULT 1`,

  /**
   * 项目的**依赖服务**（§7）。S4 起：选了 MySQL 就给这个项目建一个库 + 独立账号。
   * 一行一个服务（同一项目 `kind` 唯一，见 uk）。
   *
   * `kind`：mysql | redis。redis 是**共享实例 + key 前缀隔离**，没有项目级资源，
   * 但也在表里留一行，好在 `/api/projects/:id/services` 里如实展示。
   * `db_name` / `role_name`：MySQL 的库名与账号名（都是 `p_<id>`），redis 行留空。
   *
   * ⚠️ 连接串（含密码）**不放这张表**，放 `project_env`（加密），
   *    因为它要脱敏展示、也要能被 `PUT /env` 改。
   */
  `CREATE TABLE IF NOT EXISTS project_services (
     id          VARCHAR(40) NOT NULL,
     project_id  VARCHAR(32) NOT NULL,
     kind        VARCHAR(16) NOT NULL COMMENT 'mysql | redis',
     db_name     VARCHAR(64) NULL,
     role_name   VARCHAR(64) NULL,
     created_at  DATETIME    NOT NULL,
     PRIMARY KEY (id),
     UNIQUE KEY uk_project_services (project_id, kind)
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,

  /**
   * 项目的环境变量 / 密钥（§7）。连接串、Redis 前缀都从这里注入容器。
   *
   * ⚠️ `key` 是 MySQL 保留字，所以列名用 `env_key`（DESIGN §7 的笔误，这里修正）。
   * `value_encrypted`：AES-GCM 密文；无 `WEBGEN_SECRET_KEY` 时退化成明文（dev，带 warning）。
   * `scope`：build | runtime（目前都按 runtime 注入）。
   */
  `CREATE TABLE IF NOT EXISTS project_env (
     id              VARCHAR(40) NOT NULL,
     project_id      VARCHAR(32) NOT NULL,
     env_key         VARCHAR(64) NOT NULL,
     value_encrypted TEXT        NOT NULL,
     scope           VARCHAR(16) NOT NULL COMMENT 'build | runtime',
     updated_at      DATETIME    NOT NULL,
     PRIMARY KEY (id),
     UNIQUE KEY uk_project_env (project_id, env_key)
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,

  `CREATE TABLE IF NOT EXISTS messages (
     id          BIGINT       NOT NULL AUTO_INCREMENT,
     project_id  VARCHAR(32)  NOT NULL,
     seq         INT          NOT NULL,
     role        VARCHAR(16)  NOT NULL COMMENT 'user | assistant | system',
     content     MEDIUMTEXT   NOT NULL,
     cost_usd    DECIMAL(12,8) NULL,
     created_at  DATETIME     NOT NULL,
     PRIMARY KEY (id),
     UNIQUE KEY uk_messages_seq (project_id, seq)
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,

  // ---------------------------------------------------------------- S3

  /**
   * 快照 = 工作区的一次 git commit（§5.1）。`seq` 是**项目内递增的版本号**，
   * 发布记录、实例的 version 都跟着它走。
   *
   * 为什么用 `seq` 而不是自增主键当版本号：版本号是要给人看的（"第 3 版"），
   * 而且回滚时要按它对上部署记录。自增主键是全局的，跨项目看着莫名其妙。
   */
  `CREATE TABLE IF NOT EXISTS snapshots (
     id          VARCHAR(40)  NOT NULL,
     project_id  VARCHAR(32)  NOT NULL,
     seq         INT          NOT NULL COMMENT '项目内递增，就是"版本号"',
     label       VARCHAR(128) NOT NULL,
     git_ref     VARCHAR(64)  NOT NULL COMMENT 'commit sha',
     created_by  VARCHAR(16)  NOT NULL COMMENT 'auto = 构建通过自动提交；user = 手动',
     created_at  DATETIME     NOT NULL,
     PRIMARY KEY (id),
     UNIQUE KEY uk_snapshots_seq (project_id, seq)
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,

  /**
   * 发布记录。`active=1` 的那条就是这个项目当前的线上版本。
   *
   * 静态与服务的差别只有两处：`instance_id`（静态为 NULL，因为没有容器）
   * 和 `path` 指向哪儿（静态是 sites/<slug>/<v>，服务是 releases/<slug>/<v>）。
   * 其余字段共用一个形状，回滚逻辑才不用分两套写。
   */
  `CREATE TABLE IF NOT EXISTS deployments (
     id          VARCHAR(40)  NOT NULL,
     project_id  VARCHAR(32)  NOT NULL,
     snapshot_id VARCHAR(40)  NOT NULL,
     version     INT          NOT NULL,
     kind        VARCHAR(16)  NOT NULL COMMENT 'static | service',
     instance_id VARCHAR(40)  NULL COMMENT '服务型的生产实例；静态为 NULL',
     url         VARCHAR(255) NOT NULL,
     path        VARCHAR(255) NOT NULL COMMENT '产物/代码在宿主上的落点',
     active      TINYINT(1)   NOT NULL DEFAULT 0,
     created_at  DATETIME     NOT NULL,
     PRIMARY KEY (id),
     KEY idx_deployments_project (project_id, version),
     KEY idx_deployments_active (project_id, active)
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,
] as const

export type { RowDataPacket, ResultSetHeader } from 'mysql2/promise'
