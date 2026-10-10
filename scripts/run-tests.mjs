#!/usr/bin/env node
/** 按真实测试事件验证覆盖；文件占位和跳过不能充当回归通过。 */
import { lstatSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from 'node:test';

const SCRIPT = realpathSync(fileURLToPath(import.meta.url));
const ROOT = resolve(dirname(SCRIPT), '..');

export function discoverTests(root = ROOT) {
  const directory = resolve(root, 'tests');
  const entries = readdirSync(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (/^test_.*\.mjs$/u.test(entry.name)) {
      if (!entry.isFile()) throw new Error(`测试资源必须是普通文件：${entry.name}`);
      continue;
    }
    // 静默忽略会被当成「没有测试」；隐藏的失败测试必须报错而不是跳过。
    if (entry.isDirectory()) throw new Error(`tests/ 下只允许顶层 test_*.mjs，不接受子目录：${entry.name}`);
    // 覆盖所有可被当作测试执行或误放的扩展名，包括大小写变体（.MJS）。
    // 符号链接指向目录时 isDirectory() 为 false，因此按名称判定。
    if (/^test_.*.m(?:js|ts|cjs|cts)$/iu.test(entry.name)
      || /\.(?:mjs|js|cjs|mts|cts)$/iu.test(entry.name)) {
      throw new Error(`测试文件名必须以 test_ 开头并以小写 .mjs 结尾：${entry.name}`);
    }
  }
  const files = entries.filter(entry => /^test_.*\.mjs$/u.test(entry.name))
    .map(entry => resolve(directory, entry.name)).sort();
  if (!files.length) throw new Error('未发现 tests/test_*.mjs 回归测试。');
  return files;
}

export async function runTests(files, { emit = true } = {}) {
  if (!Array.isArray(files) || !files.length) throw new Error('必须提供非空测试文件列表。');
  const records = new Map();
  for (const file of files) {
    if (lstatSync(file).isSymbolicLink()) throw new Error(`测试资源必须是普通文件，不能是符号链接：${file}`);
    const actual = realpathSync(file);
    if (!statSync(actual).isFile()) throw new Error(`测试路径不是文件：${file}`);
    if (records.has(actual)) throw new Error(`测试文件重复：${file}`);
    records.set(actual, { file: actual, registered: 0, passed: 0, inactive: 0, enqueued: 0, completed: 0 });
  }
  let failed = false;
  let stream;
  const inherited = process.env.NODE_TEST_CONTEXT;
  try {
    delete process.env.NODE_TEST_CONTEXT;
    stream = run({ files: [...records.keys()], concurrency: 1 });
  } finally {
    if (inherited !== undefined) process.env.NODE_TEST_CONTEXT = inherited;
  }
  for await (const { type, data } of stream) {
    // 提前 process.exit 会丢弃已排队但未完成的测试；只统计完成事件无法发现。
    if (type === 'test:enqueue') {
      let actual;
      try { actual = realpathSync(data.file); } catch { actual = data.file; }
      const record = records.get(actual);
      if (record) record.enqueued += 1;
      else failed = true;
    }
    if (type === 'test:complete') {
      let actual;
      try { actual = realpathSync(data.file); } catch { actual = data.file; }
      const record = records.get(actual);
      if (record) {
        record.completed += 1;
        const placeholder = data.name === data.file && data.line === 1 && data.column === 1;
        if (!placeholder) {
          const inactive = data.skip || data.todo || data.details.error?.failureType === 'cancelledByParent';
          // 跳过整个 suite 会隐藏所有子测试；即使另一个 test 通过也必须拒绝。
          if (inactive) record.inactive += 1;
          if (data.details.type !== 'suite') {
            record.registered += 1;
            if (!inactive && data.details.passed) record.passed += 1;
          }
        }
      }
      if (!data.details.passed) failed = true;
    }
    if (type === 'test:summary' && !data.success) failed = true;
    if (type === 'test:fail') {
      failed = true;
      if (emit) console.error(`测试失败：${data.name}：${data.details.error?.message || '执行失败'}`);
    }
    if (emit && type === 'test:stdout') process.stdout.write(data.message);
    if (emit && type === 'test:stderr') process.stderr.write(data.message);
  }
  const results = [...records.values()];
  const registered = results.reduce((sum, item) => sum + item.registered, 0);
  const passed = results.reduce((sum, item) => sum + item.passed, 0);
  const inactive = results.reduce((sum, item) => sum + item.inactive, 0);
  const incomplete = results.reduce((sum, item) => sum + (item.enqueued - item.completed), 0);
  const unpassed = registered - passed - inactive;
  // 每个文件都必须有真实测试、全部通过，且没有排队后未完成的项。
  const complete = results.every(item => {
    return item.registered > 0 && item.passed === item.registered && !item.inactive;
  });
  const success = !failed && !incomplete && complete;
  if (emit) {
    for (const record of results) if (!record.registered) console.error(`测试失败：${record.file} 未发现真实注册测试。`);
    for (const record of results) {
      if (record.enqueued !== record.completed) {
        console.error(`测试失败：${record.file} 有 ${record.enqueued - record.completed} 项测试已排队但未完成，`
          + '提前退出会隐藏失败。');
      }
    }
    if (inactive) console.error('测试失败：存在跳过、TODO 或取消的测试，不能视为完整通过。');
    // 摘要必须区分失败原因；只报「N 项通过」会被误读为全绿，
    // 而把「未完成」也说成「未通过」会掩盖提前退出。
    if (success) {
      console.log(`回归完成：${registered} 项真实测试，${passed} 项通过。`);
    } else {
      const reasons = [];
      if (incomplete) reasons.push(`${incomplete} 项未完成`);
      if (unpassed > 0) reasons.push(`${unpassed} 项未通过`);
      if (inactive) reasons.push(`${inactive} 项跳过或取消`);
      if (failed && !reasons.length) reasons.push('执行器报告失败');
      console.error(`回归失败：${registered} 项真实测试，${passed} 项通过，`
        + `${reasons.length ? reasons.join('、') : '未通过或未完成'}。`);
    }
  }
  return { success, registered, passed, inactive, incomplete, unpassed, files: results };
}

export async function main(argv = process.argv.slice(2)) {
  if (argv.length === 1 && ['--help', '-h'].includes(argv[0])) {
    console.log('用法：node scripts/run-tests.mjs [测试文件 ...]\n省略文件时，动态发现 tests/test_*.mjs；逐文件拒绝空覆盖、未完成、跳过、TODO、取消和失败。\ntests/ 下不接受子目录，其他 .js/.mjs 文件必须命名为 test_*.mjs。');
    return 0;
  }
  if (argv.some(value => value.startsWith('-'))) { console.error('测试失败：未知参数。'); return 2; }
  try { return (await runTests(argv.length ? argv.map(value => resolve(value)) : discoverTests())).success ? 0 : 1; }
  catch (error) { console.error(`测试失败：${error.message}`); return 1; }
}
let isMain = false;
if (process.argv[1]) { try { isMain = realpathSync(resolve(process.argv[1])) === SCRIPT; } catch {} }
if (isMain) process.exitCode = await main();
