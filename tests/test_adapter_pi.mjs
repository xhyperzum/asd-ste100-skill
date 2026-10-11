import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { LIMITS } from '../scripts/evaluate.mjs';

const SCRIPT = fileURLToPath(new URL('../evals/adapter-pi-example.mjs', import.meta.url));
const PROMPT = '完整技能\n原文：关闭阀门。\n保留全部提示\n';
const MODEL = '测试提供方/测试模型';
const finalEvent = text => ({ type: 'message_end', message: {
  role: 'assistant', content: [{ type: 'text', text }],
} });
const emit = event => `process.stdout.write(${JSON.stringify(`${JSON.stringify(event)}\n`)});`;

function runFake(source, args = [MODEL], prompt = PROMPT) {
  const directory = mkdtempSync(join(tmpdir(), 'ste-pi-'));
  try {
    if (source !== null) writeFileSync(join(directory, 'pi'), `#!${process.execPath}\n${source}\n`, { mode: 0o755 });
    const result = spawnSync(process.execPath, [SCRIPT, ...args], {
      input: prompt, encoding: 'utf8', timeout: 5000,
      env: { ...process.env, PATH: directory },
    });
    assert.equal(result.error, undefined, '适配器必须正常结束，不能超时');
    assert.equal(result.signal, null, '适配器必须自行报告子进程失败');
    return result;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test('有效事件只输出最后的助手文本，不混入日志和思考', () => {
  const result = runFake([
    emit({ type: 'message_start' }),
    emit({ type: 'message_end', message: { role: 'user', content: [] } }),
    emit(finalEvent('中间响应')),
    emit({ type: 'message_end', message: { role: 'assistant', content: [
      { type: 'thinking', thinking: '不应输出思考' },
      { type: 'text', text: '关闭' }, { type: 'text', text: '阀门。' },
    ] } }),
    "process.stderr.write('不应输出日志');",
  ].join('\n'));
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '关闭阀门。');
  assert.equal(result.stderr, '');
});

test('实际 argv 锁住隔离参数、模型和中性系统契约，完整提示仅通过 stdin 传递', () => {
  const result = runFake(`const prompt = require('node:fs').readFileSync(0, 'utf8');
  process.stdout.write(JSON.stringify({ type: 'message_end', message: {
    role: 'assistant', content: [{ type: 'text', text: JSON.stringify({ args: process.argv.slice(2), prompt }) }]
  } }) + '\\n');`);
  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
  const captured = JSON.parse(result.stdout);
  assert.equal(captured.prompt, PROMPT);
  assert.deepEqual(captured.args, [
    '--print', '--mode', 'json',
    '--no-extensions', '--no-tools', '--no-mcp',
    '--no-context-files', '--no-prompt-templates',
    '--no-skills', '--no-session', '--offline',
    '--model', MODEL, '--system-prompt',
    '按照用户消息处理请求。',
  ]);
  assert.doesNotMatch(captured.args[captured.args.indexOf('--system-prompt') + 1], /原文|数据|澄清|改写|only|rewritten/iu);
});

test('超过十五万字符的完整提示通过 stdin 传递，不触发 E2BIG', () => {
  const prompt = PROMPT + '原'.repeat(150001);
  const result = runFake(`const prompt = require('node:fs').readFileSync(0, 'utf8');
    process.stdout.write(JSON.stringify({ type: 'message_end', message: {
      role: 'assistant', content: [{ type: 'text', text: prompt }]
    } }) + '\\n');`, [MODEL], prompt);
  assert.equal(result.status, 0);
  assert.equal(result.stdout, prompt);
  assert.equal(result.stderr, '');
});

test('stdin 提前关闭时报告 EPIPE，不能输出已收到的最终响应', () => {
  const result = runFake(`require('node:fs').closeSync(0);
    ${emit(finalEvent('不能输出'))}
    setTimeout(() => {}, 200);`, [MODEL], '原'.repeat(300000));
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /无法完整传递提示至 pi 标准输入：EPIPE。/u);
  assert.doesNotMatch(result.stderr, /\n\s+at |Unhandled 'error'/u);
});

test('单独运行的真实 stdin 按 8 MiB 字节边界收完整提示，超过一个字节不启动 pi', () => {
  for (const extra of [0, 1]) {
    const size = LIMITS.promptBytes + extra;
    const prompt = '原'.repeat(Math.floor(size / 3)) + 'x'.repeat(size % 3);
    const result = runFake(`process.stderr.write('已启动 pi');
      const prompt = require('node:fs').readFileSync(0);
      process.stdout.write(JSON.stringify({ type: 'message_end', message: {
        role: 'assistant', content: [{ type: 'text', text: String(prompt.length) }]
      } }) + '\\n');`, [MODEL], prompt);
    assert.equal(result.status, extra === 0 ? 0 : 2);
    if (extra === 0) {
      assert.equal(result.stdout, String(LIMITS.promptBytes));
      assert.equal(result.stderr, '');
    } else {
      assert.equal(result.stdout, '');
      assert.match(result.stderr, /提示超过 8388608 字节内部额度。/u);
      assert.doesNotMatch(result.stderr, /已启动 pi/u);
    }
  }
});

test('跨数据块的 UTF-8 多字节字符不损坏', () => {
  const event = `${JSON.stringify(finalEvent('关闭阀门。😀'))}\n`;
  const result = runFake(`const bytes = Buffer.from(${JSON.stringify(event)});
    const boundary = bytes.indexOf(Buffer.from('关')) + 1;
    process.stdout.write(bytes.subarray(0, boundary));
    setTimeout(() => process.stdout.write(bytes.subarray(boundary)), 40);`);
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '关闭阀门。😀');
  assert.equal(result.stderr, '');
});

test('最后事件没有 LF 仍读取完整 JSON', () => {
  const result = runFake(`process.stdout.write(${JSON.stringify(JSON.stringify(finalEvent('最终响应')))});`);
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '最终响应');
  assert.equal(result.stderr, '');
});

test('真实 32 MiB 日志超限失败，强制终止忽略 SIGTERM 的 pi 且不泄漏旧响应', () => {
  const result = runFake(`${emit(finalEvent('不能输出'))}
    process.on('SIGTERM', () => {});
    process.stderr.write(Buffer.alloc(32 * 1024 * 1024, 0x78));
    setInterval(() => {}, 1000);`);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /pi 标准错误超过 1048576 字节内部额度。/u);
  assert.ok(Buffer.byteLength(result.stderr) < 4096);
});

test('真实 stderr 字节边界允许额度内日志，超过一个字节也失败', () => {
  for (const extra of [0, 1]) {
    const result = runFake(`process.stderr.write(Buffer.alloc(${LIMITS.streamBytes + extra}, 0x78));
      ${emit(finalEvent('完整响应'))}`);
    assert.equal(result.status, extra === 0 ? 0 : 1);
    assert.equal(result.stdout, extra === 0 ? '完整响应' : '');
    if (extra === 0) assert.equal(result.stderr, '');
    else assert.match(result.stderr, /标准错误超过/u);
  }
});

test('真实无 LF 最终事件按 UTF-8 字节计额度，边界正常事件仍成功', () => {
  const overhead = Buffer.byteLength(JSON.stringify(finalEvent('')));
  for (const extra of [0, 1]) {
    const contentBytes = LIMITS.streamBytes - overhead + extra;
    const result = runFake(`const text = '😀'.repeat(${Math.floor(contentBytes / 4)})
      + 'x'.repeat(${contentBytes % 4});
      process.stdout.write(JSON.stringify({ type: 'message_end', message: {
        role: 'assistant', content: [{ type: 'text', text }]
      } }));`);
    assert.equal(result.status, extra === 0 ? 0 : 1);
    if (extra === 0) {
      assert.equal(Buffer.byteLength(result.stdout), contentBytes);
      assert.equal(result.stdout, '😀'.repeat(Math.floor(contentBytes / 4)) + 'x'.repeat(contentBytes % 4));
      assert.equal(result.stderr, '');
    } else {
      assert.equal(result.stdout, '');
      assert.match(result.stderr, /标准输出超过/u);
    }
  }
});

test('超长未换行事件不能输出先前响应或等待 pi 自行结束', () => {
  const result = runFake(`${emit(finalEvent('不能输出'))}
    process.on('SIGTERM', () => {});
    process.stdout.write('{"type":"');
    process.stdout.write(Buffer.alloc(32 * 1024 * 1024, 0x78));
    setInterval(() => {}, 1000);`);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /标准输出超过/u);
});

test('decoder 暂存的不完整字符仍占字节额度，超限优先失败闭合', () => {
  const result = runFake(`process.stdout.write(Buffer.alloc(${LIMITS.streamBytes - 1}, 0x20));
    process.stdout.write(Buffer.from([0xe5]));
    setTimeout(() => process.stdout.write(Buffer.from([0x85])), 40);`);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /标准输出超过/u);
  assert.doesNotMatch(result.stderr, /不是有效 UTF-8/u);
});

test('短 JSONL 事件累计超限也失败，不靠未换行缓冲触发', () => {
  const result = runFake(`${emit(finalEvent('不能输出'))}
    const event = JSON.stringify({ type: 'message_start' }) + '\\n';
    process.stdout.write(event.repeat(Math.ceil(${LIMITS.streamBytes} / Buffer.byteLength(event))));`);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /标准输出超过/u);
});

test('额度内非零退出只保留有限诊断前缀，不混入 stdout', () => {
  const result = runFake(`${emit(finalEvent('不能输出'))}
    process.stderr.write('错误前缀' + '原'.repeat(100000));
    process.exitCode = 7;`);
  assert.equal(result.status, 7);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /^pi 退出码 7。\n错误前缀/u);
  assert.ok(Buffer.byteLength(result.stderr) <= 4097);
  assert.doesNotMatch(result.stderr, /\ufffd/u);
});

const failures = [
  ['找不到 pi 时用中文报告 ENOENT', null, /无法启动 pi：ENOENT/u],
  ['坏 JSON 不静默吞掉', "process.stdout.write('不是 JSON\\n');", /JSONL 协议错误/u],
  ['无 LF 的坏 JSON 也失败', "process.stdout.write('{');", /JSONL 协议错误/u],
  ['合法 JSON 但事件类型缺失也失败', emit({}), /事件缺少有效类型/u],
  ['缺少最终消息也失败', emit({ type: 'message_end' }), /最终事件缺少有效消息/u],
  ['完全没有输出也失败', '', /未收到非空最终响应/u],
  ['只有开始事件也失败', emit({ type: 'message_start' }), /未收到非空最终响应/u],
  ['空最终内容也失败', emit({ type: 'message_end', message: { role: 'assistant', content: [] } }), /没有非空文本/u],
  ['空白最终文本也失败', emit(finalEvent(' \n\t')), /没有非空文本/u],
  ['损坏最终内容也失败', emit({ type: 'message_end', message: { role: 'assistant', content: '损坏' } }), /内容格式损坏/u],
  ['非字符串文本也失败', emit(finalEvent(42)), /内容格式损坏/u],
  ['JSON 转义的孤立高代理项不能成功', emit(finalEvent('前\ud800后')), /内容格式损坏/u],
  ['JSON 转义的孤立低代理项不能成功', emit(finalEvent('前\udc00后')), /内容格式损坏/u],
  ['有效响应后的空最终事件不能复用旧文本', emit(finalEvent('旧响应')) + emit(finalEvent('')), /没有非空文本/u],
  ['有效响应后的坏 JSON 不能成功', emit(finalEvent('旧响应')) + "process.stdout.write('坏事件\\n');", /JSONL 协议错误/u],
  ['模型错误不能成功', emit({ type: 'message_end', message: {
    role: 'assistant', content: [], errorMessage: '模型鉴权失败',
  } }), /模型错误：模型鉴权失败/u],
  ['长度截断不能输出非空正文或复用旧响应', emit(finalEvent('旧响应')) + emit({ type: 'message_end', message: {
    role: 'assistant', content: [{ type: 'text', text: '截断正文' }], stopReason: 'length',
  } }), /模型响应被截断：达到输出长度限制。/u],
  ['异常停止没有错误信息也不能成功', emit({ type: 'message_end', message: {
    role: 'assistant', content: [{ type: 'text', text: '不完整正文' }], stopReason: 'error',
  } }), /模型异常结束：error。/u],
  ['主动中止不能输出非空正文', emit({ type: 'message_end', message: {
    role: 'assistant', content: [{ type: 'text', text: '中止正文' }], stopReason: 'aborted',
  } }), /模型异常结束：aborted。/u],
  ['非零退出不能输出已有响应', emit(finalEvent('不能输出')) + "process.stderr.write('子进程错误');process.exitCode = 7;", /pi 退出码 7。\n子进程错误/u],
  ['信号终止不能输出已有响应', emit(finalEvent('不能输出')) + "process.kill(process.pid, 'SIGTERM');", /pi 被信号 SIGTERM 终止/u],
  ['无效 UTF-8 不能成功', 'process.stdout.write(Buffer.from([0xff]));', /不是有效 UTF-8/u],
  ['末尾截断的 UTF-8 不能成功', 'process.stdout.write(Buffer.from([0xe5]));', /不是有效 UTF-8/u],
];

for (const [name, source, diagnostic] of failures) {
  test(name, () => {
    const result = runFake(source);
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, diagnostic);
    assert.doesNotMatch(result.stderr, /\n\s+at |Unhandled 'error'/u);
    if (name.startsWith('非零退出')) assert.equal(result.status, 7);
  });
}

test('正常或未知停止原因保持兼容', () => {
  for (const stopReason of ['stop', '未来停止原因']) {
    const event = finalEvent('完整响应');
    event.message.stopReason = stopReason;
    const result = runFake(emit(event));
    assert.equal(result.status, 0);
    assert.equal(result.stdout, '完整响应');
    assert.equal(result.stderr, '');
  }
});

test('缺少模型参数时报告中文用法', () => {
  const result = runFake(null, []);
  assert.equal(result.status, 2);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /用法：/u);
});
