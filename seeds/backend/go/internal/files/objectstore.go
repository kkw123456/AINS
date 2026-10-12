// Package files 封装可选的 MinIO（S3 兼容）对象存储 —— 组合项目里的「文件系统」。
//
// 有 S3_ENDPOINT 就用真 MinIO；没有就返回一个空实现（Kind() 为 "none"），
// handler 据此在 /api/files 里输出 storage="none"、objects=[]。和 internal/cache
// 是同一档可选旁路：**没接不是错误，接了连不上也绝不崩**。
//
// 平台通过环境变量注入连接信息（共享实例 + 平台凭证，每项目一个 bucket p_<id>）：
// S3_ENDPOINT / S3_ACCESS_KEY / S3_SECRET_KEY / S3_BUCKET / S3_REGION。
package files

import (
	"bytes"
	"context"
	"strings"

	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"
	"go.uber.org/zap"
)

// Store 是对象存储抽象。
type Store interface {
	// Kind 返回 "minio"，未启用时返回 "none"。
	Kind() string
	// Bucket 返回 bucket 名（未启用时为空串，接口里原样回给调用方）。
	Bucket() string
	// List 确保 bucket 存在后列出对象名，最多 limit 个。
	List(ctx context.Context, limit int) ([]string, error)
	// Put 确保 bucket 存在后写入一个对象。
	Put(ctx context.Context, key string, data []byte) error
}

// nopStore 是未配置对象存储时的空实现 —— 调用方不必到处判空。
type nopStore struct{}

func (nopStore) Kind() string                                { return "none" }
func (nopStore) Bucket() string                              { return "" }
func (nopStore) List(context.Context, int) ([]string, error) { return []string{}, nil }
func (nopStore) Put(context.Context, string, []byte) error   { return nil }

type minioStore struct {
	client *minio.Client
	bucket string
	region string
}

func (s *minioStore) Kind() string   { return "minio" }
func (s *minioStore) Bucket() string { return s.bucket }

// ensureBucket 幂等建桶：不存在才建。每次调用都先探一次，连不上会把错误抛给调用方。
func (s *minioStore) ensureBucket(ctx context.Context) error {
	exists, err := s.client.BucketExists(ctx, s.bucket)
	if err != nil {
		return err
	}
	if exists {
		return nil
	}
	return s.client.MakeBucket(ctx, s.bucket, minio.MakeBucketOptions{Region: s.region})
}

func (s *minioStore) List(ctx context.Context, limit int) ([]string, error) {
	if err := s.ensureBucket(ctx); err != nil {
		return nil, err
	}
	names := make([]string, 0, limit)
	for obj := range s.client.ListObjects(ctx, s.bucket, minio.ListObjectsOptions{Recursive: true}) {
		if obj.Err != nil {
			return nil, obj.Err
		}
		names = append(names, obj.Key)
		if len(names) >= limit {
			break
		}
	}
	return names, nil
}

func (s *minioStore) Put(ctx context.Context, key string, data []byte) error {
	if err := s.ensureBucket(ctx); err != nil {
		return err
	}
	_, err := s.client.PutObject(ctx, s.bucket, key, bytes.NewReader(data), int64(len(data)),
		minio.PutObjectOptions{ContentType: "text/plain; charset=utf-8"})
	return err
}

// New 按配置构造对象存储。没有 S3_ENDPOINT 时返回空实现（"none"）。
//
// ⚠️ 构造 MinIO 客户端**不做任何网络 I/O** —— 连不上 MinIO 也不会拖垮启动。
// 真正的连通性在第一次 List/Put（内部 ensureBucket）时才暴露，由 handler 兜底降级。
// S3_ENDPOINT 形状非法（minio.New 解析失败）属于配置错误，如实返回 error。
func New(endpoint, accessKey, secretKey, bucket, region string, log *zap.Logger) (Store, error) {
	if endpoint == "" {
		return nopStore{}, nil
	}

	// MinIO 的 endpoint 要 host:port（不带 scheme），secure 由 scheme 决定。
	host := endpoint
	secure := false
	switch {
	case strings.HasPrefix(host, "https://"):
		secure = true
		host = strings.TrimPrefix(host, "https://")
	case strings.HasPrefix(host, "http://"):
		host = strings.TrimPrefix(host, "http://")
	}
	host = strings.TrimSuffix(host, "/")

	client, err := minio.New(host, &minio.Options{
		Creds:  credentials.NewStaticV4(accessKey, secretKey, ""),
		Secure: secure,
		Region: region,
	})
	if err != nil {
		return nil, err
	}

	log.Info("已接入 MinIO 对象存储",
		zap.String("endpoint", endpoint),
		zap.String("bucket", bucket),
	)
	return &minioStore{client: client, bucket: bucket, region: region}, nil
}
