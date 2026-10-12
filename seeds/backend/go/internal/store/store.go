// Package store 定义访问计数的存储抽象，并提供三种实现。
//
//	MemoryStore —— 进程内计数（无持久化，重启归零）
//	FileStore   —— 落 ${WEBGEN_DATA_DIR}/visits.txt
//	MySQLStore  —— sqlx + go-sql-driver/mysql
package store

import (
	"context"
	"fmt"
)

// Store 是访问计数存储。
type Store interface {
	// Next 记录一次访问并返回累计次数。
	Next(ctx context.Context) (int64, error)
	// Kind 返回存储档位：mysql | file | memory。
	Kind() string
	// Close 释放资源。
	Close() error
}

// Options 是创建存储所需的参数。
type Options struct {
	Kind    string // mysql | file | memory
	DSN     string // mysql DSN
	DataDir string // 文件存储目录
}

// New 按 Kind 构造对应的 Store。
func New(ctx context.Context, opts Options) (Store, error) {
	switch opts.Kind {
	case "mysql":
		return newMySQLStore(ctx, opts.DSN)
	case "file":
		return newFileStore(opts.DataDir)
	case "memory":
		return NewMemoryStore(), nil
	default:
		return nil, fmt.Errorf("未知存储类型: %q", opts.Kind)
	}
}
