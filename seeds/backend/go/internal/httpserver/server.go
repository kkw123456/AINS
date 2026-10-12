package httpserver

import (
	"context"
	"errors"
	"net"
	"net/http"
	"time"

	"go.uber.org/zap"

	"app/internal/config"
)

// Server 包一层 http.Server，负责启动与优雅退出。
type Server struct {
	http *http.Server
	log  *zap.Logger
}

// New 构造服务。监听 127.0.0.1:APP_PORT —— 只对容器内（nginx）可见。
func New(cfg *config.Config, log *zap.Logger, handler http.Handler) *Server {
	addr := net.JoinHostPort("127.0.0.1", cfg.Port)
	return &Server{
		http: &http.Server{
			Addr:              addr,
			Handler:           handler,
			ReadHeaderTimeout: 10 * time.Second,
			ReadTimeout:       30 * time.Second,
			WriteTimeout:      30 * time.Second,
			IdleTimeout:       60 * time.Second,
		},
		log: log,
	}
}

// Run 启动并在 ctx 取消（SIGTERM/SIGINT）时优雅关闭。
func (s *Server) Run(ctx context.Context) error {
	errCh := make(chan error, 1)
	go func() {
		s.log.Info("HTTP 服务启动", zap.String("addr", s.http.Addr))
		if err := s.http.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			errCh <- err
		}
	}()

	select {
	case <-ctx.Done():
		s.log.Info("收到退出信号，开始优雅关闭")
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		return s.http.Shutdown(shutdownCtx)
	case err := <-errCh:
		return err
	}
}
