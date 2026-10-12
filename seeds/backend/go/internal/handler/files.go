package handler

import (
	"fmt"
	"net/http"
	"time"

	"go.uber.org/zap"

	"app/internal/files"
)

// filesListResponse 是 GET /api/files 的响应体。
// objects 恒为非 null 数组（没接对象存储时是 []）。
type filesListResponse struct {
	Backend string   `json:"backend"`
	Storage string   `json:"storage"`
	Bucket  string   `json:"bucket"`
	Objects []string `json:"objects"`
}

// filesUploadResponse 是 POST /api/files 的响应体。
type filesUploadResponse struct {
	Backend string `json:"backend"`
	Storage string `json:"storage"`
	Bucket  string `json:"bucket"`
	Key     string `json:"key"`
}

// filesListLimit 列对象时的上限，别把整个 bucket 拉回来。
const filesListLimit = 20

// 写进去的默认内容（和后端问候一致）。
const filesDefaultContent = "你好，来自 Go 后端的问候！"

// FilesList 是 GET /api/files 处理器：
// 200 + {"backend":"go","storage":"minio"|"none","bucket":...,"objects":[...]}。
// 没接对象存储 → storage="none"；接了但连不上 → 记 warning 并降级为 "none"。
func FilesList(log *zap.Logger, st files.Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if st.Kind() == "none" {
			WriteJSON(w, http.StatusOK, filesListResponse{
				Backend: "go", Storage: "none", Bucket: "", Objects: []string{},
			})
			return
		}

		objects, err := st.List(r.Context(), filesListLimit)
		if err != nil {
			log.Warn("MinIO 不可达，GET /api/files 降级为 storage=none", zap.String("error", err.Error()))
			WriteJSON(w, http.StatusOK, filesListResponse{
				Backend: "go", Storage: "none", Bucket: "", Objects: []string{},
			})
			return
		}

		WriteJSON(w, http.StatusOK, filesListResponse{
			Backend: "go", Storage: "minio", Bucket: st.Bucket(), Objects: objects,
		})
	}
}

// FilesCreate 是 POST /api/files 处理器：
// 200 + {"backend":"go","storage":"minio"|"none","bucket":...,"key":...}。
func FilesCreate(log *zap.Logger, st files.Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if st.Kind() == "none" {
			WriteJSON(w, http.StatusOK, filesUploadResponse{
				Backend: "go", Storage: "none", Bucket: "", Key: "",
			})
			return
		}

		key := fmt.Sprintf("upload-%d.txt", time.Now().UnixNano())
		if err := st.Put(r.Context(), key, []byte(filesDefaultContent)); err != nil {
			log.Warn("MinIO 不可达，POST /api/files 降级为 storage=none", zap.String("error", err.Error()))
			WriteJSON(w, http.StatusOK, filesUploadResponse{
				Backend: "go", Storage: "none", Bucket: "", Key: "",
			})
			return
		}

		WriteJSON(w, http.StatusOK, filesUploadResponse{
			Backend: "go", Storage: "minio", Bucket: st.Bucket(), Key: key,
		})
	}
}
