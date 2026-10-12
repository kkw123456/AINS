package handler

import (
	"net/http"

	"go.uber.org/zap"

	"app/internal/service"
)

// visitsResponse 是 /api/visits 的响应体。
// Cache 用 *string：没配 Redis 时序列化成 null，配了就是 "redis"。
type visitsResponse struct {
	Visits  int64   `json:"visits"`
	Storage string  `json:"storage"`
	Cache   *string `json:"cache"`
}

// Visits 是 GET /api/visits 处理器：
// 200 + {"visits":<int>,"storage":"<mysql|file|memory>","cache":"redis"|null}。
func Visits(log *zap.Logger, svc *service.VisitService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		n, err := svc.Visit(r.Context())
		if err != nil {
			log.Error("记录访问失败", zap.String("error", err.Error()))
			WriteError(w, http.StatusInternalServerError, "visit_failed", "记录访问失败")
			return
		}

		var cacheKind *string
		if k := svc.CacheKind(); k != "" {
			cacheKind = &k
		}

		WriteJSON(w, http.StatusOK, visitsResponse{
			Visits:  n,
			Storage: svc.StorageKind(),
			Cache:   cacheKind,
		})
	}
}
