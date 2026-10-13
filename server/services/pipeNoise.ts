/**
 * 「管道断开 / 页面关闭」两类噪声错误的识别（基础版模块）
 * ─────────────────────────────────────────────────────────────
 * 🔴 为什么这两个函数必须在**基础侧**，而不是跟着自动化链路留在核心：
 *    `server/index.ts` 的**进程级错误兜底**（`process.on('uncaughtException')` /
 *    `unhandledRejection`）要用 `isPipeNoise()` 来决定「这条错误能不能写日志」。
 *    若它来自核心模块，基础版里它就是桩 ⇒ 在**错误处理器内部抛错** ⇒ 异常逃逸成
 *    致命异常 ⇒ 整个进程直接死。
 *    2026-10-12 实测确认过这条路：删掉核心后，任何一次管道噪声都会把服务打死。
 *
 * 真相源单一化：核心的 `safeOp.ts` 从这里 re-export（core → base，允许方向），
 * 所以两个版本用的是**同一份**特征表，不会漂移。
 */

/** 关闭态错误特征（页面被关 / 会话断开 / 导航中断）——这些不是业务失败 */
export const CLOSING_ERROR_PATTERNS: readonly string[] = [
  'Target closed',
  'Session closed',
  'detached Frame',
  'Attempted to use detached Frame',
  'navigating frame was detached',
  'Cannot find context with specified id',
  'Execution context was destroyed',
  'WebSocket is not open',
  'Connection closed',
  'Protocol error',
  'Target page, context or browser has been closed',
];

/** 是否属于「页面/会话已关闭」类错误（应静默处理，不作为业务失败） */
export function isClosingRelatedError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String((err as any)?.message ?? err ?? '');
  if (!msg) return false;
  return CLOSING_ERROR_PATTERNS.some((p) => msg.includes(p));
}

/**
 * 是否是**输出管道断开**类噪声（stdout/stderr 被关闭，例如启动它的终端/父进程退出了）。
 *
 * ⚠️ 必须在进程级错误兜底里**优先于日志记录**判断：这类错误的特殊性在于
 *    「为了报告它而写日志」会再次写向已断开的管道 → 再抛同样的错误 → 自激无限循环。
 *    实测后果：单日写成 330 万行 / 240MB 日志，全部是同一句 EPIPE。
 *    它们也不是应用故障，静默丢弃是唯一正确处置。
 *
 * ⚠️ 本函数**绝不抛错** —— 它本身就跑在错误处理器里。
 */
export function isPipeNoise(err: unknown): boolean {
  try {
    const code = String((err as any)?.code || '');
    if (code === 'EPIPE' || code === 'ERR_STREAM_DESTROYED' || code === 'ERR_STREAM_WRITE_AFTER_END') return true;
    const msg = err instanceof Error ? err.message : String((err as any)?.message ?? err ?? '');
    return /EPIPE|broken pipe|write after end|stream destroyed/i.test(msg);
  } catch {
    return false;
  }
}
