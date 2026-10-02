/** 共享回归门禁的对抗输入；夹具不作为当前套件的跳过项。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverTests, runTests } from '../scripts/run-tests.mjs';

async function fixture(sources, callback) {
  const root = mkdtempSync(join(tmpdir(), 'ste-test-gate-'));
  mkdirSync(join(root, 'tests'));
  try {
    const files = sources.map((source, index) => {
      const file = join(root, 'tests', `test_${index}.mjs`);
      writeFileSync(file, source, 'utf8');
      return file;
    });
    return await callback(root, files);
  } finally { rmSync(root, { recursive: true, force: true }); }
}
function isolatedRun(files) {
  const script = join(files[0], '..', '..', 'run-fixture.mjs');
  const moduleUrl = new URL('../scripts/run-tests.mjs', import.meta.url).href;
  writeFileSync(script, `import {runTests} from ${JSON.stringify(moduleUrl)};\nconsole.log(JSON.stringify(await runTests(${JSON.stringify(files)},{emit:false})));\n`);
  const result = spawnSync(process.execPath, [script], { encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '', '隔离测试执行器不应留下警告');
  return JSON.parse(result.stdout);
}

const pass = "import test from 'node:test';test('真实通过',()=>{});\n";

test('发现：按文件名排序并自动纳入新增测试', async () => fixture([pass, pass], (root, files) => {
  assert.deepEqual(discoverTests(root), files);
  writeFileSync(join(root, 'tests/test_new.mjs'), pass);
  assert.equal(discoverTests(root).length, 3);
}));

test('发现：拒绝空目录、同名目录和符号链接测试', async () => fixture([], root => {
  assert.throws(() => discoverTests(root), /未发现/);
  mkdirSync(join(root, 'tests/test_directory.mjs'));
  assert.throws(() => discoverTests(root), /普通文件/);
  rmSync(join(root, 'tests/test_directory.mjs'), { recursive: true });
  writeFileSync(join(root, 'target'), pass);
  symlinkSync(join(root, 'target'), join(root, 'tests/test_link.mjs'));
  assert.throws(() => discoverTests(root), /普通文件/);
}));

test('门禁：真实通过且继承测试上下文仍按独立文件计数', async () => fixture([pass], async (_, files) => {
  const result = await runTests(files, { emit: false });
  assert.equal(result.success, true);
  assert.equal(result.registered, 1);
  assert.equal(result.passed, 1);
}));

test('门禁：每个文件必须有真实测试，另一个文件通过不能掩盖空文件', async () => fixture([pass, ''], async (_, files) => {
  const result = isolatedRun(files);
  assert.equal(result.success, false);
  assert.equal(result.files[1].registered, 0);
}));

test('门禁：跳过、TODO、失败和无子测试的 suite 均被拒绝', async () => {
  for (const source of ["import test from 'node:test';test.skip('跳过',()=>{});",
    "import test from 'node:test';test.todo('待实现');",
    "import test from 'node:test';test('失败',()=>{throw new Error('预期失败')});",
    "import {describe} from 'node:test';describe('空 suite',()=>{});"]) {
    await fixture([source], async (_, files) => assert.equal((isolatedRun(files)).success, false));
  }
});

test('门禁：通过与跳过混合、取消的子测试均被拒绝', async () => {
  for (const source of [pass + "test.skip('跳过',()=>{});",
    "import test from 'node:test';test('父',t=>{t.test('未等待的子',async()=>{await new Promise(r=>setTimeout(r,50))})});"]) {
    await fixture([source], async (_, files) => assert.equal((isolatedRun(files)).success, false));
  }
});

test('门禁：拒绝空输入、重复文件和目录路径', async () => fixture([pass], async (root, files) => {
  await assert.rejects(runTests([], { emit: false }), /非空/);
  await assert.rejects(runTests([files[0], files[0]], { emit: false }), /重复/);
  await assert.rejects(runTests([join(root, 'tests')], { emit: false }), /不是文件/);
}));


test('门禁：显式 API 和 CLI 文件参数同样拒绝符号链接', async () => fixture([pass], async (root, files) => {
  const linked = join(root, 'linked.mjs');
  symlinkSync(files[0], linked);
  await assert.rejects(runTests([linked], { emit: false }), /符号链接/);
  const script = fileURLToPath(new URL('../scripts/run-tests.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [script, linked], { encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /符号链接/);
}));


test('门禁：真实通过用例不能掩盖跳过、TODO 或取消的 suite', async () => {
  const prefix = "import test,{describe} from 'node:test';test('真实通过',()=>{});\n";
  for (const source of [
    prefix + "describe.skip('跳过 suite',()=>{test('隐藏的子测试',()=>{})});",
    prefix + "describe.todo('TODO suite',()=>{test('隐藏的子测试',()=>{})});",
    prefix + "describe('取消 suite',{timeout:20},()=>{test('未完成子测试',async()=>{await new Promise(r=>setTimeout(r,100))})});",
  ]) {
    await fixture([source], async (_, files) => assert.equal((isolatedRun(files)).success, false));
  }
});
