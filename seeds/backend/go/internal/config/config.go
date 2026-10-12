// Package config 读环境变量并做启动校验。
//
// 存储档位由环境变量**推导**（互斥、按优先级）：
//
//	有 DATABASE_URL       → mysql
//	否则有 WEBGEN_DATA_DIR → file
//	否则                   → memory（进程内计数，重启归零）
package config

import (
	"fmt"
	"net/url"
	"os"
	"strconv"
	"strings"
)

// 存储档位（store.Kind 的取值来源）。
const (
	StorageMySQL  = "mysql"
	StorageFile   = "file"
	StorageMemory = "memory"
)

// Config 是进程的运行时配置。
type Config struct {
	AppEnv   string // APP_ENV（development 时用偏人类可读的日志）
	Port     string // APP_PORT，内部端口，默认 3001
	LogLevel string // LOG_LEVEL，zap 日志级别，默认 info

	StorageKind string // mysql | file | memory
	MySQLDSN    string // 由 DATABASE_URL 转成的 go-sql-driver DSN
	DataDir     string // WEBGEN_DATA_DIR（文件存储落盘目录）

	RedisURL       string // REDIS_URL，空表示不用缓存
	RedisKeyPrefix string // REDIS_KEY_PREFIX，按项目隔离 key

	S3Endpoint  string // S3_ENDPOINT，如 http://minio:9000；空表示没有对象存储
	S3AccessKey string // S3_ACCESS_KEY
	S3SecretKey string // S3_SECRET_KEY
	S3Bucket    string // S3_BUCKET，每项目一个，形如 p_<projectId>
	S3Region    string // S3_REGION，默认 us-east-1
}

// Load 读环境变量并校验，返回配置。
func Load() (*Config, error) {
	c := &Config{
		AppEnv:         getenv("APP_ENV", "production"),
		Port:           getenv("APP_PORT", "3001"),
		LogLevel:       getenv("LOG_LEVEL", "info"),
		DataDir:        strings.TrimSpace(os.Getenv("WEBGEN_DATA_DIR")),
		RedisURL:       strings.TrimSpace(os.Getenv("REDIS_URL")),
		RedisKeyPrefix: os.Getenv("REDIS_KEY_PREFIX"),

		S3Endpoint:  strings.TrimSpace(os.Getenv("S3_ENDPOINT")),
		S3AccessKey: strings.TrimSpace(os.Getenv("S3_ACCESS_KEY")),
		S3SecretKey: strings.TrimSpace(os.Getenv("S3_SECRET_KEY")),
		S3Bucket:    strings.TrimSpace(os.Getenv("S3_BUCKET")),
		S3Region:    getenv("S3_REGION", "us-east-1"),
	}

	if err := validatePort(c.Port); err != nil {
		return nil, err
	}

	dbURL := strings.TrimSpace(os.Getenv("DATABASE_URL"))
	switch {
	case dbURL != "":
		dsn, err := mysqlDSNFromURL(dbURL)
		if err != nil {
			return nil, fmt.Errorf("DATABASE_URL 无效: %w", err)
		}
		c.StorageKind = StorageMySQL
		c.MySQLDSN = dsn
	case c.DataDir != "":
		c.StorageKind = StorageFile
	default:
		c.StorageKind = StorageMemory
	}

	if c.RedisURL != "" {
		u, err := url.Parse(c.RedisURL)
		if err != nil || u.Scheme == "" {
			return nil, fmt.Errorf("REDIS_URL 无效: %q", c.RedisURL)
		}
	}

	return c, nil
}

// IsDev 判断是否开发环境（用开发版日志编码器）。
func (c *Config) IsDev() bool { return c.AppEnv == "development" || c.AppEnv == "dev" }

// RedisEnabled 是否配置了 Redis。
func (c *Config) RedisEnabled() bool { return c.RedisURL != "" }

// S3Enabled 是否配置了对象存储（有 S3_ENDPOINT 即视为接入）。
func (c *Config) S3Enabled() bool { return c.S3Endpoint != "" }

func getenv(key, def string) string {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		return v
	}
	return def
}

func validatePort(p string) error {
	n, err := strconv.Atoi(p)
	if err != nil || n < 1 || n > 65535 {
		return fmt.Errorf("APP_PORT 无效: %q（应为 1-65535 的整数）", p)
	}
	return nil
}

// mysqlDSNFromURL 把平台注入的 `mysql://user:pass@host:3306/db` 转成
// go-sql-driver 认的 DSN `user:pass@tcp(host:3306)/db?...`。
// 已经是 DSN 形式时原样返回（宽容）。
func mysqlDSNFromURL(raw string) (string, error) {
	if !strings.HasPrefix(raw, "mysql://") {
		return raw, nil
	}
	u, err := url.Parse(raw)
	if err != nil {
		return "", err
	}
	if u.User == nil {
		return "", fmt.Errorf("缺少用户名")
	}
	user := u.User.Username()
	pass, _ := u.User.Password()

	host := u.Host
	if host == "" {
		return "", fmt.Errorf("缺少主机")
	}
	if !strings.Contains(host, ":") {
		host += ":3306"
	}
	db := strings.TrimPrefix(u.Path, "/")
	if db == "" {
		return "", fmt.Errorf("缺少数据库名")
	}

	q := url.Values{}
	q.Set("parseTime", "true")
	q.Set("charset", "utf8mb4")
	q.Set("loc", "UTC")

	return fmt.Sprintf("%s:%s@tcp(%s)/%s?%s", user, pass, host, db, q.Encode()), nil
}
