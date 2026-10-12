package httpserver

import (
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"go.uber.org/zap"

	"app/internal/files"
	"app/internal/handler"
	"app/internal/service"
)

// NewRouter 组装 chi 路由与中间件。
func NewRouter(log *zap.Logger, svc *service.VisitService, objStore files.Store) http.Handler {
	r := chi.NewRouter()

	r.Use(middleware.RequestID)
	r.Use(middleware.RealIP)
	r.Use(requestLogger(log))
	r.Use(recoverer(log))

	// 兜底：未知路由 / 方法不匹配也走统一错误体。
	r.NotFound(func(w http.ResponseWriter, r *http.Request) {
		handler.WriteError(w, http.StatusNotFound, "not_found", "没有这个路由："+r.URL.Path)
	})
	r.MethodNotAllowed(func(w http.ResponseWriter, r *http.Request) {
		handler.WriteError(w, http.StatusMethodNotAllowed, "method_not_allowed", "不支持的方法："+r.Method)
	})

	r.Get("/health", handler.Health())
	r.Get("/api/hello", handler.Hello())
	r.Get("/api/visits", handler.Visits(log, svc))

	// 对象存储（「文件系统」）—— 没配 S3 时也返回 200，storage="none"。
	r.Get("/api/files", handler.FilesList(log, objStore))
	r.Post("/api/files", handler.FilesCreate(log, objStore))

	return r
}
