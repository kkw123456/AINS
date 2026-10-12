// 只为预热模块缓存（见 Dockerfile）：把四门语言主流库 require 进来，
// `go mod tidy` 之后落进 GOMODCACHE，新建项目时 go build 就是纯本地命中。
// 这里不写业务逻辑，只 imports 包使其进入模块图。
package main

import (
	_ "github.com/go-chi/chi/v5"
	_ "github.com/go-sql-driver/mysql"
	_ "github.com/jmoiron/sqlx"
	_ "github.com/minio/minio-go/v7"
	_ "github.com/redis/go-redis/v9"
	_ "go.uber.org/zap"
)

func main() {}
