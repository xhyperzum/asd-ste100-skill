#!/usr/bin/env node
/** 记录命令适配器或导入的实际响应；自动约束不构成语义审批。 */
import { createHash } from 'node:crypto';
import { openSync, readSync, closeSync, fstatSync, ftruncateSync, lstatSync, constants as fsConstants, realpathSync, statSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { constants } from 'node:os';
import { performance } from 'node:perf_hooks';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const ROOT = resolve(dirname(SCRIPT_PATH), '..');
const INVARIANT_KEYS = new Set(['contains', 'forbidden', 'any_contains', 'equals_input', 'not_equals', 'requires_list']);
const CASE_KEYS = new Set(['id', 'description', 'text_type', 'request', 'source', 'human_review', 'invariants', 'prompt_variant']);
const RESPONSE_KEYS = new Set(['case_id', 'response', 'source', 'stderr']);
export const LIMITS = Object.freeze({ inputBytes: 4 * 1024 * 1024, jsonDepth: 16, cases: 256,
  promptBytes: 8 * 1024 * 1024, batchPromptBytes: 32 * 1024 * 1024,
  streamBytes: 1024 * 1024, batchOutputBytes: 16 * 1024 * 1024, cleanupMs: 100 });
// 与既有评测记录一致：空白集合不包含 BOM，包含 Python 的控制空白。
const SPACE = '[\\t\\n\\v\\f\\r\\u001c-\\u0020\\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]';
const TRIM_START = new RegExp(`^${SPACE}+`, 'u');
const TRIM_END = new RegExp(`${SPACE}+$`, 'u');
const trim = text => text.replace(TRIM_START, '').replace(TRIM_END, '');
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const utcNow = () => new Date().toISOString().replace(/(\.\d{3})Z$/u, '$1000+00:00');

export class EvaluationError extends Error {}

export function sha256(text) {
  if (!text.isWellFormed()) throw new EvaluationError('文本包含无效 Unicode 字符，无法计算 UTF-8 摘要。');
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function compareCodepoints(left, right) {
  const first = [...left];
  const second = [...right];
  for (let index = 0; index < Math.min(first.length, second.length); index += 1) {
    const difference = first[index].codePointAt(0) - second[index].codePointAt(0);
    if (difference) return difference;
  }
  return first.length - second.length;
}

/** 直接序列化排序后的键，不能依赖对象重排后 JSON.stringify 的整数键排序。 */
export function canonicalJson(value, depth = 0) {
  if (depth > LIMITS.jsonDepth) throw new EvaluationError(`规范 JSON 嵌套不能超过 ${LIMITS.jsonDepth} 层。`);
  if (value === null) return 'null';
  if (typeof value === 'string') {
    if (!value.isWellFormed()) throw new EvaluationError('JSON 字符串包含无效 Unicode 字符。');
    return JSON.stringify(value);
  }
  if (typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') throw new EvaluationError('规范 JSON 不支持数值；案例数值必须保存在原文字符串中。');
  if (Array.isArray(value)) return `[${Array.from(value, item => canonicalJson(item, depth + 1)).join(',')}]`;
  if (isObject(value)) {
    return `{${Object.keys(value).sort(compareCodepoints).map(key => `${canonicalJson(key, depth + 1)}:${canonicalJson(value[key], depth + 1)}`).join(',')}}`;
  }
  throw new EvaluationError('规范 JSON 不支持该值类型。');
}

function readUtf8(path) {
  let descriptor;
  try {
    // 非阻塞打开避免 FIFO 等特殊文件使读取永久等待；打开后再检查文件类型和大小。
    descriptor = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK);
    const info = fstatSync(descriptor);
    if (!info.isFile()) throw new EvaluationError('输入必须是普通文件。');
    if (info.size > LIMITS.inputBytes) throw new EvaluationError(`输入文件不能超过 ${LIMITS.inputBytes} 字节。`);
    const bytes = Buffer.allocUnsafe(LIMITS.inputBytes + 1);
    let size = 0;
    let count;
    while (size < bytes.length && (count = readSync(descriptor, bytes, size, bytes.length - size, null)) !== 0) size += count;
    if (size > LIMITS.inputBytes) throw new EvaluationError(`输入文件不能超过 ${LIMITS.inputBytes} 字节。`);
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, size)).replace(/\r\n|\r/gu, '\n');
  } catch (error) {
    if (error instanceof EvaluationError) throw error;
    throw new EvaluationError(`无法读取 UTF-8 输入文件：${path}。`);
  } finally { if (descriptor !== undefined) closeSync(descriptor); }
}

function readJson(path) {
  const text = readUtf8(path);
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (const character of text) {
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') quoted = false;
    } else if (character === '"') quoted = true;
    else if (character === '[' || character === '{') {
      if (++depth > LIMITS.jsonDepth) throw new EvaluationError(`JSON 嵌套不能超过 ${LIMITS.jsonDepth} 层。`);
    } else if (character === ']' || character === '}') depth -= 1;
  }
  let result;
  try { result = JSON.parse(text); }
  catch { throw new EvaluationError(`JSON 格式无效：${path}。`); }
  const pending = [result];
  while (pending.length) {
    const value = pending.pop();
    if (typeof value === 'string' && !value.isWellFormed()) throw new EvaluationError('JSON 字符串包含无效 Unicode 字符。');
    if (Array.isArray(value)) { for (const item of value) pending.push(item); }
    else if (isObject(value)) { for (const [key, item] of Object.entries(value)) pending.push(key, item); }
  }
  return result;
}

function validText(value) { return typeof value === 'string' && value.isWellFormed()
  && Buffer.byteLength(value, 'utf8') <= LIMITS.inputBytes; }
function validString(value) { return validText(value) && Boolean(trim(value)); }

function validateInvariants(item) {
  const invariants = Object.hasOwn(item, 'invariants') ? item.invariants : {};
  if (!isObject(invariants) || Object.keys(invariants).some(key => !INVARIANT_KEYS.has(key))) {
    throw new EvaluationError(`案例 ${item.id} 的 invariants 字段无效。`);
  }
  for (const [key, value] of Object.entries(invariants)) {
    const valid = key === 'equals_input' || key === 'requires_list' ? typeof value === 'boolean'
      : Array.isArray(value) && value.length && value.every(part => validText(part) && part.length);
    if (!valid) throw new EvaluationError(`案例 ${item.id} 的约束 ${key} 无效。`);
  }
  return invariants;
}

function validateCase(item) {
  if (!isObject(item)) throw new EvaluationError('每个案例必须是 JSON 对象。');
  if (Object.keys(item).some(key => !CASE_KEYS.has(key))) throw new EvaluationError('案例包含不支持的字段；数值和技术内容必须保存在原文字符串中。');
  for (const key of ['id', 'description', 'request', 'source']) {
    if (!validString(item[key])) throw new EvaluationError(`案例字段 ${key} 必须是有效 Unicode 非空字符串。`);
  }
  if (!['instruction', 'description'].includes(item.text_type)) throw new EvaluationError(`案例 ${item.id} 的 text_type 无效。`);
  if (Object.hasOwn(item, 'prompt_variant') && item.prompt_variant !== 'unmarked-user-message') {
    throw new EvaluationError(`案例 ${item.id} 的 prompt_variant 无效。`);
  }
  if (!Array.isArray(item.human_review) || !item.human_review.length || !item.human_review.every(validString)) {
    throw new EvaluationError(`案例 ${item.id} 必须提供人工复核维度。`);
  }
  validateInvariants(item);
}

function validateCases(cases) {
  if (!Array.isArray(cases) || !cases.length || cases.length > LIMITS.cases) {
    throw new EvaluationError(`案例文件必须是非空 JSON 数组，案例数不能超过 ${LIMITS.cases}。`);
  }
  const ids = new Set();
  for (const item of cases) {
    validateCase(item);
    if (ids.has(item.id)) throw new EvaluationError(`重复案例 ID：${item.id}`);
    ids.add(item.id);
  }
  return ids;
}

export function loadCases(path, selected = []) {
  const cases = readJson(path);
  const ids = validateCases(cases);
  const unknown = [...new Set(selected)].filter(id => !ids.has(id));
  if (unknown.length) throw new EvaluationError(`未知案例 ID：${unknown.sort(compareCodepoints).join(', ')}`);
  return cases.filter(item => !selected.length || selected.includes(item.id));
}

export function makePrompt(skill, item) {
  validateCase(item);
  if (!validString(skill)) throw new EvaluationError('技能必须是有效 Unicode 非空字符串。');
  if (item.prompt_variant === 'unmarked-user-message') {
    return `以下为完整技能和用户消息。\n技能开始：\n${skill}\n技能结束。\n\n用户消息：\n${item.request}\n${item.source}\n`;
  }
  let boundary = `STE_SOURCE_${sha256(skill + canonicalJson(item))}`;
  while (item.source.includes(boundary)) boundary += '_DATA';
  return `以下为完整技能、用户请求和独立标示的待改写原文数据。\n技能开始：\n${skill}\n技能结束。\n\n用户请求：${item.request}\n本案例文本类型：${item.text_type}\n${boundary}_BEGIN\n${item.source}\n${boundary}_END\n`;
}

function listItemCount(response) {
  let fence = null;
  const lines = response.split(/\r\n|\r|\n/u).map(line => {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/u);
    if (fence) {
      if (marker && marker[1][0] === fence.character && marker[1].length >= fence.length && !trim(marker[2])) fence = null;
      return '';
    }
    if (marker) { fence = { character: marker[1][0], length: marker[1].length }; return ''; }
    return line;
  });
  const text = lines.join('\n');
  const runs = [...text.matchAll(/`+/gu)];
  const next = new Map();
  const partners = [];
  for (let index = runs.length - 1; index >= 0; index -= 1) {
    partners[index] = next.get(runs[index][0].length);
    next.set(runs[index][0].length, index);
  }
  const pieces = [];
  let start = 0;
  // 按同长度反引号配对，跨行代码里的列表标记不能算作正文列表。
  for (let index = 0; index < runs.length; index += 1) {
    const partner = partners[index];
    if (partner === undefined) continue;
    const end = runs[partner].index + runs[partner][0].length;
    pieces.push(text.slice(start, runs[index].index), text.slice(runs[index].index, end).replace(/[^\n]/gu, 'X'));
    start = end;
    index = partner;
  }
  pieces.push(text.slice(start));
  return pieces.join('').split('\n').filter(line => /^ {0,3}(?:[-+*]|[0-9]{1,9}[.)])[\t ]+\S/u.test(line)).length;
}

export function checkInvariants(item, response) {
  const stripped = trim(response);
  const checks = [{ name: 'response-nonempty', passed: Boolean(stripped) }];
  const invariants = validateInvariants(item);
  for (const [key, value] of Object.entries(invariants)) {
    if (key === 'equals_input') {
      if (value) checks.push({ name: key, passed: stripped === trim(item.source) });
    } else if (key === 'requires_list') {
      if (value) {
        const count = listItemCount(response);
        checks.push({ name: key, minimum_items: 3, observed_items: count, passed: count >= 3 });
      }
    } else if (key === 'any_contains') {
      checks.push({ name: key, expected: value, passed: value.some(part => response.includes(part)) });
    } else for (const part of value) {
      const passed = key === 'contains' ? response.includes(part)
        : key === 'forbidden' ? !response.includes(part) : stripped !== part;
      checks.push({ name: key, expected: part, passed });
    }
  }
  return checks;
}

export function capturedStreams(stdout, stderr) {
  const result = {};
  let invalid = false;
  for (const [name, value] of [['stdout', stdout ?? Buffer.alloc(0)], ['stderr', stderr ?? Buffer.alloc(0)]]) {
    try { result[name] = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(value); }
    catch {
      result[name] = new TextDecoder('utf-8', { ignoreBOM: true }).decode(value);
      result[`${name}_base64`] = value.toString('base64');
      invalid = true;
    }
  }
  result.output_encoding = invalid ? 'invalid-utf8-with-raw-base64' : 'utf-8';
  return [result, invalid];
}

function duration(start) {
  return Math.round((performance.now() - start)) / 1000;
}

function timeoutTimer(seconds, callback) {
  const deadline = performance.now() + seconds * 1000;
  let timer;
  const tick = () => {
    const remaining = deadline - performance.now();
    if (remaining <= 0) callback();
    else timer = setTimeout(tick, Math.min(remaining, 2 ** 31 - 1));
  };
  tick();
  return () => clearTimeout(timer);
}

export async function runCommand(command, prompt, timeoutSec, { outputBytes = 2 * LIMITS.streamBytes } = {}) {
  if (!Array.isArray(command) || !command.length || !command.every(value => typeof value === 'string' && value.isWellFormed())) {
    throw new EvaluationError('命令适配器必须提供有效 Unicode argv 字符串数组。');
  }
  if (typeof prompt !== 'string' || !prompt.isWellFormed() || Buffer.byteLength(prompt, 'utf8') > LIMITS.promptBytes) {
    throw new EvaluationError(`提示必须是有效 Unicode 字符串，且不能超过 ${LIMITS.promptBytes} 字节。`);
  }
  timeoutSec = positiveTimeout(timeoutSec);
  if (!Number.isSafeInteger(outputBytes) || outputBytes < 0 || outputBytes > 2 * LIMITS.streamBytes) {
    throw new EvaluationError('输出保留额度必须是规定范围内的非负整数。');
  }
  const started = utcNow();
  const clock = performance.now();
  return new Promise(resolveResult => {
    const streams = { stdout: { chunks: [], bytes: 0 }, stderr: { chunks: [], bytes: 0 } };
    let totalBytes = 0;
    let finished = false;
    let failure = null;
    let spawnError = null;
    let child;
    let stopTimer = () => {};
    let cleanupTimer;
    let incomplete = false;
    let limited = false;
    const details = [];
    const finish = (returncode) => {
      if (finished) return;
      finished = true;
      stopTimer();
      clearTimeout(cleanupTimer);
      const stdout = Buffer.concat(streams.stdout.chunks, streams.stdout.bytes);
      const stderr = Buffer.concat(streams.stderr.chunks, streams.stderr.bytes);
      const [captured, invalid] = capturedStreams(stdout, stderr);
      if (spawnError && !captured.stderr) captured.stderr = spawnError.message;
      const operationError = failure ?? (returncode !== 0 ? '命令适配器返回非零退出码。'
        : invalid ? '命令适配器返回了无效 UTF-8 输出；原始字节已保存为 base64。' : null);
      if (incomplete || limited) {
        captured.output_complete = false;
        captured.stdout_base64 = stdout.toString('base64');
        captured.stderr_base64 = stderr.toString('base64');
      }
      if (limited) {
        captured.output_truncated = true;
        captured.capture_limits = { stream_bytes: LIMITS.streamBytes, total_bytes: outputBytes };
        captured.stdout_bytes_retained = streams.stdout.bytes;
        captured.stderr_bytes_retained = streams.stderr.bytes;
      }
      if (details.length) captured.operation_details = details;
      resolveResult({ ...captured, returncode, operation_error: operationError,
        started_at: started, finished_at: utcNow(), duration_seconds: duration(clock) });
    };
    const abort = (message, kind, error = null) => {
      if (finished) return;
      if (failure !== null) return;
      details.push({ kind, ...(error?.code ? { code: error.code } : {}) });
      failure = message;
      incomplete = true;
      stopTimer();
      // 只终止直属适配器；有限收尾后关闭本地管道，不能等待子孙进程释放句柄。
      if (child) {
        child.kill('SIGKILL');
        child.stdin.destroy();
      }
      cleanupTimer = setTimeout(() => {
        incomplete = true;
        child?.stdout.destroy();
        child?.stderr.destroy();
        finish(null);
      }, LIMITS.cleanupMs);
    };
    const collect = (name, chunk) => {
      if (finished) return;
      const stream = streams[name];
      const available = Math.min(LIMITS.streamBytes - stream.bytes, outputBytes - totalBytes);
      const count = Math.min(chunk.length, available);
      if (count > 0) {
        // 复制有效前缀，避免一个很大的底层 Buffer 超出实际保留额度。
        stream.chunks.push(Buffer.from(chunk.subarray(0, count)));
        stream.bytes += count;
        totalBytes += count;
      }
      if (count < chunk.length) {
        limited = true;
        abort('命令适配器输出超过保留额度；报告仅保存已捕获的原始字节前缀。', 'output-limit');
      }
    };
    try {
      child = spawn(command[0], command.slice(1), { shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (error) {
      spawnError = error;
      failure = '无法启动命令适配器。';
      finish(null);
      return;
    }
    child.stdout.on('data', chunk => collect('stdout', chunk));
    child.stderr.on('data', chunk => collect('stderr', chunk));
    child.stdout.on('error', error => abort('无法读取命令适配器标准输出。', 'stdout-error', error));
    child.stderr.on('error', error => abort('无法读取命令适配器标准错误。', 'stderr-error', error));
    child.on('error', error => {
      spawnError = error;
      abort('无法启动或控制命令适配器。', 'process-error', error);
    });
    child.stdin.on('error', error => abort('无法完整传递提示至命令适配器标准输入。', 'stdin-error', error));
    child.on('close', (code, signal) => {
      finish(failure !== null ? null : code ?? -(constants.signals[signal] ?? 1));
    });
    stopTimer = timeoutTimer(timeoutSec, () => abort(`命令适配器超过 ${timeoutSec} 秒超时限制。`, 'timeout'));
    child.stdin.end(Buffer.from(prompt, 'utf8'));
  });
}

export function loadResponses(path, cases) {
  const records = readJson(path);
  if (!Array.isArray(records)) throw new EvaluationError('导入文件必须是实际响应记录的 JSON 数组。');
  const responses = new Map();
  let outputBytes = 0;
  for (const record of records) {
    if (!isObject(record) || !validString(record.case_id)) throw new EvaluationError('每条响应记录必须提供有效 case_id。');
    if (Object.keys(record).some(key => !RESPONSE_KEYS.has(key))) throw new EvaluationError('响应记录包含不支持的字段。');
    if (responses.has(record.case_id)) throw new EvaluationError(`重复响应 ID：${record.case_id}`);
    if (typeof record.response !== 'string' || !record.response.isWellFormed() || !validString(record.source)) {
      throw new EvaluationError(`响应 ${record.case_id} 必须提供 response 字符串和实际来源 source。`);
    }
    if (record.stderr !== undefined && (typeof record.stderr !== 'string' || !record.stderr.isWellFormed())) throw new EvaluationError(`响应 ${record.case_id} 的 stderr 必须是有效 Unicode 字符串。`);
    const responseBytes = Buffer.byteLength(record.response, 'utf8');
    const stderrBytes = Buffer.byteLength(record.stderr ?? '', 'utf8');
    outputBytes += responseBytes + stderrBytes;
    // 输入契约适用于文件中的每条记录，未选中的记录也不能绕过额度。
    if (responseBytes > LIMITS.streamBytes || stderrBytes > LIMITS.streamBytes || outputBytes > LIMITS.batchOutputBytes) {
      throw new EvaluationError('导入响应超出单个标准流或整批输出保留额度。');
    }
    responses.set(record.case_id, record);
  }
  const missing = [...new Set(cases.map(item => item.id))].filter(id => !responses.has(id));
  if (missing.length) throw new EvaluationError(`缺少实际响应：${missing.sort(compareCodepoints).join(', ')}`);
  return responses;
}

export async function evaluate(cases, skill, model, { command = null, imported = null, timeout = 120 } = {}) {
  validateCases(cases);
  if (!validString(model)) throw new EvaluationError('模型标识必须是有效 Unicode 非空字符串。');
  const prompts = [];
  let promptBytes = 0;
  for (const item of cases) {
    const prompt = makePrompt(skill, item);
    const size = Buffer.byteLength(prompt, 'utf8');
    promptBytes += size;
    if (size > LIMITS.promptBytes || promptBytes > LIMITS.batchPromptBytes) {
      throw new EvaluationError(`单提示不能超过 ${LIMITS.promptBytes} 字节，整批提示不能超过 ${LIMITS.batchPromptBytes} 字节。`);
    }
    prompts.push(prompt);
  }
  const results = [];
  let outputBytes = 0;
  for (const [index, item] of cases.entries()) {
    const prompt = prompts[index];
    let execution;
    let provenance;
    if (command !== null) {
      execution = await runCommand(command, prompt, timeout, { outputBytes: Math.min(2 * LIMITS.streamBytes, LIMITS.batchOutputBytes - outputBytes) });
      for (const name of ['stdout', 'stderr']) outputBytes += execution[`${name}_bytes_retained`]
        ?? (execution[`${name}_base64`] === undefined ? Buffer.byteLength(execution[name], 'utf8')
          : Buffer.from(execution[`${name}_base64`], 'base64').length);
      provenance = { kind: 'command-adapter', argv: [...command] };
    } else {
      const record = imported?.get(item.id);
      if (!record) throw new EvaluationError(`缺少实际响应：${item.id}`);
      if (!isObject(record) || Object.keys(record).some(key => !RESPONSE_KEYS.has(key))
          || (record.case_id !== undefined && record.case_id !== item.id)
          || typeof record.response !== 'string' || !record.response.isWellFormed() || !validString(record.source)
          || (record.stderr !== undefined && (typeof record.stderr !== 'string' || !record.stderr.isWellFormed()))) {
        throw new EvaluationError(`响应 ${item.id} 必须提供有效 Unicode 字符串和来源。`);
      }
      const size = Buffer.byteLength(record.response, 'utf8') + Buffer.byteLength(record.stderr ?? '', 'utf8');
      if (Buffer.byteLength(record.response, 'utf8') > LIMITS.streamBytes || Buffer.byteLength(record.stderr ?? '', 'utf8') > LIMITS.streamBytes
          || outputBytes + size > LIMITS.batchOutputBytes) {
        throw new EvaluationError('导入响应超出单例或整批输出保留额度。');
      }
      outputBytes += size;
      execution = { stdout: record.response, stderr: record.stderr ?? '', returncode: null,
        operation_error: null, started_at: null, finished_at: null, duration_seconds: null };
      provenance = { kind: 'imported-response', source: record.source, model_invocation_performed: false };
    }
    const checks = checkInvariants(item, execution.stdout);
    results.push({ case_id: item.id, description: item.description, text_type: item.text_type, model,
      case_sha256: sha256(canonicalJson(item)), skill_sha256: sha256(skill), prompt_sha256: sha256(prompt), prompt,
      context_origin: command !== null ? 'submitted-to-adapter' : 'reconstructed-for-checking', provenance, ...execution,
      automatic_checks: checks, automatic_passed: execution.operation_error === null && checks.every(check => check.passed),
      human_review: { status: 'pending', dimensions: item.human_review } });
  }
  const operationErrors = results.filter(result => result.operation_error !== null).length;
  const failed = results.filter(result => !result.automatic_passed).length;
  const report = { schema_version: 1, recorded_at: utcNow(), model,
    evaluation_kind: command !== null ? 'command-adapter' : 'imported-responses', semantic_approval: 'pending-human-review',
    summary: { cases: results.length, automatic_failed: failed, operation_errors: operationErrors }, results };
  return [report, operationErrors ? 2 : failed ? 1 : 0];
}

export function positiveTimeout(value) {
  const source = String(value);
  const normalized = [...trim(source)].map(character => {
    if (!/\p{Nd}/u.test(character)) return character;
    const point = character.codePointAt(0);
    let first = point;
    while (/\p{Nd}/u.test(String.fromCodePoint(first - 1))) first -= 1;
    return String((point - first) % 10);
  }).join('');
  const digits = '[0-9](?:_?[0-9])*';
  const syntax = new RegExp(`^[+-]?(?:${digits}(?:\\.(?:${digits})?)?|\\.${digits})(?:e[+-]?${digits})?$`, 'iu');
  if (/[\u001c-\u001f]/u.test(source) || !syntax.test(normalized)) throw new EvaluationError('超时必须是有限正数。');
  const number = Number(normalized.replaceAll('_', ''));
  if (!Number.isFinite(number) || number <= 0) throw new EvaluationError('超时必须是有限正数。');
  return number;
}

const USAGE = '用法：evaluate.mjs [--cases FILE] [--skill FILE] [--case ID] --model MODEL --output FILE [--timeout SECONDS] (--import-responses FILE | --command COMMAND [ARG ...])';
const HELP = `${USAGE}\n\n记录实际模型响应并执行有限自动约束检查；语义仍需人工复核。\n\n选项\n  -h, --help              显示帮助并退出\n  --cases FILE            案例 JSON 文件\n  --skill FILE            完整技能文件\n  --case ID               只运行指定案例，可重复\n  --model MODEL           实际模型标识，由调用方提供\n  --output FILE           JSON 报告文件\n  --timeout SECONDS       每个案例的命令超时秒数，默认 120\n  --import-responses FILE 导入实际响应 JSON；不会调用模型\n  --command COMMAND ...   命令适配器 argv，必须位于所有评测参数之后\n`;

class UsageError extends EvaluationError {}

function parseArguments(argv) {
  const options = { cases: resolve(ROOT, 'evals/cases.json'), skill: resolve(ROOT, 'SKILL.md'),
    selected: [], model: null, output: null, timeout: 120, importedPath: null, command: null, help: false };
  const valueNames = new Map([['--cases', 'cases'], ['--skill', 'skill'], ['--case', 'selected'],
    ['--model', 'model'], ['--output', 'output'], ['--timeout', 'timeout'], ['--import-responses', 'importedPath']]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '-h' || argument === '--help') {
      options.help = true;
      return options;
    }
    const equal = argument.indexOf('=');
    const name = equal < 0 ? argument : argument.slice(0, equal);
    if (name === '--command') {
      options.command = equal < 0 ? argv.slice(index + 1) : [argument.slice(equal + 1), ...argv.slice(index + 1)];
      break;
    }
    if (!valueNames.has(name)) throw new UsageError(`未知参数：${argument}`);
    let value;
    if (equal >= 0) value = argument.slice(equal + 1);
    else {
      if (index + 1 >= argv.length || (argv[index + 1].startsWith('-') && !/^-[0-9.]+$/u.test(argv[index + 1]))) {
        throw new UsageError(`参数 ${name} 缺少参数值`);
      }
      value = argv[++index];
    }
    if (name === '--case') options.selected.push(value);
    else if (name === '--timeout') {
      try { options.timeout = positiveTimeout(value); }
      catch (error) { throw new UsageError(error.message); }
    } else options[valueNames.get(name)] = value;
  }
  if (options.model === null || options.output === null) throw new UsageError('缺少必填参数：--model、--output');
  if (options.command !== null && options.importedPath !== null) throw new UsageError('--command 和 --import-responses 不能同时使用');
  if (options.command === null && options.importedPath === null) throw new UsageError('以下参数之一为必填项：--command、--import-responses');
  return options;
}

function resolvedPath(path) {
  try { return realpathSync(path); }
  catch { return resolve(path); }
}

function protectInputs(output, inputs) {
  const target = resolvedPath(output);
  for (const input of inputs) {
    if (target === resolvedPath(input)) throw new EvaluationError('报告路径不能覆盖技能、案例或导入响应文件。');
    try {
      const outputStat = statSync(output, { bigint: true });
      const inputStat = statSync(input, { bigint: true });
      if (outputStat.dev === inputStat.dev && outputStat.ino === inputStat.ino) {
        throw new EvaluationError('报告路径不能覆盖技能、案例或导入响应文件。');
      }
    } catch (error) {
      if (error instanceof EvaluationError) throw error;
    }
  }
}

function checkOutputType(output) {
  try {
    const info = lstatSync(output);
    if (info.isSymbolicLink()) throw new EvaluationError('报告路径不能是符号链接。');
    if (!info.isFile()) throw new EvaluationError('报告目标必须是普通文件，不能是 FIFO、设备或目录。');
  } catch (error) {
    if (error instanceof EvaluationError) throw error;
    if (error.code !== 'ENOENT') throw new EvaluationError('无法检查报告目标文件。');
  }
}

function saveReport(output, report, inputs, inputStats) {
  let descriptor;
  try {
    protectInputs(output, inputs);
    checkOutputType(output);
    mkdirSync(dirname(resolve(output)), { recursive: true });
    // 先打开但不截断；非阻塞和禁止跟随末级符号链接，避免特殊文件等待及路径替换。
    descriptor = openSync(output, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_NONBLOCK | fsConstants.O_NOFOLLOW, 0o666);
    const target = fstatSync(descriptor, { bigint: true });
    if (!target.isFile()) throw new EvaluationError('报告目标必须是普通文件，不能是 FIFO、设备或目录。');
    const pathInfo = lstatSync(output, { bigint: true });
    if (pathInfo.isSymbolicLink()) throw new EvaluationError('报告路径不能是符号链接。');
    if (pathInfo.dev !== target.dev || pathInfo.ino !== target.ino) throw new EvaluationError('报告路径在保存期间发生变化。');
    const identities = [...inputStats, ...inputs.map(input => statSync(input, { bigint: true }))];
    if (identities.some(input => input.dev === target.dev && input.ino === target.ino)) {
      throw new EvaluationError('报告路径不能覆盖技能、案例或导入响应文件。');
    }
    const content = `${JSON.stringify(report, null, 2)}\n`;
    ftruncateSync(descriptor, 0);
    writeFileSync(descriptor, content, 'utf8');
  } catch (error) {
    if (error instanceof EvaluationError) throw error;
    throw new EvaluationError('无法保存报告；目标必须是可写的普通文件。');
  } finally { if (descriptor !== undefined) closeSync(descriptor); }
}

export async function main(argv = process.argv.slice(2)) {
  try {
    const options = parseArguments(argv);
    if (options.help) {
      process.stdout.write(HELP);
      return 0;
    }
    if (options.command !== null && !options.command.length) throw new EvaluationError('--command 后必须提供可执行文件及参数。');
    if (!trim(options.model)) throw new EvaluationError('模型标识不能为空。');
    if (options.output.length === 0) throw new EvaluationError('报告输出路径不能为空。');
    if (options.importedPath !== null && !trim(options.importedPath)) throw new EvaluationError('导入响应路径不能为空。');
    const inputs = [options.cases, options.skill];
    if (options.importedPath !== null) inputs.push(options.importedPath);
    protectInputs(options.output, inputs);
    checkOutputType(options.output);
    const cases = loadCases(options.cases, options.selected);
    let skill;
    try { skill = readUtf8(options.skill); }
    catch (error) { throw new EvaluationError(`无法读取技能：${error.message}`); }
    if (!trim(skill)) throw new EvaluationError('技能文件不能为空。');
    const imported = options.importedPath === null ? null : loadResponses(options.importedPath, cases);
    let inputStats;
    try { inputStats = inputs.map(input => statSync(input, { bigint: true })); }
    catch { throw new EvaluationError('无法读取输入文件身份信息；文件可能已被删除或替换。'); }
    const [report, code] = await evaluate(cases, skill, options.model, { command: options.command, imported, timeout: options.timeout });
    // 适配器执行期间路径可能改变，写报告前再次保护输入文件。
    protectInputs(options.output, inputs);
    saveReport(options.output, report, inputs, inputStats);
    console.log(`已保存 ${cases.length} 个案例的实际输出：${options.output}；自动评估未通过 ${report.summary.automatic_failed} 项，操作失败 ${report.summary.operation_errors} 项。`);
    console.log('语义维度仍需逐案人工复核；自动约束通过不代表技能行为已验证。');
    return code;
  } catch (error) {
    if (!(error instanceof EvaluationError)) throw error;
    if (error instanceof UsageError) {
      console.error(USAGE);
      console.error(`evaluate.mjs：错误：${error.message}`);
    } else console.error(`评测错误：${error.message}`);
    return 2;
  }
}

let isMain = false;
if (process.argv[1]) {
  try { isMain = realpathSync(resolve(process.argv[1])) === realpathSync(SCRIPT_PATH); } catch { isMain = false; }
}
if (isMain) process.exitCode = await main();
