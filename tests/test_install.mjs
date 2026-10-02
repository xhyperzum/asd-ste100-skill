import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, mkdirSync, rmSync, statSync,
  symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { discoverTests } from '../scripts/run-tests.mjs';

import { REQUIRED_PATHS, checkNodeVersion, checkTextFiles, checkResources,
  checkMarkdownLinks, run, checkInstall } from '../scripts/check-install.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const INSTALLER = path.join(ROOT, 'scripts', 'check-install.mjs');

function withTemp(callback) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'ste-install-test-'));
  try {
    return callback(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function createResources(root) {
  for (const [relative, type] of REQUIRED_PATHS) {
    const destination = path.join(root, relative);
    if (type === 'dir') mkdirSync(destination, { recursive: true });
    else {
      mkdirSync(path.dirname(destination), { recursive: true });
      writeFileSync(destination, 'resource\n', 'utf8');
    }
  }
}

function runCli(args) {
  return spawnSync(process.execPath, [INSTALLER, ...args], {
    encoding: 'utf8',
    timeout: 15_000,
    maxBuffer: 8 * 1024 * 1024,
  });
}

test('版本：检查器接受 Node.js 22.0 和更新主版本', () => {
  assert.equal(checkNodeVersion('22.0.0'), '22.0.0');
  assert.equal(checkNodeVersion('v22.22.1'), '22.22.1');
  assert.equal(checkNodeVersion('24.2.1'), '24.2.1');
  assert.throws(() => checkNodeVersion('21.9.0'), /需要 Node.js 22/);
  assert.throws(() => checkNodeVersion('未知版本'), /无法读取有效的 Node.js 版本/);
});

test('文本：检测 BOM、CR 换行和非法 UTF-8，保留 workflow 检查', () => {
  withTemp((root) => {
    writeFileSync(path.join(root, 'source.mjs'), Buffer.from([0xef, 0xbb, 0xbf, 0x61, 0x0d, 0x0a]));
    const workflow = path.join(root, '.github', 'workflows', 'validate.yml');
    mkdirSync(path.dirname(workflow), { recursive: true });
    writeFileSync(workflow, 'name: validate\r\n');
    const binary = path.join(root, 'evals.json');
    writeFileSync(binary, Buffer.from([0xff]));
    const errors = checkTextFiles(root);
    assert.ok(errors.some((error) => error.includes('source.mjs') && error.includes('BOM')));
    assert.ok(errors.some((error) => error.includes('source.mjs') && error.includes('CR')));
    assert.ok(errors.some((error) => error.includes('validate.yml') && error.includes('CR')));
    assert.ok(errors.some((error) => error.includes('evals.json') && error.includes('UTF-8')));
  });
});

test('资源：报告缺少的必要文件和目录', () => {
  withTemp((root) => {
    assert.throws(() => checkResources(root), error => {
      assert.match(error.message, /SKILL\.md/);
      assert.match(error.message, /scripts\/ste-lint\.mjs/);
      assert.match(error.message, /tests\/test_ste_lint\.mjs/);
      return true;
    });
  });
});

test('资源：拒绝文件和目录类型不符', () => {
  withTemp((root) => {
    mkdirSync(path.join(root, 'SKILL.md'));
    assert.throws(() => checkResources(root), /SKILL\.md（需要文件）/);
  });
});

test('链接：报告缺失的本地 Markdown 资源并忽略空目标', () => {
  withTemp((root) => {
    writeFileSync(path.join(root, 'guide.md'), '[缺失](missing.md) [空白]( ) [空]()\n', 'utf8');
    const errors = checkMarkdownLinks(root);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /找不到资源链接：missing\.md/);
  });
});

test('链接：跳过行内代码、围栏代码和外部链接', () => {
  withTemp((root) => {
    writeFileSync(path.join(root, 'guide.md'),
      '`[代码](missing.md)`\n\n~~~md\n[样例](missing-too.md)\n~~~\n[外部](https://example.com)\n', 'utf8');
    assert.deepEqual(checkMarkdownLinks(root), []);
  });
});

test('链接：拒绝指向技能目录外的符号链接资源', () => {
  withTemp((directory) => {
    const root = path.join(directory, 'skill');
    const outside = path.join(directory, 'outside.md');
    mkdirSync(root);
    writeFileSync(outside, '外部资源\n', 'utf8');
    symlinkSync(outside, path.join(root, 'linked.md'));
    writeFileSync(path.join(root, 'guide.md'), '[资源](linked.md)\n', 'utf8');
    const errors = checkMarkdownLinks(root);
    assert.ok(errors.some(error => /资源链接越出技能目录/u.test(error)));
  });
});

test('安装：临时复制后从外部目录运行共享测试门禁', async () => {
  const calls = [];
  const fakeRunner = async (command, cwd, inputText = null, timeoutSec = 120) => {
    calls.push({ command, cwd, inputText, timeoutSec });
    assert.equal(path.basename(cwd), 'outside');
    const installed = path.join(path.dirname(cwd), 'installed-skill');
    for (const [resource, type] of REQUIRED_PATHS) {
      const target = path.join(installed, resource);
      assert.ok(type === 'dir'
        ? statSync(target).isDirectory()
        : statSync(target).isFile(), resource);
    }
    assert.equal(existsSync(path.join(installed, 'graft')), false);
    assert.equal(existsSync(path.join(installed, '.omc')), false);
    if (command.includes('--list-rules')) {
      return { stdout: JSON.stringify({ schema_version: 1, rules: [{ id: 'semicolon' }] }), stderr: '', status: 0 };
    }
    if (command.includes('--json')) {
      return { stdout: JSON.stringify({ words: 5, text_type: 'instruction' }), stderr: '', status: 0 };
    }
    return { stdout: '', stderr: '', status: 0 };
  };
  await checkInstall(ROOT, { runner: fakeRunner });
  assert.equal(calls.length, 4);
  assert.equal(calls[1].inputText, 'The request may have failed.\n');
  assert.ok(calls[2].command.some(argument => argument.endsWith('scripts/evaluate.mjs')));
  assert.ok(calls[3].command[1].endsWith('scripts/run-tests.mjs'));
  assert.equal(calls[3].command.length, 2);
});

test('进程：非零退出和超时均返回中文错误', async () => {
  await assert.rejects(run([process.execPath, '-e', 'process.exit(7)'], ROOT), /命令失败（退出码 7）/);
  await assert.rejects(run([process.execPath, '-e', 'setTimeout(() => {}, 1000)'], ROOT, null, 0.05), /命令执行超过 0\.05 秒/);
});

test('CLI：帮助和参数错误使用中文', () => {
  const help = runCli(['--help']);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /用法：/);
  const error = runCli(['--unknown']);
  assert.equal(error.status, 2);
  assert.match(error.stderr, /检查失败：未知或重复参数/);
});

test('CLI：经符号链接运行仍解析技能根目录', () => {
  withTemp((directory) => {
    const linkedScript = path.join(directory, 'check-install.mjs');
    symlinkSync(INSTALLER, linkedScript);
    const result = spawnSync(process.execPath, [linkedScript, '--check-text-files'], {
      encoding: 'utf8', timeout: 15_000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /文本文件编码检查通过/);
  });
});

test('ESM：直接导入不会启动命令行或产生输出', () => {
  const result = spawnSync(process.execPath,
    ['--input-type=module', '-e', 'await import(process.argv[1])', pathToFileURL(INSTALLER).href],
    { encoding: 'utf8', timeout: 15_000 });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
});

test('文本：内部符号链接目标格式也检查，并拒绝外链、损坏链接和目录循环', () => {
  withTemp(root => {
    writeFileSync(path.join(root, 'data'), '\ufeff原文\r\n');
    symlinkSync(path.join(root, 'data'), path.join(root, 'linked.mjs'));
    let errors = checkTextFiles(root);
    assert.ok(errors.some(error => error.includes('linked.mjs') && error.includes('BOM')));
    assert.ok(errors.some(error => error.includes('linked.mjs') && error.includes('CR')));
    symlinkSync(root, path.join(root, 'cycle'));
    symlinkSync(path.join(root, 'missing'), path.join(root, 'broken'));
    symlinkSync(path.dirname(root), path.join(root, 'outside'));
    errors = checkTextFiles(root);
    assert.ok(errors.some(error => error.includes('循环')));
    assert.ok(errors.some(error => error.includes('无法解析')));
    assert.ok(errors.some(error => error.includes('越出')));
  });
});

test('链接：支持平衡括号、转义括号、角括号空格路径和 reference 定义', () => {
  withTemp(root => {
    for (const name of ['a(b).md', 'has space.md']) writeFileSync(path.join(root, name), '正文\n');
    writeFileSync(path.join(root, 'guide.md'), '[括号](a(b).md "标题")\n[转义](a\\(b\\).md)\n[空格](<has space.md>)\n[完整][link]\n[link][]\n[link]\n\n[link]: a(b).md\n');
    assert.deepEqual(checkMarkdownLinks(root), []);
    writeFileSync(path.join(root, 'guide.md'), '[资源][link]\n\n[link]: missing.md "标题"\n');
    assert.ok(checkMarkdownLinks(root).some(error => error.includes('missing.md')));
  });
});

test('链接：不同长度的 backtick 不提前结束 inline code，缩进代码不检查', () => {
  withTemp(root => {
    writeFileSync(path.join(root, 'guide.md'), '`` `[代码](missing.md) ``\n    [缩进代码](also-missing.md)\n');
    assert.deepEqual(checkMarkdownLinks(root), []);
  });
});

test('进程：忽略 SIGTERM 的直属进程仍按截止时间结束', async () => {
  const started = performance.now();
  await assert.rejects(run([process.execPath, '-e', "process.on('SIGTERM',()=>{});setInterval(()=>{},1000);"], ROOT, null, 0.5), /超过/);
  assert.ok(performance.now() - started < 2500);
});

test('进程：后代持有输出管道时收尾有截止时间', async () => {
  const started = performance.now();
  const source = "require('node:child_process').spawn(process.execPath,['-e','setTimeout(()=>{},2500)'],{stdio:['ignore',1,2]});process.exit(0);";
  await assert.rejects(run([process.execPath, '-e', source], ROOT, null, 10), /管道/);
  assert.ok(performance.now() - started < 2500);
});

test('安装：真实共享门禁拒绝空测试文件和跳过测试，不以退出码零误判', async () => {
  const temporary = mkdtempSync(path.join(os.tmpdir(), 'ste-install-gate-'));
  const root = path.join(temporary, 'skill');
  try {
    cpSync(ROOT, root, { recursive: true, filter: source => !source.split(path.sep).includes('.git') });
    const files = discoverTests(root);
    const pass = "import test from 'node:test';test('合成真实覆盖',()=>{});\n";
    for (const file of files) writeFileSync(file, pass);
    for (const source of ['', "import test from 'node:test';test.skip('合成跳过',()=>{});\n"]) {
      writeFileSync(files[0], source);
      await assert.rejects(checkInstall(root), /命令失败/);
      writeFileSync(files[0], pass);
    }
  } finally { rmSync(temporary, { recursive: true, force: true }); }
});


test('进程：非空大标准输入被提前关闭，即使退出零也记录操作失败', async () => {
  const source = "require('node:fs').closeSync(0);process.stdout.write('退出零');";
  await assert.rejects(run([process.execPath, '-e', source], ROOT, '输入'.repeat(2_000_000), 5), /无法发送标准输入/);
  const result = await run([process.execPath, '-e', source], ROOT, '', 5);
  assert.equal(result.status, 0);
});
