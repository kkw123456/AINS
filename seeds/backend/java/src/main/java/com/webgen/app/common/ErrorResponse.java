package com.webgen.app.common;

/**
 * 统一**错误**返回体：任何失败都返回 {@code {"error": {"code", "message"}}}。
 *
 * 和 node / python 两个后端保持同一种失败形状（python 的 app/core/errors.py 就是这个）。
 * 成功走 {@link ApiResponse}，失败走这里 —— 成功 / 失败分开两种壳，是刻意的。
 */
public class ErrorResponse {

    private final Error error;

    public ErrorResponse(int code, String message) {
        this.error = new Error(code, message);
    }

    public Error getError() {
        return error;
    }

    public static class Error {

        private final int code;
        private final String message;

        public Error(int code, String message) {
            this.code = code;
            this.message = message;
        }

        public int getCode() {
            return code;
        }

        public String getMessage() {
            return message;
        }
    }
}
