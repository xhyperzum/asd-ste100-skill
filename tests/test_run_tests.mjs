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


test('门禁：提前退出不能隐藏已排队但未完成的测试', async () => {
  for (const source of [
    // 前面一个已完成的测试会让「至少一个真实测试」检查通过，随后 exit 丢弃未完成的失败测试。
    "import test from 'node:test';\ntest('真实通过',()=>{});\ntest('未完成',async()=>{await new Promise(r=>setTimeout(r,200));throw new Error('不应被隐藏')});\nsetTimeout(()=>process.exit(0),10);",
    "import test from 'node:test';\ntest('先完成',async()=>{await new Promise(r=>setTimeout(r,50))});\ntest('后失败',async()=>{await new Promise(r=>setTimeout(r,300));throw new Error('不应被隐藏')});\nsetTimeout(()=>process.exit(0),120);",
  ]) {
    await fixture([source], async (_, files) => assert.equal(isolatedRun(files).success, false));
  }
});

test('发现：拒绝子目录和非 test_*.mjs 的测试文件', async () => fixture([], root => {
  mkdirSync(join(root, 'tests/sub'));
  assert.throws(() => discoverTests(root), /子目录/);
  rmSync(join(root, 'tests/sub'), { recursive: true });
  // 所有可被执行或误放的扩展名都必须报错，包括大小写变体。
  // 断言必须匹配「命名错误」本身；只写 /test_/ 会连兜底的
  // 「未发现 tests/test_*.mjs」一起匹配，让静默跳过也能通过。
  for (const name of ['test_bad.js', 'test_bad.cjs', 'test_bad.mts', 'test_bad.cts', 'Test_bad.mjs', 'test_bad.MJS']) {
    writeFileSync(join(root, 'tests', name), pass);
    assert.throws(() => discoverTests(root), /必须以 test_ 开头/, `${name} 应被拒绝`);
    rmSync(join(root, 'tests', name));
  }
  // 非测试辅助文件不应被误杀。
  for (const name of ['notes.md', 'fixture.json', 'helper.txt']) {
    writeFileSync(join(root, 'tests', name), 'x');
    assert.throws(() => discoverTests(root), /未发现/);
    rmSync(join(root, 'tests', name));
  }
}));


test('门禁：延迟注册并提前退出会漏掉未开始的测试（已知边界）', async () => {
  // 未进入 enqueue 的测试无法被对账发现；该用例固定记录这一残余风险，
  // 使契约变化时能被注意到，而不是假设已经防住。
  await fixture(["import test from 'node:test';\ntest('pass',()=>{});\n"
    + 'setTimeout(()=>process.exit(0),50);\n'
    + "setTimeout(()=>test('late',()=>{throw new Error('hidden')}),100);"], async (_, files) => {
    const result = await runTests(files, { emit: false });
    // 若将来实现能拦住这种写法，这里会变为 false，届时应同步更新文档。
    assert.equal(result.success, true,
      '当前实现无法拦住未进入 enqueue 的测试；若此处失败，说明防护已加强，请更新文档说明');
  });
});


test('门禁：失败时不得输出可被误读为全绿的摘要', async () => {
  // 提前退出会让完成数少于排队数；摘要必须如实报告失败，不能只说「N 项通过」。
  await fixture(["import test from 'node:test';\ntest('真实通过',()=>{});\ntest('未完成',async()=>{await new Promise(r=>setTimeout(r,200));throw new Error('隐藏')});\nsetTimeout(()=>process.exit(0),10);"],
    async (root, files) => {
      const script = join(root, 'run-fixture.mjs');
      const moduleUrl = new URL('../scripts/run-tests.mjs', import.meta.url).href;
      writeFileSync(script, `import {runTests} from ${JSON.stringify(moduleUrl)};\n`
        + `const r=await runTests(${JSON.stringify(files)});\n`
        + "console.error('简介:成功=' + r.success + ' 未完成=' + r.incomplete);\n");
      const result = spawnSync(process.execPath, [script], { encoding: 'utf8', timeout: 10000 });
      assert.match(result.stderr, /未完成=1/);
    });
});


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
