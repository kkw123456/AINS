package com.webgen.app.common;

/**
 * 业务异常。可预期的失败（参数不对、资源不存在）一律抛这个，
 * 由 {@link GlobalExceptionHandler} 统一转成 {@link ErrorResponse}（{@code {"error":{...}}}）。
 *
 * **不要**在 service 里返回 null 让 controller 去猜 —— 那样每个调用点都要判空，很快就没人判了。
 *
 * code 用 5 位：前三位是语义 HTTP 状态（400/404/409），后两位细分（00 通用）。
 */
public class BizException extends RuntimeException {

    private final int code;

    public BizException(int code, String message) {
        super(message);
        this.code = code;
    }

    public static BizException notFound(String what) {
        return new BizException(40400, what + "不存在");
    }

    public static BizException badRequest(String message) {
        return new BizException(40000, message);
    }

    public int getCode() {
        return code;
    }
}
