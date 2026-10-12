// Package service 放业务逻辑。
package service

import (
	"context"

	"go.uber.org/zap"

	"app/internal/cache"
	"app/internal/store"
)

// VisitService 处理访问计数。
type VisitService struct {
	store store.Store
	cache cache.Cache
	log   *zap.Logger
}

// NewVisitService 构造服务。
func NewVisitService(st store.Store, ca cache.Cache, log *zap.Logger) *VisitService {
	return &VisitService{store: st, cache: ca, log: log}
}

// StorageKind 返回存储档位（mysql | file | memory）。
func (s *VisitService) StorageKind() string { return s.store.Kind() }

// CacheKind 返回缓存档位（redis 或 ""）。
func (s *VisitService) CacheKind() string { return s.cache.Kind() }

// Visit 记录一次访问，返回累计次数。以 store 为准；Redis 计数是尽力而为的副手。
func (s *VisitService) Visit(ctx context.Context) (int64, error) {
	n, err := s.store.Next(ctx)
	if err != nil {
		return 0, err
	}
	if s.cache.Kind() != "" {
		if _, err := s.cache.Incr(ctx, "visits"); err != nil {
			s.log.Warn("写入 Redis 计数失败", zap.String("error", err.Error()))
		}
	}
	return n, nil
}
