// Package cache 封装可选的 Redis 缓存（github.com/redis/go-redis/v9）。
//
// 有 REDIS_URL 就用真 Redis；没有就返回一个空实现（Kind() 为 ""），
// handler 据此在 /api/visits 里输出 cache=null。key 统一加 REDIS_KEY_PREFIX
// 前缀 —— 共享 Redis 靠前缀做**约定隔离**（非 ACL）。
package cache

import (
	"context"
	"fmt"

	"github.com/redis/go-redis/v9"
	"go.uber.org/zap"
)

// Cache 是缓存抽象。
type Cache interface {
	// Kind 返回 "redis"，未启用时返回 ""。
	Kind() string
	// Incr 对 key（自动加前缀）自增。
	Incr(ctx context.Context, key string) (int64, error)
	// Ping 探活。
	Ping(ctx context.Context) error
	// Close 释放连接。
	Close() error
}

// nopCache 是未启用 Redis 时的空实现。
type nopCache struct{}

func (nopCache) Kind() string                                { return "" }
func (nopCache) Incr(context.Context, string) (int64, error) { return 0, nil }
func (nopCache) Ping(context.Context) error                  { return nil }
func (nopCache) Close() error                                { return nil }

type redisCache struct {
	client *redis.Client
	prefix string
}

func (c *redisCache) Kind() string { return "redis" }

func (c *redisCache) key(k string) string { return c.prefix + k }

func (c *redisCache) Incr(ctx context.Context, key string) (int64, error) {
	return c.client.Incr(ctx, c.key(key)).Result()
}

func (c *redisCache) Ping(ctx context.Context) error { return c.client.Ping(ctx).Err() }

func (c *redisCache) Close() error { return c.client.Close() }

// New 按配置构造缓存。没有 REDIS_URL 时返回空实现。
func New(ctx context.Context, redisURL, keyPrefix string, log *zap.Logger) (Cache, error) {
	if redisURL == "" {
		return nopCache{}, nil
	}
	opt, err := redis.ParseURL(redisURL)
	if err != nil {
		return nil, fmt.Errorf("REDIS_URL 无效: %w", err)
	}
	client := redis.NewClient(opt)

	// Ping 只做提示，不降级 —— 有 REDIS_URL 就如实报 cache="redis"（契约如此）。
	// go-redis 是惰性连接，一次 ping 失败也不影响后续可用。
	if err := client.Ping(ctx).Err(); err != nil {
		log.Warn("Redis 连接异常，仍按已配置处理", zap.String("error", err.Error()))
	} else {
		log.Info("Redis 已连接", zap.String("prefix", keyPrefix))
	}
	return &redisCache{client: client, prefix: keyPrefix}, nil
}
