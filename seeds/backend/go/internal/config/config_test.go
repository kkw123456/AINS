package config

import "testing"

func TestLoadDefaultsToMemory(t *testing.T) {
	t.Setenv("APP_PORT", "")
	t.Setenv("APP_ENV", "")
	t.Setenv("LOG_LEVEL", "")
	t.Setenv("DATABASE_URL", "")
	t.Setenv("WEBGEN_DATA_DIR", "")
	t.Setenv("REDIS_URL", "")
	t.Setenv("S3_ENDPOINT", "")

	c, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if c.Port != "3001" {
		t.Fatalf("Port = %q, want 3001", c.Port)
	}
	if c.StorageKind != StorageMemory {
		t.Fatalf("StorageKind = %q, want %q", c.StorageKind, StorageMemory)
	}
	if c.RedisEnabled() {
		t.Fatal("RedisEnabled 应为 false")
	}
	if c.S3Enabled() {
		t.Fatal("S3Enabled 应为 false")
	}
	if c.S3Region != "us-east-1" {
		t.Fatalf("S3Region = %q, want us-east-1", c.S3Region)
	}
}

func TestLoadS3(t *testing.T) {
	t.Setenv("APP_PORT", "3001")
	t.Setenv("S3_ENDPOINT", "http://minio:9000")
	t.Setenv("S3_ACCESS_KEY", "ak")
	t.Setenv("S3_SECRET_KEY", "sk")
	t.Setenv("S3_BUCKET", "p_abc123")
	t.Setenv("S3_REGION", "")

	c, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if !c.S3Enabled() {
		t.Fatal("S3Enabled 应为 true")
	}
	if c.S3Bucket != "p_abc123" {
		t.Fatalf("S3Bucket = %q, want p_abc123", c.S3Bucket)
	}
	// 空 S3_REGION 回落到默认。
	if c.S3Region != "us-east-1" {
		t.Fatalf("S3Region = %q, want us-east-1", c.S3Region)
	}
}

func TestLoadMySQLWinsOverFile(t *testing.T) {
	t.Setenv("APP_PORT", "3001")
	t.Setenv("DATABASE_URL", "mysql://u:p@db:3306/app")
	t.Setenv("WEBGEN_DATA_DIR", "/workspace/data")

	c, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if c.StorageKind != StorageMySQL {
		t.Fatalf("StorageKind = %q, want %q", c.StorageKind, StorageMySQL)
	}
	want := "u:p@tcp(db:3306)/app?charset=utf8mb4&loc=UTC&parseTime=true"
	if c.MySQLDSN != want {
		t.Fatalf("MySQLDSN = %q, want %q", c.MySQLDSN, want)
	}
}

func TestLoadFile(t *testing.T) {
	t.Setenv("APP_PORT", "3001")
	t.Setenv("DATABASE_URL", "")
	t.Setenv("WEBGEN_DATA_DIR", "/workspace/data")

	c, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if c.StorageKind != StorageFile {
		t.Fatalf("StorageKind = %q, want %q", c.StorageKind, StorageFile)
	}
}

func TestMySQLDSNAddsDefaultPort(t *testing.T) {
	dsn, err := mysqlDSNFromURL("mysql://root:secret@mysql/app")
	if err != nil {
		t.Fatalf("mysqlDSNFromURL: %v", err)
	}
	want := "root:secret@tcp(mysql:3306)/app?charset=utf8mb4&loc=UTC&parseTime=true"
	if dsn != want {
		t.Fatalf("dsn = %q, want %q", dsn, want)
	}
}

func TestInvalidPort(t *testing.T) {
	t.Setenv("APP_PORT", "not-a-port")
	if _, err := Load(); err == nil {
		t.Fatal("非法 APP_PORT 应报错")
	}
}
