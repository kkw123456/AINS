package handler

import "net/http"

const backendName = "go"

type helloResponse struct {
	Message string `json:"message"`
	Backend string `json:"backend"`
}

// Hello 是 GET /api/hello 处理器：
// 200 + {"message":"<一句中文问候>","backend":"go"}。
func Hello() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		WriteJSON(w, http.StatusOK, helloResponse{
			Message: "你好，我是 Go 后端",
			Backend: backendName,
		})
	}
}
