package handler

import "net/http"

// Health 是 GET /health 处理器：200 + 纯文本 "ok"。
// nginx 会把 /health 转过来（对外那一跳由它承担）。
func Health() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	}
}
