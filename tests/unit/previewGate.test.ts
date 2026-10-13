/**
 * `server/services/apply/previewGate.ts` 的单测 —— 「仅预览」语义的唯一收口。
 *
 * 为什么这条规则值得单独一个单测文件（而不是只写在合约测试的字符串断言里）：
 *   合约测试里那两条只能证明「`runApply` 调了这个函数」（接线正确），
 *   证明不了**函数本身**在边界上是对的。而这里钉的正是边界：
 *     · 显式 `dryRun:false` 也必须被 `preview:true` 覆盖（↓ 见第 2 条 —— 这是真坑：
 *       调用方"显式关掉干跑"时最容易以为已经安全，实际只关了三套通道里的一套）；
 *     · `preview` 缺省时**必须原样返回**（归一只加不减，真投路径绝不能被误伤）。
 *
 * 该模块只 `import type`，所以本文件不会顺带拉起 CDP / playwright / SQLite。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeApplyInput } from '../../server/services/apply/previewGate.js';
import type { ApplyInput } from '../../server/services/apply/types.js';

/** 造一个最小可用入参（只放本函数关心的字段，其余用断言绕过类型） */
function mk(extra: Partial<ApplyInput>): ApplyInput {
  return { platform: 'job51', profile: { resume_path: 'r.pdf' }, ...extra } as ApplyInput;
}

test('preview:true 且 dryRun 缺省 ⇒ 补上 dryRun:true（邮箱通道只读 dryRun，不补就会真发信）', () => {
  const out = normalizeApplyInput(mk({ preview: true }));
  assert.equal(out.dryRun, true);
  assert.equal(out.preview, true);
});

test('preview:true 且**显式** dryRun:false ⇒ 仍必须被覆盖成 true（"我只关了一半通道"的真坑）', () => {
  const out = normalizeApplyInput(mk({ preview: true, dryRun: false }));
  assert.equal(out.dryRun, true, '显式 false 不得豁免：preview 是更强的意图');
});

test('preview:true 且已 dryRun:true ⇒ 返回同一引用（不制造多余对象）', () => {
  const input = mk({ preview: true, dryRun: true });
  assert.equal(normalizeApplyInput(input), input);
});

test('🔴 preview 缺省 ⇒ 原样返回，绝不擅自降级成 dry-run（真投路径不得被误伤）', () => {
  const input = mk({ realSend: true });
  const out = normalizeApplyInput(input);
  assert.equal(out, input, '连引用都不该换 —— 有任何复制都说明这条路径被动过了');
  assert.equal(out.dryRun, undefined, '没要求预览就不许凭空写 dryRun');
});

test('🔴 preview:false 且 dryRun:false ⇒ 原样返回（批量真实投递走的就是这一支）', () => {
  const input = mk({ preview: false, dryRun: false, realSend: true });
  assert.equal(normalizeApplyInput(input), input);
});

test('不修改入参（纯函数：原对象的 dryRun 保持缺省）', () => {
  const input = mk({ preview: true });
  normalizeApplyInput(input);
  assert.equal(input.dryRun, undefined, '入参被就地改写了 —— 纯函数约定被破坏');
});

test('其余字段原样透传（归一不是"重造一个 input"，别把 profile/job 丢了）', () => {
  const input = mk({ preview: true, jobUrl: 'https://x/y', channel: 'email', force: true });
  const out = normalizeApplyInput(input);
  assert.equal(out.jobUrl, 'https://x/y');
  assert.equal(out.channel, 'email');
  assert.equal(out.force, true);
  assert.equal(out.profile, input.profile, 'profile 引用应原样带过去');
  assert.equal(out.platform, 'job51');
});
