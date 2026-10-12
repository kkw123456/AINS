-- 平台账号的**供给权限**（S4，§7.1）。
--
-- 每项目一库一账号（`CREATE DATABASE p_<id>` + `CREATE USER 'p_<id>'@'%'` + `GRANT`）
-- 需要全局的 CREATE / CREATE USER / DROP / GRANT，所以平台账号在这里被提成事实上的管理员。
-- 自用/单租户平台可以接受；多租户要收紧，见 DESIGN §10。
--
-- ⚠️ 这个文件**只在 MySQL 数据卷是空的、首次初始化**时被官方镜像执行。
--    对**已有数据卷**（本机现在就是），它不会重跑 —— 去跑 `bash scripts/grant-mysql.sh`。
--
-- ⚠️ 账号名要和 `.env` 的 `MYSQL_USER` 一致（默认就写死成 webgen）。
GRANT ALL PRIVILEGES ON *.* TO 'webgen'@'%' WITH GRANT OPTION;
FLUSH PRIVILEGES;
