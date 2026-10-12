package handler

import (
	"encoding/json"
	"net/http"
)

// errorBody 是统一错误体：{"error":{"code","message"}}。
type errorBody struct {
	Error errorDetail `json:"error"`
}

type errorDetail struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

// WriteJSON 写 JSON 响应（含状态码）。
func WriteJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

// WriteError 写统一错误体。处理器和 httpserver 的 404 / panic 兜底都用它，
// 保证全站错误响应形状一致。
func WriteError(w http.ResponseWriter, status int, code, message string) {
	WriteJSON(w, status, errorBody{Error: errorDetail{Code: code, Message: message}})
}
