// Package logger 构建 zap 结构化日志器。
package logger

import (
	"go.uber.org/zap"
	"go.uber.org/zap/zapcore"

	"app/internal/config"
)

// New 按配置构建 *zap.Logger。
// 开发环境用人类可读的控制台编码器，生产环境用 JSON。
func New(cfg *config.Config) (*zap.Logger, error) {
	level := zapcore.InfoLevel
	if err := level.Set(cfg.LogLevel); err != nil {
		// 非法级别不致命：保持 info。
		level = zapcore.InfoLevel
	}

	var zc zap.Config
	if cfg.IsDev() {
		zc = zap.NewDevelopmentConfig()
	} else {
		zc = zap.NewProductionConfig()
	}
	zc.Level = zap.NewAtomicLevelAt(level)
	zc.EncoderConfig.EncodeTime = zapcore.ISO8601TimeEncoder

	return zc.Build()
}
