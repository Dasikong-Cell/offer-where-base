/**
 * `browserHealth.cdpLaunchHint` 的单测 —— 「真 Chrome 该怎么拉起来」的提示文案。
 *
 * 为什么这条文案值得单独一个单测文件（而不只是合约测试里的一条字符串断言）：
 *   它的**唯一**用途就是让用户照抄，而它历史上照抄的是错的 —— 写死
 *   `--remote-debugging-port=9222 --user-data-dir=C:\chrome-cdp-profile`，可 9222 并不在托管
 *   端口表里，而 `C:/chrome-cdp-profile` 实际对应的端口是 9223 ⇒ 照抄启动出来的是**非托管端点**：
 *   `ensureHealthy()` 对它只探活、不拉起，控制台点「打开窗口」于是**静默**无反应
 *   （请求发出、返回 ok:false，前端 `api(...).catch(()=>{})` 把错误吞掉）。
 *   「端口与 profile 是不是成对」这件事字符串断言钉不住，只能靠这里注入假表钉。
 *
 * 依赖：只 import browserHealth（其自身依赖 http/ws/spawn/localEnv），模块顶层无副作用，
 * 不会顺带拉起 CDP 客户端或 Chromium。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cdpLaunchHint, FALLBACK_PORT_PROFILES } from '../../server/services/browserHealth.js';

/** 注入用假表：profile 与端口一一对应，任何"串用"都会立刻暴露 */
const T: Record<string, string> = {
  '9223': 'C:/chrome-cdp-profile',
  '9227': 'C:/chrome-cdp-profile-official',
};

test('端口在托管表里 ⇒ 端口与 profile 必须**成对**出现在同一条命令里（串用＝用户照抄出错的窗口）', () => {
  const s = cdpLaunchHint('http://127.0.0.1:9227', T);
  // 一条正则同时钉住「端口」「紧邻的 profile」「命令确实以它收尾」——分开断言会放过串用
  assert.match(s, /--remote-debugging-port=9227 --user-data-dir=C:\/chrome-cdp-profile-official 启动（/);
  assert.ok(!s.includes('9223'), '9227 的提示里出现了 9223 —— 端口与 profile 串用了');
});

test('🔴 任何端口都不得凭空给出写死的 9222（这正是被修掉的那个错）', () => {
  for (const ep of ['http://127.0.0.1:9227', 'http://127.0.0.1:9223', 'http://127.0.0.1:9238']) {
    assert.ok(!/\b9222\b/.test(cdpLaunchHint(ep, T)), `${ep} 的提示里冒出了 9222`);
  }
});

test('🔴 非托管端口（9222 本身）⇒ 明说"不在托管表、不会自动拉起"，且**不给**可照抄的命令', () => {
  const s = cdpLaunchHint('http://127.0.0.1:9222', {});
  assert.match(s, /「9222」/);
  assert.match(s, /不在托管端口表/);
  assert.ok(!s.includes('--remote-debugging-port'),
    '给不出成对 profile 时就不该给命令 —— 给一条看着能用的错命令，比不给更糟');
});

test('端点无法解析出端口 ⇒ 不崩、如实说"无法解析"，也不猜一个端口', () => {
  const s = cdpLaunchHint('not-a-url', {});
  assert.match(s, /无法从端点解析出端口/);
  assert.ok(!/\b9222\b/.test(s));
});

test('真实兜底表：9222 不在其中，9223 成对给出 boss 的 profile', () => {
  assert.equal(FALLBACK_PORT_PROFILES['9222'], undefined,
    '9222 一旦进了兜底表，「非托管端口」这条分支就永不触发，写死端口的错法会重新变得"合法"');
  const s = cdpLaunchHint('http://127.0.0.1:9223', FALLBACK_PORT_PROFILES);
  assert.match(s, /--user-data-dir=C:\/chrome-cdp-profile 启动（/);
});

test('两条分支都要点明真正的出路（start_all.bat / start_platforms.bat），而不是让人手拼命令', () => {
  for (const ep of ['http://127.0.0.1:9227', 'http://127.0.0.1:9222']) {
    assert.match(cdpLaunchHint(ep, T), /start_all\.bat \/ start_platforms\.bat/);
  }
});
