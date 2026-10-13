/**
 * 档案字段的纯解析与简历文本拼装（基础版模块）
 * ─────────────────────────────────────────────────────────────
 * 这三个函数**只做字符串拼装与切分，不调用 LLM、不碰浏览器**，
 * 因此它们属于基础侧，而不是跟着「AI 定制简历 / AI 自动回复」留在核心：
 *
 *   · `/api/resume/compliance`（简历合规检测）是**基础功能**，
 *     它用 buildResumeBlob() 从档案拼出待检测文本。
 *   · `apply/engine.ts`（一键投递引擎，基础）用 parsePositions() 解析目标职位。
 *   · 若这些函数留在核心模块里，基础版里它们就是桩 ⇒
 *     合规检测整体 500、一键投递走到目标职位解析就抛错（2026-10-12 全路由实测确认）。
 *
 * 真相源单一化：核心的 `apply/resumeTailor.ts`、`apply/autoReply.ts` 从这里 re-export
 * （core → base，允许方向），所以既有调用方都无需改动，口径也只有一份。
 */

/** 解析「目标职位」这类自由文本字段：支持数组，或 中文/英文逗号、顿号、分号、换行 分隔 */
export function parsePositions(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map((s) => String(s).trim()).filter(Boolean);
  if (typeof raw !== 'string' || !raw.trim()) return [];
  return raw
    .split(/[,，、;；\n]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** 从档案里取简历可检索文本（与 backfill_match 同口径） */
export function buildResumeBlob(profile: Record<string, any>): string {
  const skills = parseSkills(profile);
  return [
    profile?.name, profile?.school, profile?.major, profile?.education,
    profile?.city, profile?.expectedPositions, skills.join(' '),
    profile?.experience, profile?.projects, profile?.selfEvaluation,
  ].filter(Boolean).map(String).join(' ');
}

/** 解析档案技能字段（支持 中文逗号/顿号/分号/斜杠/竖线 分隔） */
export function parseSkills(profile: Record<string, any>): string[] {
  const raw = String(profile?.skills ?? profile?.pfSkills ?? '');
  return Array.from(new Set(
    raw.split(/[,，、;；/|]+/).map((s) => s.trim()).filter(Boolean),
  ));
}
