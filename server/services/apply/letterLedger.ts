/**
 * 求职信「台账 + 模板」—— 非 AI 部分（**基础侧**）。
 *
 * 从 `coverLetter.ts` 抽出（2026-10-12 基础/核心分层）。原因有两条，第一条是安全：
 *   ① 🔴 `coverLetter.ts` 里带着 `SYSTEM_LETTER`（LLM 系统提示词）与 `chatText` 调用 ⇒
 *      **该文件必须归核心**。但它的模板 CRUD / 变量渲染 / 台账去重是纯本地功能，
 *      而且 `GET|POST|DELETE /api/cover-letter/template` 与 `POST /api/cover-letter/render`
 *      都是**基础版保留**的路由 ⇒ 这几个函数必须在基础侧，否则基础版一调就抛 CORE_UNAVAILABLE。
 *   ② 顺带解掉 `engine.ts`（基础）→ `coverLetter.ts`（核心）里 `markLetterSent` 那一条边。
 *
 * 分层判据：**按「谁真的依赖它」切，不是按「它属于哪个主题」切**。
 * 模板与台账不依赖 LLM，基础版也要用；只有「生成」那一步依赖 LLM。
 */
import { jobPositionLabel } from './jobText.js';
import {
  getCoverLetter, saveCoverLetter, coverLetterKey, kvGet, kvSet, getJob, updateJob, type JobRow,
} from '../../db.js';

export type LetterKind = 'hello' | 'letter' | 'reply';
export type LetterMode = 'ai' | 'custom';

export interface LetterTemplate {
  name: string;
  content: string;
  updatedAt: string;
}

const TEMPLATE_KV = 'letter:template';

/** 自定义求职信模板（全局一份，与同类产品一致：「配置自定义求职信」） */
export function getLetterTemplate(): LetterTemplate | null {
  const raw = kvGet(TEMPLATE_KV);
  if (!raw) return null;
  try {
    const t = JSON.parse(raw) as LetterTemplate;
    if (!t || typeof t.content !== 'string') return null;
    return t;
  } catch {
    return null;
  }
}

export function saveLetterTemplate(name: string, content: string): LetterTemplate {
  const t: LetterTemplate = { name: name || '未命名模板', content: content || '', updatedAt: new Date().toISOString() };
  kvSet(TEMPLATE_KV, JSON.stringify(t));
  return t;
}

export function clearLetterTemplate(): void {
  kvSet(TEMPLATE_KV, JSON.stringify({ name: '', content: '', updatedAt: new Date().toISOString() }));
}

/** 模板支持的变量（与同类产品文案一致：「可以使用 {职位名称}、{公司名称} 等变量」） */
export const TEMPLATE_VARIABLES: ReadonlyArray<{ key: string; desc: string }> = [
  { key: '{职位名称}', desc: '目标岗位名称' },
  { key: '{公司名称}', desc: '目标公司名称' },
  { key: '{工作地点}', desc: '岗位所在城市' },
  { key: '{我的姓名}', desc: '档案里的姓名' },
  { key: '{期望岗位}', desc: '档案里的意向岗位' },
  { key: '{最高学历}', desc: '档案里的学历' },
  { key: '{毕业院校}', desc: '档案里的学校' },
];

/** 变量替换；未提供的变量替换为空串（避免把 `{公司名称}` 原样发给 HR） */
export function renderLetterTemplate(tpl: string, vars: Record<string, string | null | undefined>): string {
  let out = String(tpl || '');
  for (const [k, v] of Object.entries(vars)) {
    const key = k.startsWith('{') ? k : `{${k}}`;
    out = out.split(key).join(String(v ?? ''));
  }
  // 兜底：清掉模板里没用上的未知变量占位符，避免泄露 `{xxx}` 字样
  out = out.replace(/\{[^{}\n]{1,12}\}/g, '');
  return out.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

export function varsOf(profile: Record<string, any> | null | undefined, job?: Partial<JobRow> | null): Record<string, string> {
  const p = profile || {};
  return {
    '{职位名称}': jobPositionLabel(job?.position || p.expectedPositions, ''),
    '{公司名称}': String(job?.company || '').slice(0, 40),
    '{工作地点}': String(job?.city || p.city || '').slice(0, 20),
    '{我的姓名}': String(p.name || '').slice(0, 20),
    '{期望岗位}': String(p.expectedPositions || '').slice(0, 40),
    '{最高学历}': String(p.education || '').slice(0, 10),
    '{毕业院校}': String(p.school || '').slice(0, 30),
  };
}

/** 记录「已发送求职信」到台账（供三重去重①），并把 skip_reason 标到岗位行 */
export function markLetterSent(input: {
  platform: string; job?: Partial<JobRow> | null; hrGroupId?: string | null;
  content: string; source?: string;
}): void {
  const key = coverLetterKey(input.platform, input.job?.company, input.job?.position, input.hrGroupId);
  saveCoverLetter({
    dedupe_key: key,
    platform: input.platform,
    company: input.job?.company ?? null,
    position: input.job?.position ?? null,
    job_id: input.job?.id ? String(input.job.id) : null,
    content: input.content,
    source: input.source || 'llm',
  });
  if (input.job?.id) {
    try { updateJob(String(input.job.id), { skip_reason: '已写过求职信' }); } catch { /* 忽略 */ }
  }
}

/** 该岗位/HR 是否已写过求职信（控制台预检用） */
export function letterAlreadySent(platform: string, company?: string | null, position?: string | null, hrGroupId?: string | null): boolean {
  return !!getCoverLetter(coverLetterKey(platform, company, position, hrGroupId));
}
