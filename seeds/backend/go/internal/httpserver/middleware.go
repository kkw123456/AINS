package httpserver

import (
	"net/http"
	"time"

	"github.com/go-chi/chi/v5/middleware"
	"go.uber.org/zap"

	"app/internal/handler"
)

// requestLogger 记录每个请求的方法/路径/状态/耗时。
func requestLogger(log *zap.Logger) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			start := time.Now()
			ww := middleware.NewWrapResponseWriter(w, r.ProtoMajor)

			next.ServeHTTP(ww, r)

			log.Info("http 请求",
				zap.String("method", r.Method),
				zap.String("path", r.URL.Path),
				zap.Int("status", ww.Status()),
				zap.Int("bytes", ww.BytesWritten()),
				zap.Duration("duration", time.Since(start)),
				zap.String("remote", r.RemoteAddr),
			)
		})
	}
}

// recoverer 兜住 panic，记日志并回统一错误体（否则 chi 默认只回纯文本 500）。
func recoverer(log *zap.Logger) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			defer func() {
				if rec := recover(); rec != nil {
					log.Error("请求处理 panic",
						zap.Any("panic", rec),
						zap.Stack("stack"),
					)
					handler.WriteError(w, http.StatusInternalServerError, "internal_error", "服务内部错误")
				}
			}()
			next.ServeHTTP(w, r)
		})
	}
}
