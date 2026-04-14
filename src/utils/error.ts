// ─── Error Utilities ────────────────────────────────────────────────────────

/**
 * 从 unknown 类型的 catch 参数中安全提取错误消息。
 *
 * 为什么需要：TypeScript strict 模式下 catch 参数是 unknown，
 * 项目中有 20+ 处重复的 `error instanceof Error ? error.message : String(error)` 模式。
 */
export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
