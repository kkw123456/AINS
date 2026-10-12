package com.webgen.app.common;

/**
 * 统一返回体（成功壳）。**生成出来的业务接口**用它，前端只认这一种形状，
 * 别让每个接口各返回各的。字段名用最常见的 code / message / data。
 *
 * code 约定：0 = 成功，非 0 = 业务失败（见 {@link BizException}）。
 *
 * ⚠️ 平台契约的三条接口（/health、/api/hello、/api/visits）**不套这层壳** ——
 *    它们要和 node / python / go 逐字同形（见各 controller 的说明）。
 *    这个是给"agent 后续生成的业务接口"用的统一约定。
 *
 * 失败**不**走这里，走 {@link ErrorResponse}（{@code {"error":{"code","message"}}}）。
 */
public class ApiResponse<T> {

    private int code;
    private String message;
    private T data;

    public ApiResponse() {
    }

    public ApiResponse(int code, String message, T data) {
        this.code = code;
        this.message = message;
        this.data = data;
    }

    public static <T> ApiResponse<T> ok(T data) {
        return new ApiResponse<>(0, "ok", data);
    }

    public static <T> ApiResponse<T> ok() {
        return new ApiResponse<>(0, "ok", null);
    }

    public int getCode() {
        return code;
    }

    public String getMessage() {
        return message;
    }

    public T getData() {
        return data;
    }
}
