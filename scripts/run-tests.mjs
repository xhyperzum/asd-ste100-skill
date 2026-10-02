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
  const entries = readdirSync(directory, { withFileTypes: true }).filter(entry => /^test_.*\.mjs$/u.test(entry.name));
  for (const entry of entries) if (!entry.isFile()) throw new Error(`测试资源必须是普通文件：${entry.name}`);
  const files = entries.map(entry => resolve(directory, entry.name)).sort();
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
    records.set(actual, { file: actual, registered: 0, passed: 0, inactive: 0 });
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
    if (type === 'test:complete') {
      const placeholder = data.name === data.file && data.line === 1 && data.column === 1;
      if (!placeholder) {
        let actual;
        try { actual = realpathSync(data.file); } catch { actual = data.file; }
        const record = records.get(actual);
        if (!record) failed = true;
        else {
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
  const success = !failed && results.every(item => item.registered > 0 && item.passed === item.registered && !item.inactive);
  if (emit) {
    for (const record of results) if (!record.registered) console.error(`测试失败：${record.file} 未发现真实注册测试。`);
    if (inactive) console.error('测试失败：存在跳过、TODO 或取消的测试，不能视为完整通过。');
    console.log(`回归完成：${registered} 项真实测试，${passed} 项通过。`);
  }
  return { success, registered, passed, inactive, files: results };
}

export async function main(argv = process.argv.slice(2)) {
  if (argv.length === 1 && ['--help', '-h'].includes(argv[0])) {
    console.log('用法：node scripts/run-tests.mjs [测试文件 ...]\n省略文件时，动态发现 tests/test_*.mjs；逐文件拒绝空覆盖、跳过、TODO、取消和失败。');
    return 0;
  }
  if (argv.some(value => value.startsWith('-'))) { console.error('测试失败：未知参数。'); return 2; }
  try { return (await runTests(argv.length ? argv.map(value => resolve(value)) : discoverTests())).success ? 0 : 1; }
  catch (error) { console.error(`测试失败：${error.message}`); return 1; }
}
let isMain = false;
if (process.argv[1]) { try { isMain = realpathSync(resolve(process.argv[1])) === SCRIPT; } catch {} }
if (isMain) process.exitCode = await main();
