package store

import (
	"context"
	"sync"
)

// MemoryStore 是进程内计数（无持久化，重启归零）。
type MemoryStore struct {
	mu sync.Mutex
	n  int64
}

// NewMemoryStore 构造内存存储。
func NewMemoryStore() *MemoryStore { return &MemoryStore{} }

// Next 自增并返回计数。
func (s *MemoryStore) Next(context.Context) (int64, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.n++
	return s.n, nil
}

// Kind 返回 "memory"。
func (s *MemoryStore) Kind() string { return "memory" }

// Close 无操作。
func (s *MemoryStore) Close() error { return nil }
