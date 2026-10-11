#!/usr/bin/env node
/**
 * 评测适配器示例（pi CLI）。
 *
 * 用途：把 `scripts/evaluate.mjs` 从 stdin 收到的提示转交给 pi，并把模型的最终文本
 * 写回 stdout。这不是技能运行资源，只是复现评测方法的示例；换成其他 CLI 时，需要
 * 重新实现同一契约（stdin 收完整提示，stdout 只输出模型响应）。
 *
 * 用法：node evals/adapter-pi-example.mjs <provider/model>
 *
 * 两个易错点（详见 references/evaluation.md）：
 *  1. 必须关闭宿主的自动加载（`--no-context-files` 等）。否则本机全局指令会进入系统
 *     提示，与技能契约竞争，使结果依赖本机配置、其他调用方无法复现。
 *  2. 非交互模式下 pi 只发 `message_start` 与 `message_end`，没有 `message_update`
 *     文本增量；只等增量会得到空响应。文本在 `message_end` 的 `message.content` 数组里。
 */
import { spawn } from 'node:child_process';
import { LIMITS } from '../scripts/evaluate.mjs';

const model = process.argv[2];
if (!model) {
  process.stderr.write('用法：node evals/adapter-pi-example.mjs <provider/model>\n');
  process.exit(2);
}

const chunks = [];
let promptBytes = 0;
for await (const chunk of process.stdin) {
  promptBytes += chunk.length;
  if (promptBytes > LIMITS.promptBytes) {
    chunks.length = 0;
    process.stdin.destroy();
    process.stderr.write(`提示超过 ${LIMITS.promptBytes} 字节内部额度。\n`);
    process.exit(2);
  }
  chunks.push(chunk);
}
const prompt = Buffer.concat(chunks).toString('utf8');
chunks.length = 0;

const child = spawn('pi', [
  '--print', '--mode', 'json',
  '--no-extensions', '--no-tools', '--no-mcp',
  '--no-context-files', '--no-prompt-templates',
  '--no-skills', '--no-session', '--offline',
  '--model', model,
  '--system-prompt',
  '按照用户消息处理请求。',
], { stdio: ['pipe', 'pipe', 'pipe'] });

let buffer = '';
let text = '';
let failure = '';
let finished = false;
let cleanupTimer;
let stdoutBytes = 0;
let stderrBytes = 0;
let diagnosticBytes = 0;
const diagnosticLimit = 4096;
const stderr = [];
const decoder = new TextDecoder('utf-8', { fatal: true });

function fail(message) {
  if (!failure) failure = message;
  if (finished) return;
  buffer = '';
  text = '';
  stderr.length = 0;
  child.kill('SIGKILL');
  child.stdin.destroy();
  child.stdout.destroy();
  child.stderr.destroy();
  cleanupTimer ??= setTimeout(() => finish(1), LIMITS.cleanupMs);
}

function parseLine(line) {
  if (!line.trim() || failure) return;
  let event;
  try { event = JSON.parse(line); }
  catch { fail('JSONL 协议错误：事件不是有效 JSON。'); return; }
  if (!event || typeof event !== 'object' || Array.isArray(event)
      || typeof event.type !== 'string' || !event.type) {
    fail('JSONL 协议错误：事件缺少有效类型。');
    return;
  }
  if (event.type !== 'message_end') return;
  if (!event.message || typeof event.message.role !== 'string') {
    fail('JSONL 协议错误：最终事件缺少有效消息。');
    return;
  }
  if (event.message.role !== 'assistant') return;
  if (event.message.errorMessage) {
    fail(`模型错误：${event.message.errorMessage}`);
    return;
  }
  if (['length', 'error', 'aborted'].includes(event.message.stopReason)) {
    fail(event.message.stopReason === 'length' ? '模型响应被截断：达到输出长度限制。'
      : `模型异常结束：${event.message.stopReason}。`);
    return;
  }
  const parts = event.message.content;
  if (!Array.isArray(parts) || parts.some(part => !part || typeof part.type !== 'string'
      || (part.type === 'text' && (typeof part.text !== 'string' || !part.text.isWellFormed())))) {
    fail('JSONL 协议错误：最终消息内容格式损坏。');
    return;
  }
  text = parts.filter(part => part.type === 'text').map(part => part.text).join('');
  if (!text.trim()) fail('JSONL 协议错误：最终消息没有非空文本。');
}

child.stdout.on('data', chunk => {
  if (failure) return;
  stdoutBytes += chunk.length;
  if (stdoutBytes > LIMITS.streamBytes) {
    fail(`pi 标准输出超过 ${LIMITS.streamBytes} 字节内部额度。`);
    return;
  }
  try { buffer += decoder.decode(chunk, { stream: true }); }
  catch { fail('JSONL 协议错误：输出不是有效 UTF-8。'); return; }
  const lines = buffer.split('\n');
  buffer = lines.pop() ?? '';
  for (const line of lines) parseLine(line);
});

child.stderr.on('data', chunk => {
  if (failure) return;
  stderrBytes += chunk.length;
  if (stderrBytes > LIMITS.streamBytes) {
    fail(`pi 标准错误超过 ${LIMITS.streamBytes} 字节内部额度。`);
    return;
  }
  const count = Math.min(chunk.length, diagnosticLimit - diagnosticBytes);
  if (count > 0) {
    stderr.push(Buffer.from(chunk.subarray(0, count)));
    diagnosticBytes += count;
  }
});
child.stdout.on('error', error => { fail(`无法读取 pi 标准输出：${error.code ?? '未知错误'}。`); });
child.stderr.on('error', error => { fail(`无法读取 pi 标准错误：${error.code ?? '未知错误'}。`); });
child.on('error', error => { fail(`无法启动 pi：${error.code ?? '未知错误'}。`); });
function finish(code, signal) {
  if (finished) return;
  finished = true;
  clearTimeout(cleanupTimer);
  if (!failure) {
    try { buffer += decoder.decode(); }
    catch { fail('JSONL 协议错误：输出不是有效 UTF-8。'); }
    parseLine(buffer);
  }
  if (!failure && signal) failure = `pi 被信号 ${signal} 终止。`;
  if (!failure && code !== 0) {
    failure = `pi 退出码 ${code ?? '未知'}。`;
    const diagnostic = Buffer.concat(stderr).toString('utf8');
    if (diagnostic) failure += `\n${diagnostic}`;
  }
  if (!failure && !text.trim()) failure = 'JSONL 协议错误：未收到非空最终响应。';
  if (failure) {
    const diagnostic = new TextDecoder().decode(Buffer.from(failure).subarray(0, diagnosticLimit), { stream: true });
    process.stderr.write(`${diagnostic}\n`);
    process.exitCode = code > 0 ? code : 1;
    return;
  }
  process.stdout.write(text);
}
child.on('close', finish);
child.stdin.on('error', error => { fail(`无法完整传递提示至 pi 标准输入：${error.code ?? '未知错误'}。`); });
child.stdin.end(prompt);
