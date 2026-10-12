package com.webgen.app.common;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.HttpRequestMethodNotSupportedException;
import org.springframework.web.bind.MethodArgumentNotValidException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestControllerAdvice;
import org.springframework.web.servlet.resource.NoResourceFoundException;

/**
 * 全局异常处理。controller 里不该出现 try/catch —— 都收敛到这里，失败形状才不会各处漂移。
 * 统一产出 {@link ErrorResponse} 的 {@code {"error":{"code","message"}}}。
 *
 * HTTP 状态码和业务 code 是两回事，但**不能只给业务 code 而 HTTP 永远 200** ——
 * 那样监控、网关、前端拦截器全都看不出这是失败。
 */
@RestControllerAdvice
public class GlobalExceptionHandler {

    private static final Logger log = LoggerFactory.getLogger(GlobalExceptionHandler.class);

    /** 按业务 code 的前三位映射语义状态码：40400→404、40000→400、40900→409 */
    @ExceptionHandler(BizException.class)
    public ResponseEntity<ErrorResponse> handleBiz(BizException e) {
        HttpStatus status = switch (e.getCode() / 100) {
            case 400 -> HttpStatus.BAD_REQUEST;
            case 404 -> HttpStatus.NOT_FOUND;
            case 409 -> HttpStatus.CONFLICT;
            default -> HttpStatus.OK;
        };
        return ResponseEntity.status(status).body(new ErrorResponse(e.getCode(), e.getMessage()));
    }

    /** @Valid 校验失败：挑第一条字段错误当 message，别把整串对象甩给用户 */
    @ExceptionHandler(MethodArgumentNotValidException.class)
    @ResponseStatus(HttpStatus.BAD_REQUEST)
    public ErrorResponse handleInvalid(MethodArgumentNotValidException e) {
        String msg = e.getBindingResult().getFieldErrors().stream()
                .findFirst()
                .map(f -> f.getField() + " " + f.getDefaultMessage())
                .orElse("参数不合法");
        return new ErrorResponse(40000, msg);
    }

    /**
     * 路径不存在。
     *
     * ⚠️ **必须单独接这一条**：Spring 对找不到的资源抛的是 NoResourceFoundException，
     * 它是 Exception 的子类 —— 不单独处理就会被下面的兜底吃掉，404 活生生变成 500，
     * 监控里刷出一片"服务器内部错误"而实际什么都没坏。
     */
    @ExceptionHandler(NoResourceFoundException.class)
    @ResponseStatus(HttpStatus.NOT_FOUND)
    public ErrorResponse handleNoResource(NoResourceFoundException e) {
        return new ErrorResponse(40400, "资源不存在：" + e.getResourcePath());
    }

    /** 方法不支持（路径对、动词错）：也是客户端的问题，别记成 500 */
    @ExceptionHandler(HttpRequestMethodNotSupportedException.class)
    @ResponseStatus(HttpStatus.METHOD_NOT_ALLOWED)
    public ErrorResponse handleMethod(HttpRequestMethodNotSupportedException e) {
        return new ErrorResponse(40500, "不支持 " + e.getMethod() + " 方法");
    }

    /** 兜底：没预料到的异常必须打完整栈，否则线上只能靠猜 */
    @ExceptionHandler(Exception.class)
    @ResponseStatus(HttpStatus.INTERNAL_SERVER_ERROR)
    public ErrorResponse handleOther(Exception e) {
        log.error("未处理的异常", e);
        return new ErrorResponse(50000, "服务器内部错误");
    }
}
