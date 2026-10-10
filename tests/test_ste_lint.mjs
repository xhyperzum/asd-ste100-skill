import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { Rule, RULES, RULES_ZH, ruleCatalog, lint, main } from '../scripts/ste-lint.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SCRIPT = path.join(ROOT, 'scripts', 'ste-lint.mjs');
const TEST_RUNNER = path.join(ROOT, 'scripts', 'run-tests.mjs');

function sentence(count) {
  return `${Array.from({ length: count }, (_, index) => `term${index}`).join(' ')}.`;
}

function findingsFor(text, rule, options = {}) {
  return lint(text, options.filename, options.textType, options.rules, options.language)[0]
    .filter((finding) => finding.rule === rule);
}

function runCli(args, input = undefined) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    input,
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
    timeout: 15_000,
  });
}

function withTemporaryDirectory(callback) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'ste-lint-'));
  try {
    return callback(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test('规则：检查器提示和等级符合目录', () => {
  const [findings] = lint('The panel is removed; spin up the job. Perform an analysis of the seamless log. We have received the report.');
  const levels = new Map(findings.map(({ rule, level }) => [rule, level]));
  for (const rule of ['semicolon', 'phrasal-verb', 'nominalization', 'marketing-adjective', 'passive-voice', 'present-perfect']) {
    assert.ok(levels.has(rule), `缺少规则 ${rule}`);
  }
  assert.equal(levels.get('semicolon'), 'advisory-free');
  for (const rule of ['phrasal-verb', 'nominalization', 'marketing-adjective', 'passive-voice', 'present-perfect']) {
    assert.equal(levels.get(rule), 'advisory');
  }
});

test('规则：软换行后的情态完成式不误报', () => {
  for (const modal of ['may', 'might', 'could', 'should', 'would', 'must', 'can', 'will', 'shall']) {
    assert.deepEqual(lint(`The request ${modal}\n have failed.`)[0], [], modal);
  }
  assert.deepEqual(lint('It could be a timeout.')[0], []);
});

test('规则：带否定、副词的情态完成式受保护', () => {
  for (const text of ['It may not have failed.', 'It could also have failed.',
    'It might already have failed.', 'It should probably not have failed.', "It couldn't have failed."]) {
    assert.deepEqual(findingsFor(text, 'present-perfect'), [], text);
  }
  const findings = findingsFor('It may not have failed, and we have received the report.', 'present-perfect');
  assert.equal(findings.length, 1);
  assert.equal(findings[0].match, 'have received');
  assert.equal(findingsFor('It may fail. We have received the report.', 'present-perfect').length, 1);
});

test('规则：同义词差异只给建议，不宣称语义相同', () => {
  const findings = findingsFor('Start the service. Launch the browser.', 'synonym-rotation');
  assert.equal(findings.length, 1);
  assert.equal(findings[0].level, 'advisory');
  assert.match(findings[0].message, /请核对/);
  assert.doesNotMatch(findings[0].message, /表示同一动作。请选择/);
});

test('规则：同义词提示使用各词首次出现位置并忽略一致用词', () => {
  const findings = findingsFor('Check the config file. Then verify the output. Verify twice.', 'synonym-rotation');
  assert.equal(findings.length, 1);
  assert.equal(findings[0].col, 29);
  assert.match(findings[0].message, /'verify'/);
  assert.match(findings[0].message, /'check'/);
  assert.deepEqual(findingsFor('Check the config. Check the output.', 'synonym-rotation'), []);
});

test('规则：目录统一提供硬性级别和限制说明', () => {
  const hard = new Set(RULES.filter((rule) => rule.level === 'advisory-free').map((rule) => rule.id));
  assert.deepEqual(hard, new Set(['semicolon', 'long-sentence', 'dangling-conjunction']));
  for (const rule of RULES) {
    assert.ok(rule.description);
    assert.ok(rule.limitations);
    assert.ok(['deterministic', 'heuristic'].includes(rule.type));
  }
});

test('规则：拒绝缺少检查器和重复规则 ID', () => {
  const metadata = ['new-rule', 'advisory', 'heuristic', '新规则说明', '新规则限制'];
  assert.throws(() => new Rule(...metadata), /new-rule.*checker/);
  for (const checker of [null, 'missing', 42]) {
    assert.throws(() => new Rule(...metadata, checker), /new-rule.*checker/);
  }
  assert.throws(() => ruleCatalog([RULES[0], RULES[0]]), /规则 ID 重复/);
});

test('规则：自定义检查器经统一 lint 分发并接收上下文', () => {
  const contexts = [];
  function* checker(context) {
    contexts.push(context);
    yield { position: context.segments[0].positions[0], match: 'Clear' };
  }
  const rule = new Rule('new-rule', 'advisory', 'heuristic', '新规则说明', '新规则限制', checker);
  const [findings, words] = lint('Clear.', 'fixture.md', 'instruction', [rule]);
  assert.equal(words, 1);
  assert.equal(contexts.length, 1);
  assert.equal(contexts[0].maxWords, 20);
  assert.deepEqual(findings, [{ file: 'fixture.md', line: 1, col: 1, rule: 'new-rule',
    level: 'advisory', match: 'Clear', message: '新规则说明' }]);
  assert.equal(rule.metadata().description, findings[0].message);
  assert.ok(RULES.every((registered) => typeof registered.checker === 'function'));
});

test('规则：支持为报告指定文件名', () => {
  assert.equal(lint('a; b', 'x.md')[0][0].file, 'x.md');
});

test('句长：分别应用默认说明和指令上限', () => {
  assert.deepEqual(findingsFor(sentence(25), 'long-sentence'), []);
  assert.equal(findingsFor(sentence(26), 'long-sentence').length, 1);
  assert.deepEqual(findingsFor(sentence(20), 'long-sentence', { textType: 'instruction' }), []);
  assert.equal(findingsFor(sentence(21), 'long-sentence', { textType: 'instruction' }).length, 1);
  assert.throws(() => lint('Text.', '<stdin>', 'invalid'), /text.type|文本类型/);
});

test('句长：软换行合并且保留首词源位置', () => {
  const text = `${Array(15).fill('word').join(' ')}\n  ${Array(15).fill('word').join(' ')}.`;
  const [findings, words] = lint(text);
  const long = findings.filter((finding) => finding.rule === 'long-sentence');
  assert.equal(words, 30);
  assert.equal(long.length, 1);
  assert.deepEqual([long[0].line, long[0].col], [1, 1]);
  assert.equal(long[0].match, '30 words');
});

test('句长：第二句报告物理行和列', () => {
  let findings = findingsFor(`Fine.   ${sentence(26)}`, 'long-sentence');
  assert.deepEqual([findings[0].line, findings[0].col], [1, 9]);
  findings = findingsFor(`Fine.\n  ${sentence(26)}`, 'long-sentence');
  assert.deepEqual([findings[0].line, findings[0].col], [2, 3]);
});

test('句长：常见缩写、小数不切断句子', () => {
  for (const abbreviation of ['e.g.', 'i.e.', 'Dr.', 'U.S.']) {
    assert.equal(findingsFor(`Use ${abbreviation} ${sentence(24)}`, 'long-sentence').length, 1, abbreviation);
  }
  assert.equal(findingsFor(`Use 2.5 ${sentence(24)}`, 'long-sentence').length, 1);
  assert.deepEqual(findingsFor(`${sentence(15)} ${sentence(15)}`, 'long-sentence'), []);
});

test('句长：句末引号和括号不会合并后句', () => {
  for (const first of ['He said "Clear."', "He said 'Clear.'", 'He said “Clear.”',
    'Status is (clear.)', 'Status is [clear.]']) {
    assert.deepEqual(findingsFor(`${first} ${sentence(23)}`, 'long-sentence'), [], first);
    const findings = findingsFor(`${first} ${sentence(26)}`, 'long-sentence');
    assert.equal(findings.length, 1, first);
    assert.equal(findings[0].col, [...first].length + 2);
  }
  assert.equal(findingsFor(`Use "e.g." ${sentence(24)}`, 'long-sentence').length, 1);
});

test('句长：块边界和列表项隔开统计', () => {
  const short = sentence(15).slice(0, -1);
  for (const boundary of ['\n\n', '\n---\n', '\n# Header\n', '\n| Label | Detail |\n| --- | --- |\n']) {
    assert.deepEqual(findingsFor(short + boundary + short, 'long-sentence'), [], JSON.stringify(boundary));
  }
  assert.deepEqual(findingsFor(`- ${short}\n- ${short}`, 'long-sentence'), []);
});

test('句长：列表续行作为同一句计算', () => {
  const text = `- ${Array(10).fill('word').join(' ')}\n  ${Array(10).fill('word').join(' ')}\n  ${Array(10).fill('word').join(' ')}.`;
  const findings = findingsFor(text, 'long-sentence');
  assert.equal(findings.length, 1);
  assert.equal(findings[0].col, 3);
});

test('句长：inline code 不计词且不拼接其两侧词', () => {
  const [findings, words] = lint(`spin\`hidden\` up. Foo \`word ${'word '.repeat(40)}\` bar.`);
  assert.equal(words, 4);
  assert.ok(!findings.some((finding) => finding.rule === 'phrasal-verb'));
  assert.ok(!findings.some((finding) => finding.rule === 'long-sentence'));
});

test('Markdown：围栏代码和缩进代码不会产生发现', () => {
  for (const text of ['```\nx = a; y = b\n```', '~~~\n- code and\n~~~', '    x = a; y = b', '\tx = a; y = b']) {
    assert.deepEqual(lint(text), [[], 0], text);
  }
});

test('Markdown：错误围栏类型和过短闭合符仍在代码区', () => {
  for (const text of ['````text\n~~~\ncode;\n```\nmore;\n````\nVisible;',
    '~~~~\n```\ncode;\n~~~\nmore;\n~~~~~\nVisible;']) {
    const [findings, words] = lint(text);
    assert.equal(words, 1);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].line, 7);
  }
});

test('Markdown：闭合围栏尾部只允许空白', () => {
  const [findings, words] = lint('```\n``` text\ncode;\n```\nClear.');
  assert.deepEqual(findings, []);
  assert.equal(words, 1);
});

test('Markdown：inline code 前后列号保持原始位置', () => {
  const text = 'Use `x; y` before bad; after.';
  const findings = findingsFor(text, 'semicolon');
  assert.equal(findings.length, 1);
  assert.equal(findings[0].col, text.indexOf('bad;') + 4);
});

test('Markdown：多反引号代码和未闭合标记', () => {
  const text = 'Use ``x ` inner; and`` then bad;';
  const [findings, words] = lint(text);
  assert.equal(words, 3);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].col, text.indexOf('bad;') + 4);
  assert.equal(findingsFor('Use `unclosed;', 'semicolon').length, 1);
});

test('Markdown：跨行 inline code 不参与检查并保留源位置', () => {
  for (const text of ['Use `code\ncontains; words` now.', 'Use ``one\ntwo; ` three`` now.',
    'Use `one\ntwo` then `three` now.']) {
    const [findings, words] = lint(text);
    assert.deepEqual(findings, [], text);
    assert.equal(words, text.includes('then') ? 3 : 2);
  }
  const [findings, words] = lint('Use `one\ntwo; three` now;');
  assert.equal(words, 2);
  assert.equal(findings.length, 1);
  assert.deepEqual([findings[0].line, findings[0].col], [2, 16]);
});

test('Markdown：inline code 阻止跨代码片段匹配规则', () => {
  for (const text of ['spin `operand` up', 'perform `operand` an analysis', 'is `operand` removed']) {
    assert.deepEqual(lint(text)[0], [], text);
  }
});

test('Markdown：标记符号不计入词数', () => {
  const [findings, words] = lint('# Clear heading\n\n- Read now.\n\n---\n***\n___\nTitle\n===');
  assert.deepEqual(findings, []);
  assert.equal(words, 5);
});

test('Markdown：表格单元格独立检查并计数', () => {
  for (const table of [`| Label | Detail |\n| --- | --- |\n| Clear | ${sentence(24)} |`,
    `Label | Detail\n--- | ---\nClear | ${sentence(24)}`]) {
    const [findings, words] = lint(table);
    assert.ok(!findings.some((finding) => finding.rule === 'long-sentence'));
    assert.equal(words, 27);
  }
});

test('Markdown：单列表格排除布局词并检查正文', () => {
  for (const text of ['| Label |\n| --- |\n| Clear. |', 'Label |\n--- |\nClear. |']) {
    assert.deepEqual(lint(text), [[], 2]);
  }
  const findings = findingsFor('| Label |\n| --- |\n| bad; |', 'semicolon');
  assert.equal(findings.length, 1);
  assert.deepEqual([findings[0].line, findings[0].col], [3, 6]);
});

test('Markdown：长表格单元格定位到首词', () => {
  const row = `| Clear | ${sentence(26)} |`;
  const findings = findingsFor(`| Label | Detail |\n| --- | --- |\n${row}`, 'long-sentence');
  assert.equal(findings.length, 1);
  assert.deepEqual([findings[0].line, findings[0].col], [3, 11]);
  assert.equal(findings[0].match, '26 words');
});

test('Markdown：表格内代码竖线作为操作数且列号准确', () => {
  const text = '| Label | Detail |\n| --- | --- |\n| `a|b` | bad; |';
  const [findings, words] = lint(text);
  assert.equal(words, 3);
  assert.equal(findings.length, 1);
  assert.deepEqual([findings[0].line, findings[0].col], [3, 14]);
  assert.equal(lint('| a\\|b | c |')[0].length, 0);
});

test('Markdown：普通正文中的竖线不识别为表格', () => {
  assert.equal(lint('one | two')[1], 3);
});

test('列表：支持标记、大小写变化和尾随空格', () => {
  const text = '- Confirm the target and\n* Record the result OR  \n+ Close the panel\n1. Start the task and\n2) Stop the task OR';
  const findings = findingsFor(text, 'dangling-conjunction');
  assert.deepEqual(findings.map((finding) => finding.line), [1, 2, 4, 5]);
  assert.deepEqual(findings.map((finding) => finding.col), [1, 1, 1, 1]);
  assert.ok(findings.every((finding) => finding.level === 'advisory-free'));
});

test('列表：受支持的续行缩进宽度正常合并', () => {
  for (const text of ['  - Confirm the target and\n    record the result.',
    ' - Start the task and\n   record the result.', '-  Start the task and\n   record the result.',
    '100. Start the task and\n     record the result.', '- Start the task and\n\n  record the result.']) {
    assert.deepEqual(findingsFor(text, 'dangling-conjunction'), [], text);
  }
});

test('列表：标记和续行问题保留准确源位置', () => {
  let findings = findingsFor('- Confirm the target\n  and', 'dangling-conjunction');
  assert.deepEqual([findings[0].line, findings[0].col], [2, 3]);
  findings = findingsFor('   - Start the task and', 'dangling-conjunction', { filename: 'fixture.md' });
  assert.deepEqual([findings[0].line, findings[0].col], [1, 4]);
  assert.equal(findings[0].file, 'fixture.md');
  assert.ok(findings[0].match.endsWith('and'));
  assert.match(findings[0].message, /请补全该项/);
  assert.equal(findingsFor('100. Start the task and\n  unrelated text', 'dangling-conjunction').length, 1);
});

test('列表：不支持的列表形式和带标点连词不误报', () => {
  for (const text of ['    - code and', '> - Confirm the target and\n> - Record the result or',
    '-\tStart the task and', 'The process may include steps and', '- Start the task and.\n- Stop the task or,']) {
    assert.deepEqual(findingsFor(text, 'dangling-conjunction'), [], text);
  }
});

test('列表：嵌套列表保留父项和子项问题', () => {
  const findings = findingsFor('- Parent item and\n  - Nested item or', 'dangling-conjunction');
  assert.deepEqual(findings.map((finding) => finding.line), [1, 2]);
});

test('列表：代码中的连词不是悬空连词', () => {
  for (const text of ['- Use `and` as a label', '- Combine `left` and `right`', '```text\n- code and\n```']) {
    assert.deepEqual(findingsFor(text, 'dangling-conjunction'), [], text);
  }
});

test('列表：列表项中的围栏不会吞掉之前正文或切换错误标记', () => {
  let text = '- Do this and\n~~~~\n```\ncode and\n~~~\n~~~~';
  let findings = findingsFor(text, 'dangling-conjunction');
  assert.equal(findings.length, 1);
  assert.equal(findings[0].line, 1);
  text = '- Do this and\n  ```\n  code and\n  ```\n  record the result.';
  assert.deepEqual(findingsFor(text, 'dangling-conjunction'), []);
});

test('列表：缩进代码不会取代最后一条有效正文', () => {
  assert.equal(findingsFor('- Do this and\n      code and', 'dangling-conjunction').length, 1);
  assert.deepEqual(findingsFor('- Do this and\n      code and\n  record the result.', 'dangling-conjunction'), []);
});

test('CLI：JSON 字段和文本类型上限保持兼容', () => {
  let result = runCli(['--json', '--text-type', 'instruction'], sentence(21));
  assert.equal(result.status, 1);
  let data = JSON.parse(result.stdout);
  assert.equal(data.schema_version, 1);
  assert.equal(data.text_type, 'instruction');
  assert.equal(data.max_words, 20);
  assert.equal(data.words, 21);
  assert.equal(data.hard_count, 1);
  for (const field of ['violations', 'count', 'baseline', 'per_100_words']) assert.ok(field in data);
  result = runCli(['--json'], sentence(21));
  assert.equal(result.status, 0);
  assert.equal(JSON.parse(result.stdout).max_words, 25);
});

test('CLI：基准值和禁用规则不改变词数', () => {
  assert.equal(runCli(['--baseline', '1'], 'Bad;').status, 0);
  assert.equal(runCli(['--baseline', '1'], 'Bad; more;').status, 1);
  const result = runCli(['--json', '--disable', 'semicolon'], 'Bad;');
  assert.equal(result.status, 0);
  assert.equal(JSON.parse(result.stdout).words, 1);
  assert.equal(JSON.parse(result.stdout).count, 0);
});

test('CLI：只有建议项时正常退出', () => {
  const result = runCli(['--json'], 'Start the service. Launch the browser. The panel is removed.');
  assert.equal(result.status, 0);
  assert.equal(JSON.parse(result.stdout).hard_count, 0);
  assert.ok(JSON.parse(result.stdout).count > 0);
});

test('CLI：参数错误使用中文并返回 2', () => {
  const cases = [['--unknown'], ['--base', '0'], ['--disable', 'missing'], ['--disable', 'semicolon,'],
    ['--disable', ''], ['--disable'], ['--baseline'], ['--baseline', '-1'], ['--baseline', 'bad'],
    ['--text-type'], ['--text-type', 'wrong']];
  for (const args of cases) {
    const result = runCli(args);
    assert.equal(result.status, 2, args.join(' '));
    assert.match(result.stderr, /错误/, args.join(' '));
    assert.doesNotMatch(result.stderr, /Traceback/, args.join(' '));
  }
});

test('CLI：不可读、目录和非法 UTF-8 文件返回中文输入错误', () => {
  withTemporaryDirectory((directory) => {
    const invalid = path.join(directory, 'invalid.md');
    writeFileSync(invalid, Buffer.from([0xff]));
    for (const file of [path.join(directory, 'missing.md'), directory, invalid]) {
      const result = runCli([file]);
      assert.equal(result.status, 2, file);
      assert.match(result.stderr, /无法读取输入/);
      assert.doesNotMatch(result.stderr, /Traceback/);
    }
  });
});

test('CLI：标准输入要求严格 UTF-8，并接收中文文本', () => {
  let result = spawnSync(process.execPath, [SCRIPT], { input: Buffer.from([0xff]), encoding: 'utf8', timeout: 15_000 });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /无法读取输入/);
  assert.doesNotMatch(result.stderr, /Traceback/);
  result = runCli(['--json'], '清晰的说明。');
  assert.equal(result.status, 0);
  assert.equal(JSON.parse(result.stdout).words, 1);
});

test('CLI：多个文件分别建立文档上下文', () => {
  withTemporaryDirectory((directory) => {
    const first = path.join(directory, 'first.md');
    const second = path.join(directory, 'second.md');
    writeFileSync(first, 'Start the service.', 'utf8');
    writeFileSync(second, 'Launch the browser.', 'utf8');
    const result = runCli(['--json', first, second]);
    assert.equal(result.status, 0);
    assert.equal(JSON.parse(result.stdout).count, 0);
    assert.equal(JSON.parse(result.stdout).words, 6);
  });
});

test('CLI：缺少自检目录或自检文件时明确失败', () => {
  withTemporaryDirectory((directory) => {
    const script = path.join(directory, 'scripts', 'ste-lint.mjs');
    mkdirSync(path.dirname(script));
    writeFileSync(script, readFileSync(SCRIPT));
    writeFileSync(path.join(path.dirname(script), 'run-tests.mjs'), readFileSync(TEST_RUNNER));
    const absent = spawnSync(process.execPath, [script, '--selftest'], { encoding: 'utf8', timeout: 15_000 });
    assert.equal(absent.status, 1);
    assert.match(absent.stderr, /自检失败/);
    mkdirSync(path.join(directory, 'tests'));
    const emptyDirectory = spawnSync(process.execPath, [script, '--selftest'], { encoding: 'utf8', timeout: 15_000 });
    assert.equal(emptyDirectory.status, 1);
    assert.match(emptyDirectory.stderr, /自检失败/);
    writeFileSync(path.join(directory, 'tests', 'test_ste_lint.mjs'), '\n');
    const emptySuite = spawnSync(process.execPath, [script, '--selftest'], { encoding: 'utf8', timeout: 15_000 });
    assert.equal(emptySuite.status, 1);
    assert.match(emptySuite.stderr, /自检失败/);
  });
});

test('CLI：自检和规则目录模式互斥', () => {
  for (const args of [['--selftest', '--list-rules'], ['--list-rules', '--selftest']]) {
    const result = runCli(args);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /不能同时使用/);
    assert.doesNotMatch(result.stderr, /Traceback/);
  }
});

test('CLI：操作模式拒绝 lint 参数，即使显式传入默认值', () => {
  const options = [['input.md'], ['--baseline', '0'], ['--baseline=0'], ['--disable', 'semicolon'],
    ['--disable=semicolon'], ['--text-type', 'description'], ['--text-type=description']];
  for (const operation of ['--selftest', '--list-rules']) {
    for (const option of options) {
      const result = runCli([operation, ...option]);
      assert.equal(result.status, 2, `${operation} ${option.join(' ')}`);
      assert.match(result.stderr, /不能与以下参数组合/);
      assert.equal(result.stdout, '');
      assert.doesNotMatch(result.stderr, /Traceback/);
    }
  }
  const result = runCli(['--selftest', '--json']);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /--json/);
});

test('CLI：main 可注入自检执行器以测试成功和失败码', async () => {
  let called = 0;
  assert.equal(await main(['--selftest'], async () => { called += 1; return true; }), 0);
  assert.equal(called, 1);
  assert.equal(await main(['--selftest'], async () => false), 1);
});

test('CLI：规则目录 JSON 和帮助使用中文', () => {
  let result = runCli(['--list-rules', '--json']);
  assert.equal(result.status, 0);
  const data = JSON.parse(result.stdout);
  assert.equal(data.schema_version, 1);
  assert.deepEqual(data.rules, RULES.map((rule) => rule.metadata()));
  result = runCli(['--list-rules']);
  assert.match(result.stdout, /启发式/);
  result = runCli(['--help']);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /用法：/);
  assert.match(result.stdout, /选项/);
  assert.doesNotMatch(result.stdout, /options:/);
});

test('CLI：支持短帮助、等号参数、选项终止符和参数交错', () => {
  assert.equal(runCli(['-h']).status, 0);
  withTemporaryDirectory((directory) => {
    const first = path.join(directory, 'first.md');
    const optionLike = path.join(directory, '--input.md');
    writeFileSync(first, 'Clear.', 'utf8');
    writeFileSync(optionLike, 'Bad;', 'utf8');
    let result = runCli(['--json', '--baseline=1', first, '--disable=semicolon']);
    assert.equal(result.status, 0);
    assert.equal(JSON.parse(result.stdout).count, 0);
    result = runCli(['--json', '--', optionLike]);
    assert.equal(result.status, 1);
    assert.equal(JSON.parse(result.stdout).hard_count, 1);
  });
});

test('CLI：每百词舍入与 Python round 的边界保持一致', () => {
  for (const [words, findings, expected] of [[2000, 23, 1.1], [400, 13, 3.2], [80, 1, 1.2]]) {
    const tokens = Array.from({ length: words }, (_, index) => index < findings ? 'word;.' : 'word.');
    const result = runCli(['--json'], tokens.join(' '));
    assert.equal(result.status, 1);
    const data = JSON.parse(result.stdout);
    assert.equal(data.words, words);
    assert.equal(data.hard_count, findings);
    assert.equal(data.per_100_words, expected);
  }
});

test('CLI：经符号链接运行时能找到技能根目录', () => {
  withTemporaryDirectory((directory) => {
    const linkedRoot = path.join(directory, 'skill-link');
    symlinkSync(ROOT, linkedRoot, 'dir');
    const result = spawnSync(process.execPath, [path.join(linkedRoot, 'scripts', 'ste-lint.mjs'), '--list-rules', '--json'],
      { encoding: 'utf8', timeout: 15_000 });
    assert.equal(result.status, 0, result.stderr);
    const data = JSON.parse(result.stdout);
    assert.equal(data.schema_version, 1);
    assert.deepEqual(data.rules, RULES.map((rule) => rule.metadata()));
  });
});

test('ESM：直接导入实现不会启动 CLI 或读取标准输入', () => {
  const result = spawnSync(process.execPath,
    ['--input-type=module', '-e', 'await import(process.argv[1])', pathToFileURL(SCRIPT).href],
    { input: Buffer.from([0xff]), encoding: 'utf8', timeout: 15_000 });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
});

test('语料：改写案例满足词数契约且没有硬性问题', () => {
  let fixtures = JSON.parse(readFileSync(path.join(ROOT, 'examples', 'fixtures.json'), 'utf8'));
  if (!Array.isArray(fixtures)) fixtures = fixtures.fixtures;
  assert.ok(fixtures.length > 0);
  const ids = new Set();
  for (const fixture of fixtures) {
    assert.ok(!ids.has(fixture.id), fixture.id);
    ids.add(fixture.id);
    assert.ok(['instruction', 'description'].includes(fixture.text_type));
    assert.ok(fixture.before.trim());
    assert.ok(fixture.after.trim());
    const [findings, words] = lint(fixture.after, '<fixture>', fixture.text_type);
    assert.ok(words > 0);
    assert.equal(lint(fixture.before, '<fixture>', fixture.text_type)[1], fixture.expected_before_words);
    assert.equal(words, fixture.expected_after_words);
    assert.deepEqual(fixture.after.split(/(?<=[.!?])\s+/u).map((part) => part.trim().split(/\s+/u).length),
      fixture.expected_after_sentence_words);
    assert.deepEqual(findings.filter((finding) => finding.level === 'advisory-free'), [], fixture.id);
  }
});

test('Unicode：非 BMP 字符按一个 Unicode 字符计算列号', () => {
  const findings = findingsFor('😀; text.', 'semicolon');
  assert.deepEqual([findings[0].line, findings[0].col], [1, 2]);
});

test('Unicode：Python 兼容空白字符切分词和规则边界', () => {
  const [findings, words] = lint('We have\u0085received report.');
  assert.equal(words, 4);
  assert.ok(findings.some((finding) => finding.rule === 'present-perfect'));
  assert.deepEqual(findingsFor('éhave received.', 'present-perfect'), []);
});

test('健壮性：长单行输入不会触发调用栈溢出', () => {
  assert.deepEqual(lint('x'.repeat(200_000)), [[], 1]);
});

test('句长：局部缩写检测保留 Unicode 词边界', () => {
  for (const abbreviation of ['Prof.', 'A.B.C.D.', 'İ.ſ.', '😀Prof.']) {
    assert.equal(findingsFor(`Use ${abbreviation} ${sentence(24)}`, 'long-sentence').length, 1, abbreviation);
  }
  for (const prefix of ['𐐀', 'é', '_', '9']) {
    assert.deepEqual(findingsFor(`${prefix}Prof. ${sentence(25)}`, 'long-sentence'), [], prefix);
    assert.deepEqual(findingsFor(`${prefix}U.S. ${sentence(25)}`, 'long-sentence'), [], prefix);
  }
});

test('性能：大量普通短句在有限运行时间内完成', () => {
  const source = `import { lint } from ${JSON.stringify(pathToFileURL(SCRIPT).href)};
    const [findings, words] = lint('Open. '.repeat(32_000));
    console.log(JSON.stringify({ findings: findings.length, words }));`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
    encoding: 'utf8', timeout: 10_000, maxBuffer: 1024 * 1024,
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { findings: 0, words: 32_000 });
});

test('CLI：UTF-8 BOM 和 CRLF 文件保留词数与原始列位置', () => {
  withTemporaryDirectory((directory) => {
    const file = path.join(directory, 'bom-crlf.md');
    writeFileSync(file, Buffer.from('\uFEFFa;\r\nb;', 'utf8'));
    const result = runCli(['--json', file]);
    assert.equal(result.status, 1);
    const data = JSON.parse(result.stdout);
    assert.equal(data.words, 2);
    const semicolons = data.violations.filter((finding) => finding.rule === 'semicolon');
    assert.deepEqual(semicolons.map(({ line, col }) => [line, col]), [[1, 3], [2, 2]]);
  });
});

test('自检：从外部目录和继承测试上下文运行时校验真实测试结果', () => {
  withTemporaryDirectory((directory) => {
    const skill = path.join(directory, 'installed-skill');
    const outside = path.join(directory, 'outside');
    const scripts = path.join(skill, 'scripts');
    const tests = path.join(skill, 'tests');
    mkdirSync(scripts, { recursive: true });
    mkdirSync(tests, { recursive: true });
    mkdirSync(outside);
    const copiedScript = path.join(scripts, 'ste-lint.mjs');
    const suite = path.join(tests, 'test_ste_lint.mjs');
    writeFileSync(copiedScript, readFileSync(SCRIPT));
    writeFileSync(path.join(scripts, 'run-tests.mjs'), readFileSync(TEST_RUNNER));
    const cases = [
      ['有效用例', "import test from 'node:test';\ntest('通过', () => {});\n", 0],
      ['全部跳过', "import test from 'node:test';\ntest.skip('跳过', () => {});\n", 1],
      ['TODO 用例', "import test from 'node:test';\ntest.todo('待实现');\n", 1],
      ['通过与跳过混合', "import test from 'node:test';\ntest('通过', () => {});\ntest.skip('跳过', () => {});\n", 1],
    ];
    for (const [name, source, expected] of cases) {
      writeFileSync(suite, source, 'utf8');
      const result = spawnSync(process.execPath, [copiedScript, '--selftest'], {
        cwd: outside,
        env: { ...process.env, NODE_TEST_CONTEXT: 'child-v8' },
        encoding: 'utf8',
        timeout: 20_000,
      });
      assert.equal(result.status, expected, `${name}: ${result.stderr}`);
      if (expected === 1) assert.match(result.stderr, /自检失败/);
      else assert.match(result.stdout, /1 项测试，1 项通过/);
    }
  });
});

test('CLI：基准值兼容正负零、分组下划线和 Unicode 十进制数字', () => {
  for (const [value, expected, status] of [['-0', 0, 1], ['+0', 0, 1], ['1_000', 1000, 0], ['+١_٢', 12, 0]]) {
    const result = runCli(['--json', '--baseline', value], 'Bad;');
    assert.equal(result.status, status, value);
    assert.equal(JSON.parse(result.stdout).baseline, expected, value);
  }
});

test('CLI：大基准 JSON 保留精确整数，负数和非法下划线拒绝', () => {
  for (const value of ['9007199254740993', '1' + '0'.repeat(100)]) {
    const result = runCli(['--json', `--baseline=${value}`], 'Bad;');
    assert.equal(result.status, 0, value);
    const rawBaseline = result.stdout.match(/"baseline"\s*:\s*(\d+)/u)?.[1];
    assert.equal(rawBaseline, value);
    assert.equal(JSON.parse(result.stdout).hard_count, 1);
  }
  for (const value of ['-1', '+_1', '1_', '1__0', '_1']) {
    const result = runCli(['--baseline', value], 'Clear.');
    assert.equal(result.status, 2, value);
    assert.match(result.stderr, /基准值必须为非负整数/);
    assert.doesNotMatch(result.stderr, /Traceback/);
  }
});

// —— 中文简明技术写作规范 ——

const zhSentence = (count, terminator = '。') => '汉'.repeat(count) + terminator;

test('中文：规则目录包含硬性与建议等级', () => {
  const [findings] = lint('检查；记录。', '<stdin>', 'description', null, 'zh');
  const levels = new Map(findings.map(({ rule, level }) => [rule, level]));
  assert.equal(levels.get('zh-semicolon'), 'advisory-free');
  const [mixed] = lint('我们进行检查并且这是无缝的极致方案，配置被修改了。众所周知，系统正常。', '<stdin>', 'description', null, 'zh');
  for (const rule of ['zh-multi-action', 'zh-nominalization', 'zh-marketing-adjective', 'zh-passive', 'zh-barrier-phrase']) {
    const hit = mixed.find((finding) => finding.rule === rule);
    assert.ok(hit, `缺少 ${rule}`);
    assert.equal(hit.level, 'advisory', rule);
  }
  assert.ok(RULES_ZH.every((registered) => typeof registered.checker === 'function'));
  assert.ok(RULES_ZH.every((registered) => registered.id.startsWith('zh-')));
});

test('中文：句长按字数和文本类型上限', () => {
  assert.deepEqual(findingsFor(zhSentence(30), 'zh-long-sentence', { language: 'zh' }), []);
  const long = findingsFor(zhSentence(31), 'zh-long-sentence', { language: 'zh' });
  assert.equal(long.length, 1);
  assert.equal(long[0].match, '31 字');
  assert.deepEqual(findingsFor(zhSentence(20), 'zh-long-sentence', { language: 'zh', textType: 'instruction' }), []);
  assert.equal(findingsFor(zhSentence(21), 'zh-long-sentence', { language: 'zh', textType: 'instruction' }).length, 1);
  assert.deepEqual(findingsFor(zhSentence(21), 'zh-long-sentence', { language: 'zh' }), []);
});

test('中文：汉字、西文词与标点的计数口径', () => {
  assert.equal(lint('配置 API 后重启。', '<stdin>', 'description', null, 'zh')[1], 6);
  assert.equal(lint('运行 `npm test` 后。', '<stdin>', 'description', null, 'zh')[1], 3);
  assert.equal(lint('检查；记录。', '<stdin>', 'description', null, 'zh')[1], 4);
  assert.equal(lint('𠮷𠮷。', '<stdin>', 'description', null, 'zh')[1], 2);
});

test('中文：分号和悬空连接词为硬性问题', () => {
  assert.equal(findingsFor('检查；记录。', 'zh-semicolon', { language: 'zh' })[0].level, 'advisory-free');
  const dangling = findingsFor('- 配置网络和\n- 记录结果或\n', 'zh-dangling-conjunction', { language: 'zh' });
  assert.equal(dangling.length, 2);
  assert.deepEqual([dangling[0].line, dangling[1].line], [1, 2]);
});

test('中文：连接词并列提示多动作', () => {
  assert.equal(findingsFor('打开文件并且保存结果。', 'zh-multi-action', { language: 'zh' }).length, 1);
  assert.deepEqual(findingsFor('打开文件，保存结果。', 'zh-multi-action', { language: 'zh' }), []);
});

test('中文：代码围栏与行内代码不参与检查', () => {
  assert.deepEqual(lint('```\n检查；const x = 1;\n```', '<stdin>', 'description', null, 'zh'), [[], 0]);
  assert.deepEqual(findingsFor('参数 `被包含` 保留。', 'zh-passive', { language: 'zh' }), []);
  assert.equal(findingsFor('配置被修改，参数 `--force` 保留。', 'zh-passive', { language: 'zh' }).length, 1);
});

test('CLI：--language zh 选择中文规则与字数上限', () => {
  const result = runCli(['--language', 'zh', '--json'], '检查；记录。');
  assert.equal(result.status, 1);
  const data = JSON.parse(result.stdout);
  assert.equal(data.language, 'zh');
  assert.equal(data.max_words, 30);
  assert.equal(data.hard_count, 1);
  assert.equal(data.violations[0].rule, 'zh-semicolon');
  assert.equal(data.words, 4);
});

test('CLI：--language zh 的规则目录与禁用规则', () => {
  let catalog = runCli(['--language', 'zh', '--list-rules', '--json']);
  assert.equal(catalog.status, 0);
  const data = JSON.parse(catalog.stdout);
  assert.equal(data.language, 'zh');
  assert.deepEqual(data.rules, RULES_ZH.map((rule) => rule.metadata()));
  catalog = runCli(['--language', 'zh', '--json', '--disable', 'zh-passive'], '配置被修改了。');
  assert.equal(catalog.status, 0);
  assert.equal(JSON.parse(catalog.stdout).count, 0);
  assert.equal(runCli(['--language', 'zh', '--disable', 'semicolon'], 'Clear.').status, 0);
  const unknown = runCli(['--language', 'zh', '--disable', 'nope'], 'Clear.');
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /未知规则 ID/);
});

test('CLI：无效语言和自检携带语言被拒绝', () => {
  const invalid = runCli(['--language', 'fr'], 'Clear.');
  assert.equal(invalid.status, 2);
  assert.match(invalid.stderr, /--language/);
  const selftest = runCli(['--selftest', '--language', 'zh']);
  assert.equal(selftest.status, 2);
  assert.match(selftest.stderr, /不能与以下参数组合/);
});

test('中文：列表化提示三个或更多要求', () => {
  const findings = findingsFor('必须启动服务。应当记录日志。可以重试请求。', 'zh-list-required', { language: 'zh' });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].match, '3 项要求');
  assert.equal(findings[0].level, 'advisory');
  assert.deepEqual(findingsFor('必须启动服务。可以记录日志。', 'zh-list-required', { language: 'zh' }), []);
});

test('中文：段落主题超过六句时提示分段', () => {
  const sentences = (count) => Array.from({ length: count }, (_, index) => `第${index + 1}项完成。`).join('');
  assert.deepEqual(findingsFor(sentences(6), 'zh-paragraph-topic', { language: 'zh' }), []);
  const findings = findingsFor(sentences(7), 'zh-paragraph-topic', { language: 'zh' });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].match, '7 句');
});

test('中文：近义词轮换提示术语一致', () => {
  const findings = findingsFor('先检查配置，再核查结果。', 'zh-synonym-rotation', { language: 'zh' });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].match, '核查');
  assert.deepEqual(findingsFor('先检查配置。', 'zh-synonym-rotation', { language: 'zh' }), []);
  assert.deepEqual(findingsFor('先检查配置，再 `核查` 结果。', 'zh-synonym-rotation', { language: 'zh' }), []);
});
