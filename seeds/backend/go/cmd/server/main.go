// 组合出来的项目里的 **Go 后端**（企业级分层骨架）。
//
// ⚠️ 它**不伺服前端静态文件** —— 那是容器里 nginx 的活（见工作区根的 nginx.conf）。
// 这里只有 API 路由。端口听 **APP_PORT**（容器内的内部端口，默认 3001），
// **绝不**听 PORT —— 对外的 8080 归 nginx，两个都用同一个会抢端口。
//
// 分层：
//
//	cmd/server      —— 入口：装配依赖、起服务、优雅退出
//	internal/config —— 读环境变量 + 启动校验
//	internal/logger —— zap 结构化日志
//	internal/httpserver —— chi 路由 + 中间件（请求日志 / recover / 统一错误体）
//	internal/handler    —— HTTP 处理器
//	internal/service    —— 业务逻辑
//	internal/store      —— 存储抽象（mysql / file / memory）
//	internal/cache      —— Redis 缓存（可选）
//	internal/files      —— MinIO 对象存储（可选，S3 兼容）
package main

import (
	"context"
	"fmt"
	"os"
	"os/signal"
	"syscall"

	"go.uber.org/zap"

	"app/internal/cache"
	"app/internal/config"
	"app/internal/files"
	"app/internal/httpserver"
	"app/internal/logger"
	"app/internal/service"
	"app/internal/store"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintf(os.Stderr, "服务启动失败: %v\n", err)
		os.Exit(1)
	}
}

func run() error {
	cfg, err := config.Load()
	if err != nil {
		return err
	}

	log, err := logger.New(cfg)
	if err != nil {
		return err
	}
	defer func() { _ = log.Sync() }()

	log.Info("应用启动",
		zap.String("env", cfg.AppEnv),
		zap.String("storage", cfg.StorageKind),
		zap.String("port", cfg.Port),
		zap.Bool("redis", cfg.RedisEnabled()),
		zap.Bool("s3", cfg.S3Enabled()),
	)

	// 捕获 SIGTERM / SIGINT，收到后 srv.Shutdown 优雅退出。
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	st, err := store.New(ctx, store.Options{
		Kind:    cfg.StorageKind,
		DSN:     cfg.MySQLDSN,
		DataDir: cfg.DataDir,
	})
	if err != nil {
		return err
	}
	defer func() { _ = st.Close() }()

	ca, err := cache.New(ctx, cfg.RedisURL, cfg.RedisKeyPrefix, log)
	if err != nil {
		return err
	}
	defer func() { _ = ca.Close() }()

	svc := service.NewVisitService(st, ca, log)

	// 对象存储（「文件系统」）是可选的：没配 S3_* 就退化成空实现，接口照常 200。
	objStore, err := files.New(cfg.S3Endpoint, cfg.S3AccessKey, cfg.S3SecretKey, cfg.S3Bucket, cfg.S3Region, log)
	if err != nil {
		return err
	}

	router := httpserver.NewRouter(log, svc, objStore)
	srv := httpserver.New(cfg, log, router)

	return srv.Run(ctx)
}
