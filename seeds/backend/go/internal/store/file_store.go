package store

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
)

// FileStore 把计数落在 ${WEBGEN_DATA_DIR}/visits.txt。
//
// ★ 为什么这样就「持久」：工作区是 bind mount 到宿主的，所以 /workspace/data
// 下的东西在容器删除/重建之后还在。这是这个目录唯一的含义。
type FileStore struct {
	mu   sync.Mutex
	path string
	n    int64
}

func newFileStore(dir string) (*FileStore, error) {
	if dir == "" {
		return nil, fmt.Errorf("WEBGEN_DATA_DIR 为空")
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, fmt.Errorf("创建数据目录失败: %w", err)
	}
	path := filepath.Join(dir, "visits.txt")

	s := &FileStore{path: path}
	if b, err := os.ReadFile(path); err == nil {
		if v, err := strconv.ParseInt(strings.TrimSpace(string(b)), 10, 64); err == nil {
			s.n = v
		}
	}
	return s, nil
}

// Next 自增并落盘，返回新计数。
func (s *FileStore) Next(context.Context) (int64, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.n++
	if err := os.WriteFile(s.path, []byte(strconv.FormatInt(s.n, 10)), 0o644); err != nil {
		return 0, fmt.Errorf("写入访问计数失败: %w", err)
	}
	return s.n, nil
}

// Kind 返回 "file"。
func (s *FileStore) Kind() string { return "file" }

// Close 无操作。
func (s *FileStore) Close() error { return nil }
