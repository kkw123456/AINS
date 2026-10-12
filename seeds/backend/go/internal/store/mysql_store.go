package store

import (
	"context"
	"fmt"
	"time"

	// 注册 mysql 驱动（sqlx.ConnectContext 只认驱动名 "mysql"）。
	_ "github.com/go-sql-driver/mysql"
	"github.com/jmoiron/sqlx"
)

// MySQLStore 用 sqlx + go-sql-driver/mysql 记录访问。
type MySQLStore struct {
	db *sqlx.DB
}

const createVisitsTable = `CREATE TABLE IF NOT EXISTS visits (
	id         BIGINT    NOT NULL AUTO_INCREMENT,
	created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
	PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`

func newMySQLStore(ctx context.Context, dsn string) (*MySQLStore, error) {
	if dsn == "" {
		return nil, fmt.Errorf("DATABASE_URL 为空")
	}
	db, err := sqlx.ConnectContext(ctx, "mysql", dsn)
	if err != nil {
		return nil, fmt.Errorf("连接 MySQL 失败: %w", err)
	}
	db.SetMaxOpenConns(10)
	db.SetMaxIdleConns(5)
	db.SetConnMaxLifetime(time.Hour)

	if _, err := db.ExecContext(ctx, createVisitsTable); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("初始化 visits 表失败: %w", err)
	}
	return &MySQLStore{db: db}, nil
}

// Next 插入一条访问记录并返回总数。
func (s *MySQLStore) Next(ctx context.Context) (int64, error) {
	if _, err := s.db.ExecContext(ctx, "INSERT INTO visits (created_at) VALUES (NOW())"); err != nil {
		return 0, fmt.Errorf("写入访问记录失败: %w", err)
	}
	var n int64
	if err := s.db.GetContext(ctx, &n, "SELECT COUNT(*) FROM visits"); err != nil {
		return 0, fmt.Errorf("统计访问次数失败: %w", err)
	}
	return n, nil
}

// Kind 返回 "mysql"。
func (s *MySQLStore) Kind() string { return "mysql" }

// Close 关闭连接池。
func (s *MySQLStore) Close() error { return s.db.Close() }
