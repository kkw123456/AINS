package store

import (
	"context"
	"testing"
)

func TestMemoryStoreIncrements(t *testing.T) {
	s := NewMemoryStore()
	if s.Kind() != "memory" {
		t.Fatalf("Kind = %q, want memory", s.Kind())
	}
	for want := int64(1); want <= 3; want++ {
		got, err := s.Next(context.Background())
		if err != nil {
			t.Fatalf("Next: %v", err)
		}
		if got != want {
			t.Fatalf("Next = %d, want %d", got, want)
		}
	}
}

func TestFileStorePersists(t *testing.T) {
	dir := t.TempDir()

	s, err := newFileStore(dir)
	if err != nil {
		t.Fatalf("newFileStore: %v", err)
	}
	if s.Kind() != "file" {
		t.Fatalf("Kind = %q, want file", s.Kind())
	}
	if _, err := s.Next(context.Background()); err != nil {
		t.Fatalf("Next: %v", err)
	}
	n, err := s.Next(context.Background())
	if err != nil {
		t.Fatalf("Next: %v", err)
	}
	if n != 2 {
		t.Fatalf("Next = %d, want 2", n)
	}

	// 重新打开（模拟重启）应读回已有计数，而不是从 1 开始。
	s2, err := newFileStore(dir)
	if err != nil {
		t.Fatalf("newFileStore(2): %v", err)
	}
	n2, err := s2.Next(context.Background())
	if err != nil {
		t.Fatalf("Next(2): %v", err)
	}
	if n2 != 3 {
		t.Fatalf("Next = %d, want 3", n2)
	}
}
