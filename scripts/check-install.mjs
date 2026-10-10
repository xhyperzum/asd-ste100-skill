#!/usr/bin/env node
/** 验证技能资源、文本格式和临时安装副本。 */
import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  realpathSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

export const REQUIRED_PATHS = Object.freeze([
  ['SKILL.md', 'file'],
  ['scripts', 'dir'],
  ['scripts/check-install.mjs', 'file'],
  ['scripts/evaluate.mjs', 'file'],
  ['scripts/ste-lint.mjs', 'file'],
  ['scripts/run-tests.mjs', 'file'],
  ['evals', 'dir'],
  ['evals/cases.json', 'file'],
  ['references', 'dir'],
  ['references/linter.md', 'file'],
  ['references/evaluation.md', 'file'],
  ['references/installation.md', 'file'],
  ['references/chinese-writing-rules.md', 'file'],
  ['references/writing-rules.md', 'file'],
  ['examples/before-after.md', 'file'],
  ['examples/linter-edge-cases.md', 'file'],
  ['examples/fixtures.json', 'file'],
  ['tests', 'dir'],
  ['tests/test_install.mjs', 'file'],
  ['tests/test_evaluate.mjs', 'file'],
  ['tests/test_ste_lint.mjs', 'file'],
  ['tests/test_run_tests.mjs', 'file'],
  ['tests/test_consistency.mjs', 'file'],
  ['tests/test_case_acceptance.mjs', 'file'],
]);

const TEXT_EXTENSIONS = new Set(['.mjs', '.md', '.json', '.yml', '.yaml']);
const CACHE_NAMES = new Set(['.git', '.omc', 'graft', 'node_modules', '__pycache__', '.pytest_cache', '.mypy_cache']);
const CODE_FENCE = /^ {0,3}(?<marker>`{3,}|~{3,})(?<tail>.*)$/u;
const CHECKER_PATH = realpathSync(fileURLToPath(import.meta.url));
const ROOT_PATH = path.dirname(path.dirname(CHECKER_PATH));

function listFiles(root, errors) {
  const files = [];
  const boundary = realpathSync(root);
  function visit(directory, ancestors = new Set()) {
    let actual;
    try { actual = realpathSync(directory); }
    catch { errors.push(`${relative(root, directory)}: 无法解析资源链接`); return; }
    if (!pathInside(boundary, actual)) { errors.push(`${relative(root, directory)}: 资源链接越出技能目录`); return; }
    if (ancestors.has(actual)) { errors.push(`${relative(root, directory)}: 存在循环目录链接`); return; }
    const next = new Set(ancestors).add(actual);
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (CACHE_NAMES.has(entry.name)) continue;
      const absolute = path.join(directory, entry.name);
      let target;
      try {
        const realTarget = realpathSync(absolute);
        if (!pathInside(boundary, realTarget)) { errors.push(`${relative(root, absolute)}: 资源链接越出技能目录`); continue; }
        target = statSync(absolute);
      } catch { errors.push(`${relative(root, absolute)}: 无法解析资源链接`); continue; }
      if (target.isDirectory()) visit(absolute, next);
      else if (target.isFile()) files.push(absolute);
    }
  }
  visit(root);
  return files;
}

function relative(root, target) {
  return path.relative(root, target).split(path.sep).join('/');
}

function pathInside(root, candidate) {
  const value = path.relative(root, candidate);
  return value === '' || (!value.startsWith(`..${path.sep}`) && value !== '..' && !path.isAbsolute(value));
}

export function checkNodeVersion(version = process.versions.node) {
  const match = /^(?:v)?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/u.exec(String(version));
  if (!match) throw new Error(`无法读取有效的 Node.js 版本：${version}`);
  if (Number(match[1]) < 22) throw new Error(`需要 Node.js 22 或更高版本，当前为 ${version}。`);
  return String(version).replace(/^v/u, '');
}

export function checkTextFiles(root) {
  const absoluteRoot = realpathSync(path.resolve(root));
  const errors = [];
  for (const file of listFiles(absoluteRoot, errors)) {
    if (!TEXT_EXTENSIONS.has(path.extname(file).toLowerCase())) continue;
    const bytes = readFileSync(file);
    const name = relative(absoluteRoot, file);
    if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
      errors.push(`${name}: 存在 UTF-8 BOM`);
    }
    if (bytes.includes(0x0d)) errors.push(`${name}: 存在 CR 换行`);
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      errors.push(`${name}: 不是有效的 UTF-8`);
    }
  }
  return errors;
}

export function checkResources(root) {
  const absoluteRoot = realpathSync(path.resolve(root));
  const invalid = [];
  for (const [resource, expected] of REQUIRED_PATHS) {
    const target = path.join(absoluteRoot, resource);
    let valid = false;
    try {
      const stat = statSync(target);
      valid = expected === 'dir' ? stat.isDirectory() : stat.isFile();
    } catch {
      valid = false;
    }
    if (!valid) invalid.push(`${resource}（需要${expected === 'dir' ? '目录' : '文件'}）`);
  }
  if (invalid.length) throw new Error(`缺少或类型错误的必要资源：${invalid.join('、')}`);
  return true;
}

function proseWithoutCode(text) {
  const lines = [];
  let fence = null;
  for (const line of text.split(/\r?\n|\r/gu)) {
    const opening = CODE_FENCE.exec(line);
    if (fence) {
      if (opening && opening.groups.marker[0] === fence.marker
        && opening.groups.marker.length >= fence.length && !opening.groups.tail.trim()) fence = null;
      lines.push('');
      continue;
    }
    if (opening && (opening.groups.marker[0] !== '`' || !opening.groups.tail.includes('`'))) {
      fence = { marker: opening.groups.marker[0], length: opening.groups.marker.length };
      lines.push('');
      continue;
    }
    if (/^(?: {4}|\t)/u.test(line)) lines.push('');
    else lines.push(line);
  }
  return lines.join('\n').replace(/(?<!`)(`+)(?!`)([\s\S]*?)(?<!`)\1(?!`)/gu, match => match.replace(/[^\n]/gu, ' '));
}

function markdownTarget(raw) {
  const value = raw.trim();
  if (!value) return '';
  if (value.startsWith('<')) {
    const end = value.indexOf('>');
    return end < 0 ? '' : value.slice(1, end);
  }
  return value.split(/\s/u, 1)[0].replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])/gu, '$1');
}

function bracketEnd(text, start, opening, closing) {
  let depth = 1;
  let angle = false;
  let quote = null;
  for (let index = start + 1; index < text.length; index += 1) {
    const character = text[index];
    if (character === '\\') { index += 1; continue; }
    if (opening === '(') {
      if (quote) { if (character === quote) quote = null; continue; }
      if (!angle && ['"', "'"].includes(character) && /\s/u.test(text[index - 1])) { quote = character; continue; }
      if (character === '<') angle = true;
      if (character === '>') angle = false;
      if (angle) continue;
    }
    if (character === opening) depth += 1;
    if (character === closing && --depth === 0) return index;
  }
  return -1;
}

function markdownTargets(text) {
  const targets = [];
  const references = new Map();
  const normalize = label => label.trim().replace(/\s+/gu, ' ').toLowerCase();
  const prose = proseWithoutCode(text).replace(/^ {0,3}\[([^\]\n]+)\]:[ \t]*(.+)$/gmu, (_line, label, value) => {
    const key = normalize(label);
    if (!references.has(key)) {
      references.set(key, value);
      targets.push(markdownTarget(value));
    }
    return '';
  });
  for (let index = 0; index < prose.length; index += 1) {
    if (prose[index] === '\\') { index += 1; continue; }
    if (prose[index] !== '[') continue;
    const end = bracketEnd(prose, index, '[', ']');
    if (end < 0) continue;
    const label = prose.slice(index + 1, end);
    let next = end + 1;
    while (/[ \t\n]/u.test(prose[next] || '') && next < prose.length) next += 1;
    if (prose[next] === '(') {
      const close = bracketEnd(prose, next, '(', ')');
      if (close >= 0) { targets.push(markdownTarget(prose.slice(next + 1, close))); index = close; }
    } else if (prose[next] === '[') {
      const close = bracketEnd(prose, next, '[', ']');
      if (close >= 0) {
        // 定义的目标已统一检查；未定义的引用按 Markdown 正文处理。
        index = close;
      }
    } else if (references.has(normalize(label))) index = end;
  }
  return targets;
}

export function checkMarkdownLinks(root) {
  const absoluteRoot = realpathSync(path.resolve(root));
  const errors = [];
  for (const file of listFiles(absoluteRoot, errors)) {
    if (path.extname(file).toLowerCase() !== '.md') continue;
    const name = relative(absoluteRoot, file);
    let text;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(file));
    } catch (error) {
      errors.push(`${name}: 无法读取 UTF-8 文档：${error.message}`);
      continue;
    }
    for (const rawTarget of markdownTargets(text)) {
      let target = rawTarget;
      if (!target || /^(?:[a-z][a-z\d+.-]*:|\/\/|#)/iu.test(target)) continue;
      target = target.split(/[?#]/u, 1)[0];
      if (!target) continue;
      try {
        target = decodeURIComponent(target);
      } catch {
        errors.push(`${name}: 无效的资源链接编码：${target}`);
        continue;
      }
      const resolved = path.resolve(path.dirname(file), target);
      if (!pathInside(absoluteRoot, resolved)) {
        errors.push(`${name}: 资源链接越出技能目录：${rawTarget}`);
        continue;
      }
      if (!existsSync(resolved)) {
        errors.push(`${name}: 找不到资源链接：${rawTarget}`);
        continue;
      }
      let actual;
      try {
        actual = realpathSync(resolved);
      } catch {
        errors.push(`${name}: 无法解析资源链接：${rawTarget}`);
        continue;
      }
      if (!pathInside(absoluteRoot, actual)) errors.push(`${name}: 资源链接越出技能目录：${rawTarget}`);
    }
  }
  return errors;
}

export async function run(command, cwd, inputText = null, timeoutSec = 120) {
  if (!Array.isArray(command) || command.length === 0) throw new Error('子进程命令必须是非空 argv 数组。');
  if (!Number.isFinite(timeoutSec) || timeoutSec <= 0 || timeoutSec * 1000 > 2147483647) throw new Error('命令超时必须为有效的正数秒数，且不得超过计时器上限。');
  return new Promise((resolve, reject) => {
    let child;
    try { child = spawn(command[0], command.slice(1), { cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }); }
    catch (error) { reject(new Error(`无法启动命令：${error.message}`)); return; }
    const output = { stdout: [], stderr: [] };
    let bytes = 0;
    let ended = false;
    let timer;
    let cleanupTimer;
    const finish = (error, status = null) => {
      if (ended) return;
      ended = true;
      clearTimeout(timer);
      clearTimeout(cleanupTimer);
      child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
      if (error) reject(error);
      else resolve({ stdout: Buffer.concat(output.stdout).toString('utf8'), stderr: Buffer.concat(output.stderr).toString('utf8'), status });
    };
    const abort = error => { child.kill('SIGKILL'); finish(error); };
    for (const name of ['stdout', 'stderr']) child[name].on('data', chunk => {
      bytes += chunk.length;
      if (bytes > 32 * 1024 * 1024) abort(new Error('命令输出超过 32 MiB 缓冲上限。'));
      else output[name].push(chunk);
    });
    child.on('error', error => finish(new Error(`无法运行命令：${error.message}`)));
    child.stdin.on('error', error => {
      if (error.code !== 'EPIPE' || (inputText !== null && Buffer.byteLength(inputText) > 0)) {
        abort(new Error(`无法发送标准输入：${error.message}`));
      }
    });
    child.on('exit', () => {
      if (ended) return;
      // 后代可能继承输出管道；直属进程退出后最多再等待一秒收尾。
      cleanupTimer = setTimeout(() => finish(new Error('命令输出管道未在直属进程退出后一秒内关闭。')), 1000);
    });
    child.on('close', status => {
      if (status !== 0) {
        const detail = Buffer.concat(output.stderr.length ? output.stderr : output.stdout).toString('utf8').trim();
        finish(new Error(`命令失败（退出码 ${status ?? 'unknown'}）：${command.join(' ')}${detail ? `\n${detail}` : ''}`));
      } else finish(null, status);
    });
    timer = setTimeout(() => abort(new Error(`命令执行超过 ${timeoutSec} 秒：${command.join(' ')}`)), timeoutSec * 1000);
    child.stdin.end(inputText ?? '');
  });
}

function copyTree(source, destination, sourceRoot, ancestors = new Set()) {
  const realSource = realpathSync(source);
  if (!pathInside(sourceRoot, realSource)) throw new Error(`运行资源越出技能目录：${source}`);
  if (ancestors.has(realSource)) throw new Error(`运行资源包含循环目录链接：${source}`);
  const nextAncestors = new Set(ancestors);
  nextAncestors.add(realSource);
  mkdirSync(destination, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    if (CACHE_NAMES.has(entry.name)) continue;
    const from = path.join(source, entry.name);
    const to = path.join(destination, entry.name);
    if (entry.isDirectory()) copyTree(from, to, sourceRoot, nextAncestors);
    else if (entry.isFile()) copyFileSync(from, to);
    else if (entry.isSymbolicLink()) {
      const actual = realpathSync(from);
      if (!pathInside(sourceRoot, actual)) throw new Error(`运行资源链接越出技能目录：${relative(sourceRoot, from)}`);
      const targetStat = statSync(actual);
      if (targetStat.isDirectory()) copyTree(actual, to, sourceRoot, nextAncestors);
      else if (targetStat.isFile()) copyFileSync(actual, to);
    }
  }
}

function copySkillResources(source, destination) {
  mkdirSync(destination, { recursive: true });
  for (const name of ['SKILL.md', 'README.md', 'LICENSE', 'LICENSE.zh-CN']) {
    const from = path.join(source, name);
    if (existsSync(from)) {
      if (!pathInside(source, realpathSync(from))) throw new Error(`运行资源越出技能目录：${name}`);
      copyFileSync(from, path.join(destination, name));
    }
  }
  for (const name of ['scripts', 'evals', 'references', 'tests', 'examples']) {
    copyTree(path.join(source, name), path.join(destination, name), source);
  }
}

export async function checkInstall(root, { runner = run, node = process.execPath } = {}) {
  checkNodeVersion();
  checkResources(root);
  const absoluteRoot = realpathSync(path.resolve(root));
  const textErrors = checkTextFiles(absoluteRoot);
  if (textErrors.length) throw new Error(textErrors.join('\n'));
  const linkErrors = checkMarkdownLinks(absoluteRoot);
  if (linkErrors.length) throw new Error(linkErrors.join('\n'));

  const temporary = mkdtempSync(path.join(os.tmpdir(), 'asd-ste100-install-'));
  const installed = path.join(temporary, 'installed-skill');
  const outside = path.join(temporary, 'outside');
  mkdirSync(outside);
  try {
    copySkillResources(absoluteRoot, installed);
    const lint = path.join(installed, 'scripts', 'ste-lint.mjs');
    const catalogResult = await runner([node, lint, '--list-rules', '--json'], outside);
    let catalog;
    try {
      catalog = JSON.parse(catalogResult.stdout);
    } catch {
      throw new Error('安装副本的 --list-rules --json 未返回有效 JSON。');
    }
    if (catalog.schema_version !== 1 || !Array.isArray(catalog.rules) || !catalog.rules.length) {
      throw new Error('安装副本的规则目录结构无效。');
    }

    const lintResult = await runner([node, lint, '--json', '--text-type', 'instruction'], outside,
      'The request may have failed.\n');
    let report;
    try {
      report = JSON.parse(lintResult.stdout);
    } catch {
      throw new Error('安装副本的标准输入检查未返回有效 JSON。');
    }
    if (report.words !== 5 || report.text_type !== 'instruction') {
      throw new Error('安装副本的标准输入检查结果不符合预期。');
    }

    const evaluator = path.join(installed, 'scripts', 'evaluate.mjs');
    await runner([node, evaluator, '--help'], outside);
    await runner([node, path.join(installed, 'scripts', 'run-tests.mjs')], outside);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

const HELP = '用法：node scripts/check-install.mjs [--check-text-files]\n\n验证技能资源、文本格式和临时安装副本；需要 Node.js 22 或更高版本。\n';

export async function main(argv = process.argv.slice(2)) {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(HELP);
    return 0;
  }
  if (argv.some(argument => argument !== '--check-text-files') || argv.filter(argument => argument === '--check-text-files').length > 1) {
    console.error(`${HELP.trimEnd()}\n检查失败：未知或重复参数。`);
    return 2;
  }
  try {
    checkNodeVersion();
    const errors = checkTextFiles(ROOT_PATH);
    if (errors.length) throw new Error(errors.join('\n'));
    if (argv.includes('--check-text-files')) {
      console.log('文本文件编码检查通过。');
      return 0;
    }
    checkResources(ROOT_PATH);
    const linkErrors = checkMarkdownLinks(ROOT_PATH);
    if (linkErrors.length) throw new Error(linkErrors.join('\n'));
    await checkInstall(ROOT_PATH);
    console.log('技能资源、相对 Markdown 链接和临时安装副本检查通过。');
    return 0;
  } catch (error) {
    console.error(`检查失败：${error.message}`);
    return 1;
  }
}

let invokedAsScript = false;
if (process.argv[1]) {
  try {
    invokedAsScript = realpathSync(path.resolve(process.argv[1])) === CHECKER_PATH;
  } catch {
    invokedAsScript = false;
  }
}
if (invokedAsScript) process.exitCode = await main();
