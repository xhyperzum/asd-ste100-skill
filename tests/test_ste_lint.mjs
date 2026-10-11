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

test('性能：重复 only 的无 have 坏路径在子进程超时内结束', () => {
  for (const count of [40, 40_000]) {
    for (const disabled of [[], ['--disable', 'present-perfect']]) {
      const result = spawnSync(process.execPath, [SCRIPT, '--json', ...disabled], {
        input: `may${' only'.repeat(count)}`,
        encoding: 'utf8',
        timeout: 5_000,
        killSignal: 'SIGKILL',
      });
      assert.ifError(result.error);
      assert.equal(result.signal, null);
      assert.equal(result.status, 1);
      const report = JSON.parse(result.stdout);
      assert.equal(report.words, count + 1);
      assert.equal(report.violations.filter(finding => finding.rule === 'present-perfect').length, 0);
      assert.equal(report.violations.filter(finding => finding.rule === 'long-sentence').length, 1);
    }
  }
});

test('规则：情态完成式保留旧版 288 组前缀范围', () => {
  const oldModalEnd = /\b(?:may|might|could|should|would|must|can|will|shall)(?:n't)?(?:\s+(?:not|never|also|already|just|only|even|still|yet|ever|well|perhaps|\w+ly))*\s*$/i;
  const rules = RULES.filter(rule => rule.id === 'present-perfect');
  let checked = 0;
  for (const modal of ['may', 'might', 'could', 'should', 'would', 'must', 'can', 'will', 'shall']) {
    for (const tail of ['', 'not ', 'never also ', 'already just only even still yet ever well perhaps ',
      'probably '.repeat(100), 'wrong ', '`not` ', 'not, ']) {
      for (const auxiliary of ['have', 'has', 'had', 'HAVE']) {
        const text = `It ${modal} ${tail}${auxiliary} failed. We have received.`;
        const expected = [...text.matchAll(/\b(has|have|had)\s+(?:been\s+)?\w+(?:ed|en)\b/gi)]
          .filter(match => match[1].toLowerCase() !== 'have' || !oldModalEnd.test(text.slice(0, match.index)))
          .map(match => [1, match.index + 1]);
        const actual = lint(text, '<stdin>', 'instruction', rules)[0].map(finding => [finding.line, finding.col]);
        assert.deepEqual(actual, expected, text);
        checked += 1;
      }
    }
  }
  assert.equal(checked, 288);
});

test('Markdown：列表内标题和分隔块按内容相对缩进且保留归属', () => {
  assert.equal(lint('- a\n\n    ---')[1], 1);
  for (const underline of ['-', '--', '---', '=']) {
    const text = `1.  x and\n    ${underline}`;
    assert.equal(lint(text)[1], 2, text);
    assert.equal(findingsFor(text, 'dangling-conjunction').length, 1, text);
  }
  assert.deepEqual(findingsFor('- a and\n  # b', 'dangling-conjunction'), []);
  const dangling = findingsFor('- a\n  # b and', 'dangling-conjunction');
  assert.equal(dangling.length, 1);
  assert.deepEqual([dangling[0].line, dangling[0].col], [2, 7]);
  assert.equal(lint('#\tA')[1], 1);
  for (const prefix of ['     ', '\t ']) {
    const text = `100. x\n${prefix}#\tb;`;
    assert.equal(lint(text)[1], 2);
    const semicolon = findingsFor(text, 'semicolon');
    assert.deepEqual(semicolon.map(finding => [finding.line, finding.col]), [[2, prefix.length + 4]]);
  }
  for (const code of ['# b and;', '--', '---']) {
    const text = `- a\n\n      ${code}`;
    assert.equal(lint(text)[1], 1, text);
    assert.deepEqual(findingsFor(text, 'semicolon'), []);
    assert.deepEqual(findingsFor(text, 'dangling-conjunction'), []);
  }
  assert.equal(lint('    # A')[1], 0);
  assert.equal(lint('===')[1], 1);
});

test('Markdown：表格分隔单元格只去除 ASCII 空格和 Tab', () => {
  for (const space of ['\u00a0', '\u3000', '\u001f']) {
    for (const [separator, words] of [[`-${space}|-`, 8], [`-|-${space}`, 7]]) {
      const text = `a | b\n${separator}\nc | d`;
      assert.equal(lint(text)[1], words, text);
    }
  }
  assert.equal(lint('a|b\n - \t|\t-\t\nc|d')[1], 4);
  const text = '| 😀a | b; |\n| - | - |\n| c | d |';
  assert.equal(lint(text)[1], 4);
  assert.deepEqual(findingsFor(text, 'semicolon').map(finding => [finding.line, finding.col]), [[1, 9]]);
});

test('Markdown：表格内外竖线的反斜杠转义按奇偶匹配', () => {
  for (const count of [1, 2, 3, 4]) {
    const slashes = '\\'.repeat(count);
    const separator = count % 2 ? '|-|\n|c|' : '|-|-|\n|c|d|';
    const text = `| a ${slashes}| b; |\n${separator}`;
    assert.equal(lint(text)[1], count % 2 ? 4 : 5, text);
    assert.deepEqual(findingsFor(text, 'semicolon').map(finding => [finding.line, finding.col]), [[1, count + 8]]);
    assert.equal(lint(`| a${slashes}|\n|-|\n|c|`)[1], 2);
  }
  assert.equal(lint('a \\\\| b\n-|-\nc | d')[1], 5);
  assert.equal(lint('| `a|b` | c |\n|-|-|\n| d | e |')[1], 3);
});

test('Markdown：相对分隔块优先于列表标记且不丢失条目归属', () => {
  for (const indent of ['  ', '   ', '    ', '     ', '\t']) {
    for (const separator of ['- - -', '* * *', '_ _ _', '***']) {
      const text = `- a\n${indent}${separator}\n  b and`;
      const findings = findingsFor(text, 'dangling-conjunction');
      assert.equal(findings.length, 1, text);
      assert.deepEqual([findings[0].line, findings[0].col], [3, 5]);
      assert.equal(lint(text)[1], 3);
    }
    for (const underline of ['- ', '-\t', '-- ']) {
      const text = `- x and\n${indent}${underline}\n  z`;
      assert.deepEqual(findingsFor(text, 'dangling-conjunction'), [], text);
      assert.equal(lint(text)[1], 3);
    }
  }
  assert.deepEqual(findingsFor('- a\n- - -\nb and', 'dangling-conjunction'), []);
  assert.equal(findingsFor('- a\n- b and', 'dangling-conjunction').length, 1);
  assert.equal(lint('- a\n\n      - - -\n  b')[1], 2);
  for (const [text, status] of [['- a\n  - - -\n  b and', 1], ['- x and\n  - \n  z', 0]]) {
    const result = runCli(['--json'], text);
    assert.ifError(result.error);
    assert.equal(result.status, status);
  }
});

test('Markdown：表格预读不吞列表标记且保留正常短分隔行', () => {
  for (const text of ['| a |\n- |\n  c and', '- x\n  | a |\n  - |\n    c and']) {
    const findings = findingsFor(text, 'dangling-conjunction');
    assert.equal(findings.length, 1, text);
    assert.equal(findings[0].match, '| c and');
    const result = runCli(['--json'], text);
    assert.ifError(result.error);
    assert.equal(result.status, 1);
  }
  assert.equal(lint('| a |\n- |\n  c and')[1], 6);
  for (const separator of ['|-|-|', '-|-', ':-: | :-:']) {
    assert.equal(lint(`| a | b |\n${separator}\n| c | d |`)[1], 4, separator);
    assert.equal(lint(`- x\n  | a | b |\n  ${separator}\n  | c | d |`)[1], 5, separator);
  }
  assert.equal(lint('- x\n  | a | b |\n|-|-|\n| c | d |')[1], 12);
});

test('中文：扩展平面字符按码点判断连续串且保留汉字与小数口径', () => {
  const cases = [['𝐀B', 1], ['𝟏𝟐', 1], ['A𝐁𝟏', 1], ['𝐀\u0301B', 1],
    ['𠀀A', 2], ['A𠀀', 2], ['𠀀𠀁', 2], ['𠀀𝐀B', 2],
    ['12', 1], ['A12', 1], ['1.25', 1], ['v2.1.3', 1], ['𝟏.𝟐', 1]];
  for (const [text, words] of cases) {
    assert.equal(lint(text, '<stdin>', 'description', null, 'zh')[1], words, text);
  }
  for (const text of ['𝐀B', '𝟏𝟐', '𠀀A']) {
    const result = runCli(['--language', 'zh', '--json'], text);
    assert.ifError(result.error);
    assert.equal(result.status, 0);
    assert.equal(JSON.parse(result.stdout).words, text === '𠀀A' ? 2 : 1);
  }
  const position = findingsFor('𝐀B;', 'zh-semicolon', { language: 'zh' });
  assert.deepEqual(position.map(finding => [finding.line, finding.col]), [[1, 3]]);
});

test('中文：汉字变体选择符不重复计字且保留西文边界与源位置', () => {
  const cases = [['丸\uFE00'.repeat(16), 16], ['丸\uFE00A', 2], ['A丸\uFE00B', 3],
    ['𠀀\uFE00𠀁', 2], ['𠀀\u{E0100}A', 2], ['丸\u{E01EF}A', 2],
    ['A\u0301B', 1], ['𝐀\u0301B', 1], ['A\uFE00B', 1], ['𝐀\u{E0100}B', 1],
    ['丸\u0301', 2], ['\uFE00', 1]];
  for (const [text, words] of cases) {
    assert.equal(lint(text, '<stdin>', 'description', null, 'zh')[1], words, text);
  }
  const result = runCli(['--language', 'zh', '--json'], '丸\uFE00'.repeat(16));
  assert.ifError(result.error);
  assert.equal(result.status, 0);
  const report = JSON.parse(result.stdout);
  assert.equal(report.words, 16);
  assert.equal(report.hard_count, 0);
  assert.ok(!report.violations.some(finding => finding.rule === 'zh-long-sentence'));
  const positions = findingsFor('丸\uFE00;\n𠀀\u{E0100};', 'zh-semicolon', { language: 'zh' });
  assert.deepEqual(positions.map(finding => [finding.line, finding.col]), [[1, 3], [2, 3]]);
  const long = findingsFor(`😀 ${'丸\uFE00'.repeat(31)}。`, 'zh-long-sentence', { language: 'zh' });
  assert.equal(long.length, 1);
  assert.deepEqual([long[0].line, long[0].col], [1, 3]);
  assert.equal(long[0].match, '31 字');
});

test('中文：Unicode 十进制数字的小数连接不扩大到字母和其他数字类别', () => {
  const cases = [['𝟏.𝟐', 1], ['１２.３', 1], ['1.𝟐', 1], ['𝟏.2', 1], ['１.2', 1],
    ['1.２', 1], ['١.٢', 1], ['१२.३', 1], ['3.14', 1], ['v2.1.3', 1],
    ['𝐀.𝐁', 2], ['𝐀.𝟐', 2], ['𝟏.𝐁', 2], ['①.②', 2], ['Ⅳ.Ⅴ', 2], ['².³', 2],
    ['一.二', 2], ['𝟏．𝟐', 2], ['1..2', 2], ['1 .2', 2], ['𝟏. 𝟐', 2], ['# 1. 2', 2],
    ['.', 0], ['. .', 0], ['.𝟏', 1], ['𝟏.', 1]];
  for (const [text, words] of cases) {
    assert.equal(lint(text, '<stdin>', 'description', null, 'zh')[1], words, text);
  }
  for (const text of ['𝟏.𝟐', '１２.３', '1.𝟐', '𝟏.2', '𝐀.𝐁']) {
    const result = runCli(['--language', 'zh', '--json'], text);
    assert.ifError(result.error);
    assert.equal(result.status, 0);
    assert.equal(JSON.parse(result.stdout).words, text === '𝐀.𝐁' ? 2 : 1);
  }
  const positions = findingsFor('😀 𝟏.𝟐;\n１２.３;', 'zh-semicolon', { language: 'zh' });
  assert.deepEqual(positions.map(finding => [finding.line, finding.col]), [[1, 6], [2, 5]]);
  const long = findingsFor(`😀 ${'𝟏.𝟐 '.repeat(21)}。`, 'zh-long-sentence', {
    language: 'zh', textType: 'instruction',
  });
  assert.equal(long.length, 1);
  assert.deepEqual([long[0].line, long[0].col], [1, 3]);
  assert.match(long[0].match, /21/u);
});

test('性能：中文扩展平面小数只读取固定长度前字符窗口', () => {
  const text = '𝟏.𝟐 '.repeat(32_000);
  const started = process.cpuUsage();
  assert.equal(lint(text, '<stdin>', 'description', [], 'zh')[1], 32_000);
  const elapsed = process.cpuUsage(started);
  assert.ok(elapsed.user + elapsed.system < 4_000_000, '中文小数计数 CPU 时间超过四秒宽阈值');
});

test('性能：中文扩展平面计数不重复扫描全文前缀', () => {
  const text = '𠀀𝐀B'.repeat(32_000);
  const started = process.cpuUsage();
  assert.equal(lint(text, '<stdin>', 'description', [], 'zh')[1], 64_000);
  const elapsed = process.cpuUsage(started);
  assert.ok(elapsed.user + elapsed.system < 4_000_000, '中文计数 CPU 时间超过四秒宽阈值');
});

test('Markdown：ASCII 空列表正文不打开段落但保留条目容器', () => {
  for (const marker of ['- ', '+ \t', '1. ']) {
    const text = `${marker}\n          a;b`;
    assert.deepEqual(lint(text), [[], 0], text);
    assert.equal(lint(`${marker}\n  ===`)[1], 1, marker);
  }
  const continuation = findingsFor('- \n  a and', 'dangling-conjunction');
  assert.equal(continuation.length, 1);
  assert.equal(continuation[0].match, 'a and');
  for (const whitespace of ['\u00a0', '\u3000', '\u001f']) {
    const text = `- ${whitespace}\n          a;b`;
    assert.equal(lint(text)[1], 1);
    assert.deepEqual(findingsFor(text, 'semicolon').map(finding => [finding.line, finding.col]), [[2, 12]]);
    assert.equal(lint(`- ${whitespace}\n  ===`)[1], 0);
  }
  assert.deepEqual(lint('- \n\n      a;b'), [[], 0]);
  assert.equal(lint('- \n  first\n  ===')[1], 1);
  for (const [text, words] of [['- \n          a;b', 0], ['- \n  ===', 1]]) {
    const result = runCli(['--json'], text);
    assert.ifError(result.error);
    assert.equal(result.status, 0);
    assert.equal(JSON.parse(result.stdout).words, words);
  }
});

test('Markdown：活动表格结束后深缩进行不能复用为新表头', () => {
  const mismatch = 'a|b\n-|-\n    c;d|e|f\n-|-|-';
  assert.deepEqual(lint(mismatch), [[], 3]);
  const matched = 'a|b\n-|-\n    c;d|e\n-|-|-';
  assert.equal(lint(matched)[1], 5);
  assert.deepEqual(findingsFor(matched, 'semicolon').map(finding => [finding.line, finding.col]), [[3, 6]]);
  const normalHeader = 'a|b\n-|-\nc;d|e|f\n-|-|-';
  assert.equal(lint(normalHeader)[1], 5);
  assert.deepEqual(findingsFor(normalHeader, 'semicolon').map(finding => [finding.line, finding.col]), [[3, 2]]);
  const listed = '- x\n  a|b\n  -|-\n      c;d|e|f\n  -|-|-';
  assert.deepEqual(findingsFor(listed, 'semicolon'), []);
  const result = runCli(['--json'], mismatch);
  assert.ifError(result.error);
  assert.equal(result.status, 0);
  assert.equal(JSON.parse(result.stdout).words, 3);
});

test('Unicode：完整既有行界集合按逻辑行定位和划分空行', () => {
  const boundaries = ['\r\n', '\n', '\r', '\v', '\f', '\u001c', '\u001d', '\u001e',
    '\u0085', '\u2028', '\u2029'];
  const half = Array(13).fill('word').join(' ');
  for (const boundary of boundaries) {
    const text = `😀a${boundary} b;`;
    assert.equal(lint(text)[1], 2, JSON.stringify(boundary));
    assert.deepEqual(findingsFor(text, 'semicolon').map(finding => [finding.line, finding.col]), [[2, 3]]);
    assert.deepEqual(lint(`${half}${boundary}${boundary}${half}`), [[], 26]);
    assert.deepEqual(findingsFor(`${half}${boundary}${half}`, 'long-sentence')
      .map(finding => [finding.line, finding.col]), [[1, 1]]);
    const fence = `\`\`\`${boundary}bad;${boundary}\`\`\`${boundary}okay;`;
    assert.deepEqual(findingsFor(fence, 'semicolon').map(finding => [finding.line, finding.col]), [[4, 5]]);
  }
  for (const boundary of ['\r\n', '\u2028']) {
    const result = runCli(['--json'], `a${boundary}b;`);
    assert.ifError(result.error);
    assert.equal(result.status, 1);
    assert.deepEqual(JSON.parse(result.stdout).violations
      .filter(finding => finding.rule === 'semicolon').map(finding => [finding.line, finding.col]), [[2, 2]]);
  }
  assert.deepEqual(findingsFor('- a\u2028- b and', 'dangling-conjunction')
    .map(finding => [finding.line, finding.col]), [[2, 1]]);
});

test('既有口径：列表标记范围、悬空定位与英文非空白片段计数', () => {
  assert.deepEqual(findingsFor('-     a;b', 'semicolon')
    .map(finding => [finding.line, finding.col]), [[1, 8]]);
  assert.equal(lint('123456789012345. a and')[1], 2);
  assert.deepEqual(findingsFor('123456789012345. a and', 'dangling-conjunction')
    .map(finding => [finding.line, finding.col]), [[1, 1]]);
  assert.deepEqual(findingsFor('- a and', 'dangling-conjunction')
    .map(finding => [finding.line, finding.col]), [[1, 1]]);
  assert.deepEqual(findingsFor('- a\n  b and', 'dangling-conjunction')
    .map(finding => [finding.line, finding.col]), [[2, 5]]);
  for (const text of ['-', '===', 'a;b']) assert.equal(lint(text)[1], 1, text);
  assert.equal(lint('a ; b')[1], 3);
});

test('Markdown：Setext 不跨旧列表容器吞掉新空条目', () => {
  const text = '- a\n- \n  b and';
  assert.equal(lint(text)[1], 3);
  assert.deepEqual(findingsFor(text, 'dangling-conjunction')
    .map(finding => [finding.line, finding.col]), [[3, 5]]);
  assert.deepEqual(findingsFor('- a and\n- \n  b and', 'dangling-conjunction')
    .map(finding => [finding.line, finding.col]), [[1, 1], [3, 5]]);
  assert.deepEqual(findingsFor('- a\n- \n  b;', 'semicolon')
    .map(finding => [finding.line, finding.col]), [[3, 4]]);
  assert.equal(lint('heading\n- ')[1], 1);
  assert.deepEqual(findingsFor('- x and\n  - \n  z', 'dangling-conjunction'), []);
  assert.equal(lint('- x\n  ===')[1], 1);
  assert.equal(lint('- x\n===')[1], 2);
  const result = runCli(['--json'], text);
  assert.ifError(result.error);
  assert.equal(result.status, 1);
});

test('Markdown：ASCII 空条目缩进宽度不随行尾空格和 Tab 改变', () => {
  for (const tail of [' ', '  ', '     ', ' \t', '  \t \t']) {
    for (const [marker, indent] of [['-', 2], ['1.', 3], ['30)', 4]]) {
      const text = `${marker}${tail}\n${' '.repeat(indent)}b and`;
      assert.deepEqual(findingsFor(text, 'dangling-conjunction')
        .map(finding => [finding.line, finding.col]), [[2, indent + 3]], text);
      assert.equal(lint(text)[1], 2);
      assert.deepEqual(lint(`${marker}${tail}\n${' '.repeat(indent + 4)}a;b`), [[], 0]);
    }
  }
  assert.deepEqual(findingsFor(' -  \n   b and', 'dangling-conjunction')
    .map(finding => [finding.line, finding.col]), [[2, 6]]);
  for (const body of ['a', '\u00a0', '\u3000']) {
    assert.deepEqual(findingsFor(`-     ${body}\n  b and`, 'dangling-conjunction'), []);
    assert.deepEqual(findingsFor(`-     ${body}\n      b and`, 'dangling-conjunction')
      .map(finding => [finding.line, finding.col]), [[2, 9]]);
  }
  assert.deepEqual(findingsFor('-     a;b', 'semicolon')
    .map(finding => [finding.line, finding.col]), [[1, 8]]);
  const result = runCli(['--json'], '-  \n  b and');
  assert.ifError(result.error);
  assert.equal(result.status, 1);
});

test('中文：悬空连词尾部使用 Python 兼容空白且不吞 BOM', () => {
  for (const conjunction of ['和', '或', '以及', '并且', '或者', '同时']) {
    for (const whitespace of [' ', '\t', '\u001f', '\u00a0', '\u3000']) {
      const text = `- 甲${conjunction}${whitespace}`;
      const findings = findingsFor(text, 'zh-dangling-conjunction', { language: 'zh' });
      assert.equal(findings.length, 1, text);
      assert.equal(findings[0].level, 'advisory');
      assert.deepEqual([findings[0].line, findings[0].col], [1, 1]);
    }
    assert.deepEqual(findingsFor(`- 甲${conjunction}\ufeff`, 'zh-dangling-conjunction', { language: 'zh' }), []);
  }
  assert.equal(findingsFor('- a and\u001f', 'dangling-conjunction').length, 1);
  assert.deepEqual(findingsFor('- a and\ufeff', 'dangling-conjunction'), []);
  assert.deepEqual(findingsFor('\ufeff甲;', 'zh-semicolon', { language: 'zh' })
    .map(finding => [finding.line, finding.col]), [[1, 3]]);
  for (const [tail, count] of [['\u001f', 1], ['\ufeff', 0]]) {
    const result = runCli(['--language', 'zh', '--json'], `- 甲和${tail}`);
    assert.ifError(result.error);
    assert.equal(result.status, 0);
    assert.equal(JSON.parse(result.stdout).violations
      .filter(finding => finding.rule === 'zh-dangling-conjunction').length, count);
  }
});

test('Markdown：空表格单元格不覆盖列表末条有效内容而代码操作数仍有效', () => {
  const header = '- x\n  | a | b |\n  |---|---|';
  for (const blank of ['', ' ', '\t', '\u00a0', '\u3000', '\u001f']) {
    const text = `${header}\n  | c or | ${blank} |`;
    assert.equal(lint(text)[1], 5);
    assert.deepEqual(findingsFor(text, 'dangling-conjunction')
      .map(finding => [finding.line, finding.col]), [[4, 7]], text);
    const firstBlank = `${header}\n  | ${blank} | c or |`;
    const expectedColumn = [...`  | ${blank} | c `].length + 1;
    assert.deepEqual(findingsFor(firstBlank, 'dangling-conjunction')
      .map(finding => [finding.line, finding.col]), [[4, expectedColumn]]);
    assert.equal(lint(`${text}\n  | ${blank} | ${blank} |`)[1], 5);
    assert.equal(findingsFor(`${text}\n  | ${blank} | ${blank} |`, 'dangling-conjunction').length, 1);
    assert.deepEqual(findingsFor(`${header}\n  | done | ${blank} |`, 'dangling-conjunction'), []);
  }
  for (const cell of ['`ok`', ' \u3000`ok`\u00a0 ', '\ufeff', 'done']) {
    const text = `${header}\n  | a and | ${cell} |`;
    assert.deepEqual(findingsFor(text, 'dangling-conjunction'), [], text);
    assert.equal(lint(text)[1], cell.includes('`') ? 5 : 6);
  }
  const positioned = `${header}\n  | 😀c or | |`;
  assert.deepEqual(findingsFor(positioned, 'dangling-conjunction')
    .map(finding => [finding.line, finding.col]), [[4, 8]]);
  assert.deepEqual(findingsFor('- x and\n  | | |\n  |-|-|\n  | | |', 'dangling-conjunction')
    .map(finding => [finding.line, finding.col]), [[1, 1]]);
  const result = runCli(['--json'], `${header}\n  | c or | |`);
  assert.ifError(result.error);
  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stdout).words, 5);
});

test('Markdown：列表已识别后同行 ATX 和水平线正文不再次识别为块', () => {
  assert.equal(lint('- # Foo bar')[1], 3);
  assert.equal(lint('- ***')[1], 1);
  assert.equal(lint('- ```bash')[1], 1);
  assert.equal(lint('- \n  # Foo bar')[1], 2);
  assert.equal(lint('- \n  ***')[1], 0);
  assert.equal(lint('- \n  ```bash\n  bad;\n  ```')[1], 0);
  assert.deepEqual(findingsFor('- # a and', 'dangling-conjunction')
    .map(finding => [finding.line, finding.col]), [[1, 1]]);
  assert.deepEqual(findingsFor('- \n  # a and', 'dangling-conjunction')
    .map(finding => [finding.line, finding.col]), [[2, 7]]);
});

test('Markdown：非行界 Unicode 空白仍受列表容器缩进约束', () => {
  const half = Array(13).fill('word').join(' ');
  for (const blank of ['\u3000', '\u00a0', '\u001f']) {
    const unindented = `- foo\n${blank}\n  bar and`;
    assert.equal(lint(unindented)[1], 3);
    assert.deepEqual(findingsFor(unindented, 'dangling-conjunction'), []);
    for (const indent of ['  ', '\t']) {
      const indented = `- foo\n${indent}${blank}\n  bar and`;
      assert.equal(lint(indented)[1], 3);
      assert.deepEqual(findingsFor(indented, 'dangling-conjunction')
        .map(finding => [finding.line, finding.col]), [[3, 7]]);
    }
    assert.equal(lint(`${half}\n${blank}\n${half}`)[1], 26);
    assert.deepEqual(findingsFor(`${half}\n${blank}\n${half}`, 'long-sentence')
      .map(finding => [finding.line, finding.col]), [[1, 1]]);
  }
});

test('文档契约：列表标记同行 pipe 表头按普通文本而另起行支持表格', () => {
  const inline = '- | a | b |\n  |-|-|\n  | c | d |';
  const separate = '- \n  | a | b |\n  |-|-|\n  | c | d |';
  assert.deepEqual(lint(inline), [[], 11]);
  assert.deepEqual(lint(separate), [[], 4]);
  assert.equal(lint('- | `a` | b |\n  |-|-|\n  | c | d |')[1], 10);
  assert.deepEqual(lint('- - -'), [[], 0]);
  assert.equal(lint('- ***')[1], 1);
  assert.equal(lint('- # Foo bar')[1], 3);
  for (const text of [inline.replace('c |', 'c; |'), separate.replace('c |', 'c; |')]) {
    assert.deepEqual(findingsFor(text, 'semicolon').map(finding => [finding.line, finding.col]),
      [[text.startsWith('- \n') ? 4 : 3, 6]]);
  }
});

test('文档契约：Unicode 空白可打开语法段落但不是末条有效内容', () => {
  for (const blank of ['\u00a0', '\u3000', '\u001f', ' \u3000\t']) {
    assert.deepEqual(lint(`${blank}\n===`), [[], 0]);
    assert.deepEqual(lint(`- \n  ${blank}\n  ===`), [[], 0]);
    const text = `- x and\n\n  ${blank}\n  ===`;
    assert.equal(lint(text)[1], 2);
    assert.deepEqual(findingsFor(text, 'dangling-conjunction')
      .map(finding => [finding.line, finding.col]), [[1, 1]]);
  }
  for (const blank of ['', ' ', '\t', ' \t ']) {
    assert.deepEqual(lint(`${blank}\n===`), [[], 1]);
    assert.deepEqual(lint(`- \n  ${blank}\n  ===`), [[], 1]);
  }
  assert.deepEqual(lint('- \n  ==='), [[], 1]);
  assert.deepEqual(lint('\u00a0'), [[], 0]);
  for (const [text, words] of [['\u00a0\n===', 0], ['- \n  \u00a0\n  ===', 0], ['- \n  ===', 1]]) {
    const result = runCli(['--json'], text);
    assert.ifError(result.error);
    assert.equal(result.status, 0);
    assert.equal(JSON.parse(result.stdout).words, words);
  }
});

test('Markdown：去缩进退出列表先结束旧段落再识别顶层代码', () => {
  for (const [start, contentIndent] of [['123. a', 5], ['-    a', 5], ['30)  a', 5], ['  123. a', 7]]) {
    const outsideCode = `${start}\n${' '.repeat(contentIndent - 1)}hidden;`;
    assert.deepEqual(lint(outsideCode), [[], 1], outsideCode);
    const outsideProse = `${start}\n   hidden;`;
    assert.equal(lint(outsideProse)[1], 2);
    assert.deepEqual(findingsFor(outsideProse, 'semicolon').map(finding => [finding.line, finding.col]), [[2, 10]]);
    for (const width of [contentIndent, contentIndent + 4]) {
      const continued = `${start}\n${' '.repeat(width)}hidden;`;
      assert.equal(lint(continued)[1], 2);
      assert.deepEqual(findingsFor(continued, 'semicolon').map(finding => [finding.line, finding.col]), [[2, width + 7]]);
    }
    assert.deepEqual(lint(`${start}\n\n${' '.repeat(contentIndent + 4)}hidden;`), [[], 1]);
    assert.deepEqual(lint(`${start}\n\n    hidden;`), [[], 1]);
  }
  for (const indent of ['    ', '          ', '\t']) {
    const body = '😀hidden;';
    const text = `plain\n${indent}${body}`;
    assert.equal(lint(text)[1], 2);
    assert.deepEqual(findingsFor(text, 'semicolon').map(finding => [finding.line, finding.col]),
      [[2, [...`${indent}${body}`].length]]);
  }
  assert.deepEqual(lint('123. 😀a\n\t😀hidden;'), [[], 1]);
  const continued = '123. 😀a\n\t 😀visible;';
  assert.equal(lint(continued)[1], 2);
  assert.deepEqual(findingsFor(continued, 'semicolon').map(finding => [finding.line, finding.col]), [[2, 11]]);
  assert.deepEqual(findingsFor('123. 😀a;\n    hidden;', 'semicolon')
    .map(finding => [finding.line, finding.col]), [[1, 8]]);
  const dangling = '123. a and\n    hidden;';
  assert.equal(lint(dangling)[1], 2);
  assert.deepEqual(findingsFor(dangling, 'semicolon'), []);
  assert.deepEqual(findingsFor(dangling, 'dangling-conjunction')
    .map(finding => [finding.line, finding.col]), [[1, 1]]);
  for (const text of ['123. a\n    hidden;', '-    a\n    hidden;']) {
    const result = runCli(['--json'], text);
    assert.ifError(result.error);
    assert.equal(result.status, 0);
    assert.equal(JSON.parse(result.stdout).words, 1);
  }
});

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

test('规则：情态完成式保护不限前缀长度且不跨越普通词或代码', () => {
  const prefix = `😀 It might ${'probably still perhaps '.repeat(8_000)}`;
  const text = `${prefix}have failed. We have received.`;
  const findings = findingsFor(text, 'present-perfect');
  assert.equal(findings.length, 1);
  assert.deepEqual([findings[0].line, findings[0].col],
    [1, [...text.slice(0, text.lastIndexOf('have'))].length + 1]);
  for (const tail of ['truly not', 'not never also already just only even still yet ever well perhaps', 'İncredibly']) {
    assert.deepEqual(findingsFor(`It could ${tail} have failed.`, 'present-perfect'), [], tail);
  }
  for (const text of ['It may fail and we have received.', 'It may `not` have failed.',
    'It may have failed. It has failed. It had failed.']) {
    assert.equal(findingsFor(text, 'present-perfect').length, text.includes('had') ? 2 : 1, text);
  }
});

test('性能：密集普通和情态完成式不重复扫描正文前缀', () => {
  const repetitions = 32_000;
  const rules = RULES.filter(({ id }) => id === 'present-perfect');
  for (const [fragment, expectedCount, wordsPerFragment] of [
    ['We have received. ', repetitions, 3], ['It might not have failed. ', 0, 5],
  ]) {
    const text = fragment.repeat(repetitions);
    const started = process.cpuUsage();
    const [findings, words] = lint(text, undefined, undefined, rules);
    const elapsed = process.cpuUsage(started);
    assert.ok(elapsed.user + elapsed.system < 4_000_000, '完成式处理超过 4 秒 CPU 预算');
    assert.equal(findings.length, expectedCount);
    assert.equal(words, repetitions * wordsPerFragment);
    if (findings.length) {
      assert.deepEqual([findings[0].line, findings[0].col], [1, 4]);
      assert.deepEqual([findings.at(-1).line, findings.at(-1).col],
        [1, (repetitions - 1) * fragment.length + 4]);
    }
  }
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

test('Markdown：段落中的空格和 Tab 续行不能规避句长', () => {
  for (const indent of ['    ', '\t']) {
    const [findings, words] = lint(`${sentence(10).slice(0, -1)}\n${indent}${sentence(16)}`);
    assert.equal(words, 26);
    const long = findings.filter(({ rule }) => rule === 'long-sentence');
    assert.equal(long.length, 1);
    assert.deepEqual([long[0].line, long[0].col], [1, 1]);
    assert.deepEqual(lint(`${sentence(10)}\n\n${indent}${sentence(16)}`), [[], 10]);
    assert.deepEqual(findingsFor(`Clear\n${indent}bad;`, 'semicolon')
      .map(({ line, col }) => [line, col]), [[2, indent.length + 4]]);
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

test('Markdown：反引号开启转义按反斜杠奇偶处理', () => {
  for (const count of [1, 2, 3, 4]) {
    const text = `😀 ${'\\'.repeat(count)}\`bad;\` after;`;
    assert.deepEqual(findingsFor(text, 'semicolon').map(({ col }) => col), count % 2
      ? [7 + count, 15 + count] : [15 + count], text);
  }
  assert.deepEqual(findingsFor('😀 \\``bad;` after;', 'semicolon').map(({ col }) => col), [17]);
});

test('Markdown：变长反引号只由等长标记关闭且代码内不转义', () => {
  for (const text of ['😀 ``one ` bad; \\`` after;', '😀 ```one `` bad; \\``` after;',
    '😀 `bad;\\` after;', '😀 ``bad;\nmore \\`` after;']) {
    const findings = findingsFor(text, 'semicolon');
    assert.equal(findings.length, 1, text);
    assert.deepEqual([findings[0].line, findings[0].col],
      [text.split('\n').length, [...text.split('\n').at(-1)].length], text);
  }
  assert.equal(findingsFor('Use ``bad;` after;', 'semicolon').length, 2);
});

test('Markdown：密集已闭合及未匹配转义反引号保持线性处理', () => {
  const repetitions = 64_000;
  const boundary = '\\``hidden;` \\\\``hidden;\\`` ';
  const cases = [
    ['已闭合', '`a` ', 1],
    ['未匹配长度', '\\``x ', repetitions + 1],
    ['转义边界', boundary, 2 * repetitions + 1],
  ];
  for (const [label, fragment, expectedWords] of cases) {
    const text = fragment.repeat(repetitions) + 'visible;';
    const started = process.cpuUsage();
    assert.deepEqual(lint(text, undefined, undefined, []), [[], expectedWords], label);
    const elapsed = process.cpuUsage(started);
    assert.ok(elapsed.user + elapsed.system < 4_000_000, `${label}处理超过 4 秒 CPU 预算`);
    const findings = findingsFor(text, 'semicolon', {
      rules: RULES.filter(({ id }) => id === 'semicolon'),
    });
    assert.equal(findings.length, 1, label);
    assert.deepEqual([findings[0].line, findings[0].col], [1, text.length], label);
  }
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

test('Markdown：Setext 下划线需要前置段落且独立等号保留为正文', () => {
  for (const underline of ['-', '--', '---', '=', '==', '===', ' - \t', '  --\t']) {
    const text = `Title\n${underline}\n${sentence(24)}`;
    assert.deepEqual(lint(text), [[], 25], underline);
    assert.deepEqual(findingsFor(`Title\n${underline}\nbad;`, 'semicolon')
      .map(({ line, col }) => [line, col]), [[3, 4]], underline);
  }
  for (const line of ['=', '==', '===', '--']) assert.deepEqual(lint(line), [[], 1], line);
  assert.deepEqual(lint('---'), [[], 0]);
  assert.deepEqual(lint('    Title\n    --\n    bad;'), [[], 0]);
});

test('Markdown：块标记尾部只允许 ASCII 空白', () => {
  for (const whitespace of ['\u3000', '\u00a0', '\u001f']) {
    assert.deepEqual(lint(`\`\`\`\n\`\`\`${whitespace}\nA; B.\n\`\`\``), [[], 0]);
    assert.deepEqual(lint(`First\n---${whitespace}\nNext`), [[], 3]);
    assert.deepEqual(lint(`First\n==${whitespace}\nNext`), [[], 3]);
    assert.equal(lint(`First\n- ${whitespace}\n  bad;`)[1], 2);
  }
  assert.deepEqual(lint('```\n``` \t\nbad;')[0].map(({ line, col }) => [line, col]), [[3, 4]]);
  assert.equal(lint('First\n- \t\n  bad;')[1], 2);
  assert.deepEqual(lint('-\t-\t-\n*\t*\t*\n_\t_\t_'), [[], 0]);
});

test('性能：分隔标记后的长空白和非空白尾部不二次回溯', () => {
  for (const marker of ['---', '* * *', '___']) {
    const text = `${marker}${' '.repeat(100_000)}x;`;
    const started = process.cpuUsage();
    assert.equal(lint(text, undefined, undefined, [])[1], marker === '* * *' ? 3 : 2);
    const elapsed = process.cpuUsage(started);
    assert.ok(elapsed.user + elapsed.system < 4_000_000, '块标记处理超过 4 秒 CPU 预算');
    assert.deepEqual(findingsFor(text, 'semicolon').map(({ line, col }) => [line, col]), [[1, text.length]]);
  }
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

test('Markdown：列表内表格随去缩进结束且正文恢复合并', () => {
  const table = '- a\n  | h | i |\n  |---|---|';
  assert.deepEqual(lint(`${table}\n| x | y |`), [[], 8]);
  const text = `${table}\n| x | y |\n${sentence(22)}`;
  assert.equal(lint(text)[1], 30);
  assert.deepEqual(findingsFor(text, 'long-sentence').map(({ line, col }) => [line, col]), [[4, 1]]);
  assert.equal(lint(`${table}\n| x | y |\n|-|-|\n| z | q |`)[1], 7);
});

test('Markdown：列表内表格分隔行需满足内容缩进上下限', () => {
  assert.deepEqual(lint('- item\n  a | b\n--|--\n  c | d'), [[], 8]);
  assert.deepEqual(lint('- item\n  a | b\n  --|--\n  c | d'), [[], 5]);
  assert.deepEqual(lint('- item\n  a | b\n\t--|--\n  c | d'), [[], 5]);
  const text = `- item\n  a | b\n--|--\n  ${sentence(25)}`;
  assert.deepEqual(findingsFor(text, 'long-sentence').map(({ line, col }) => [line, col]), [[3, 1]]);
  assert.deepEqual(lint('    a | b\n    --|--\n    c; | d'), [[], 0]);
});

test('Markdown：活动表格深缩进数据行不误作代码', () => {
  for (const indent of ['      ', '\t\t']) {
    const table = '- a\n  | h | i |\n  |---|---|';
    const text = `${table}\n${indent}| x; | y |`;
    assert.equal(lint(text)[1], 5);
    assert.deepEqual(findingsFor(text, 'semicolon').map(({ line, col }) => [line, col]),
      [[4, indent.length + 4]]);
    assert.deepEqual(lint(`${table}\n\n${indent}| x; | y |`), [[], 3]);
    assert.deepEqual(lint(`${table}\n${indent}bad;`), [[], 3]);
  }
  assert.equal(findingsFor('| h | i |\n|-|-|\n    | x; | y |', 'semicolon').length, 1);
});

test('Markdown：缩进代码的表头不能开启正文表格', () => {
  for (const indent of ['    ', '\t']) {
    assert.deepEqual(lint(`${indent}Label | Detail\n--- | ---\none | two`), [[], 6]);
    assert.deepEqual(lint(`Clear.\n\n${indent}Label | Detail\n${indent}--- | ---\n${indent}bad; | code`), [[], 1]);
  }
  assert.deepEqual(lint('```\nLabel | Detail\n--- | ---\nbad; | code\n```\nClear.'), [[], 1]);
});

test('Markdown：表格在列表、标题、水平线和空行前结束', () => {
  const table = 'Label | Detail\n--- | ---\nClear | Done';
  assert.deepEqual(findingsFor(`${table}\n- a | b and`, 'dangling-conjunction')
    .map(({ line, col }) => [line, col]), [[4, 1]]);
  assert.equal(lint(`${table}\n- a | b and`)[1], 8);
  for (const boundary of ['# ', '---\n', '\n']) {
    assert.equal(lint(`${table}\n${boundary}one | two`)[1], 7);
  }
});

test('Markdown：列表内另起行表格保留单元格检查和位置', () => {
  const text = '- Read details\n\n  Label | Detail\n  --- | ---\n  Clear | bad;\n- a | b and';
  assert.equal(lint(text)[1], 10);
  assert.deepEqual(findingsFor(text, 'semicolon').map(({ line, col }) => [line, col]), [[5, 14]]);
  assert.deepEqual(findingsFor(text, 'dangling-conjunction').map(({ line, col }) => [line, col]), [[6, 1]]);
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
  assert.equal(findingsFor('- Do this and\n\n      code and', 'dangling-conjunction').length, 1);
  assert.deepEqual(findingsFor('- Do this and\n\n      code and\n  record the result.', 'dangling-conjunction'), []);
});

test('列表：深缩进的未分段续行仍检查正文', () => {
  const text = '- Back up the data and\n      restore it later;';
  assert.deepEqual(findingsFor(text, 'dangling-conjunction'), []);
  assert.equal(lint(text)[1], 8);
  assert.deepEqual(findingsFor(text, 'semicolon').map(({ line, col }) => [line, col]), [[2, 23]]);
  assert.deepEqual(findingsFor(text.replace('\n', '\n\n'), 'semicolon'), []);
  assert.equal(findingsFor(text.replace('\n', '\n\n'), 'dangling-conjunction').length, 1);
});

test('列表：顶层围栏终止列表归属且后续缩进代码不参与检查', () => {
  const text = '- Step one\n\n```bash\necho hi\n```\n\n    rm -rf x; echo done';
  assert.deepEqual(lint(text), [[], 2]);
  assert.deepEqual(lint(text.replace('    rm', '\trm')), [[], 2]);
  const nested = '- Step one\n\n  ```bash\n  echo hi\n  ```\n\n  bad;';
  assert.deepEqual(findingsFor(nested, 'semicolon').map(({ line, col }) => [line, col]), [[7, 6]]);
});

test('列表：围栏随容器去缩进结束且当前行重新识别块', () => {
  for (const indent of ['  ', '\t']) {
    const text = `- Step\n${indent}\`\`\`\nA; B.`;
    assert.deepEqual(findingsFor(text, 'semicolon').map(({ line, col }) => [line, col]), [[3, 2]]);
    assert.deepEqual(lint(`- Step\n${indent}\`\`\`\n${indent}x\n\`\`\`\nA; B.\n\`\`\``), [[], 1]);
    assert.deepEqual(lint(`- Step\n${indent}\`\`\`\n\n${indent}A; B.\n${indent}\`\`\``), [[], 1]);
  }
  assert.deepEqual(lint('  ```\nA; B.\n```'), [[], 0]);
});

test('Markdown：单短横线表格按单元格检查且代码对照仍排除', () => {
  for (const separator of ['|-|-|', '|:-|-:|', '|:-:|--|']) {
    assert.deepEqual(lint(`| a | b |\n${separator}\n| x | y |`), [[], 4]);
  }
  assert.deepEqual(lint('| a | b |\n|-|-|\n| `bad;` | y |'), [[], 3]);
  assert.deepEqual(lint('    | a | b |\n    |-|-|\n    | x; | y |'), [[], 0]);
  assert.deepEqual(lint('```\n| a | b |\n|-|-|\n| x; | y |\n```'), [[], 0]);
  const nested = '- Read\n\n\t| a | b |\n\t|-|-|\n\t| x; | y |';
  assert.equal(lint(nested)[1], 5);
  assert.deepEqual(findingsFor(nested, 'semicolon').map(({ line, col }) => [line, col]), [[5, 5]]);
});

test('列表：非 1 序号和空条目不能打断普通段落规避句长', () => {
  const first = sentence(10).slice(0, -1);
  for (const marker of ['30)', '2)']) {
    const text = `${first}\n${marker} ${sentence(16)}`;
    assert.equal(findingsFor(text, 'long-sentence').length, 1, marker);
    assert.equal(lint(text)[1], 27, marker);
    assert.deepEqual(findingsFor(`${first}\n\n${marker} ${sentence(16)}`, 'long-sentence'), []);
  }
  for (const marker of ['+ ', '1) ', '* ', '30) ']) {
    const text = `${first}\n${marker}\n${sentence(16)}`;
    assert.equal(findingsFor(text, 'long-sentence').length, 1, marker);
    assert.deepEqual(findingsFor(`${first}\n\n${marker}\n${sentence(16)}`, 'long-sentence'), []);
  }
  assert.equal(lint(`${first}\n2. ${sentence(16)}`)[1], 27);
  assert.equal(lint(`${first}\n1. \n${sentence(16)}`)[1], 27);
  for (const marker of ['1.', '1)', '01.', '-']) {
    assert.deepEqual(findingsFor(`${first}\n${marker} ${sentence(16)}`, 'long-sentence'), []);
  }
});

test('列表：Tab 缩进按四列制表位识别续行但报告原始字符列', () => {
  for (const indent of ['\t', ' \t', '\t ', '\t\t']) {
    const text = `- Back up the data and\n${indent}restore it later;`;
    assert.deepEqual(findingsFor(text, 'dangling-conjunction'), [], JSON.stringify(indent));
    assert.deepEqual(findingsFor(text, 'semicolon').map(({ line, col }) => [line, col]),
      [[2, indent.length + 17]]);
  }
  assert.deepEqual(findingsFor('- Back up the data and\n\trestore it later.', 'dangling-conjunction'), []);
  assert.deepEqual(lint('Clear.\n\n\tbad;'), [[], 1]);
  assert.deepEqual(lint('- Step one\n\n\t\tbad;'), [[], 2]);
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

test('Unicode：切分逻辑行后非行界 Unicode 空白不终止段落', () => {
  const half = Array(13).fill('word').join(' ');
  for (const whitespace of ['\u3000', '\u00a0', '\u001f', ' \u3000\t']) {
    const text = `${half}\n${whitespace}\n${half}`;
    assert.equal(lint(text)[1], 26);
    assert.deepEqual(findingsFor(text, 'long-sentence').map(({ line, col }) => [line, col]), [[1, 1]]);
    assert.deepEqual(findingsFor(`Clear\n${whitespace}\nbad;`, 'semicolon')
      .map(({ line, col }) => [line, col]), [[3, 4]]);
  }
  for (const whitespace of ['', ' ', '\t', ' \t ']) {
    assert.deepEqual(lint(`${half}\n${whitespace}\n${half}`), [[], 26]);
  }
});

test('性能：长中间空白和密集表格保持线性处理及原始列号', () => {
  const cells = 32_000;
  const table = `|${'x|'.repeat(cells)}\n|${'-|'.repeat(cells)}\n|${'😀;|'.repeat(cells)}`;
  const cases = [
    ['中间空白', `a${' '.repeat(64_000)}b;`, 2],
    ['Unicode 中间空白', `a${' \u3000'.repeat(32_000)}b;`, 2],
    ['密集表格', table, 2 * cells],
  ];
  for (const [label, text, expectedWords] of cases) {
    const started = process.cpuUsage();
    assert.deepEqual(lint(text, undefined, undefined, []), [[], expectedWords], label);
    const elapsed = process.cpuUsage(started);
    assert.ok(elapsed.user + elapsed.system < 4_000_000, `${label}处理超过 4 秒 CPU 预算`);
    const findings = findingsFor(text, 'semicolon', { rules: RULES.filter(({ id }) => id === 'semicolon') });
    if (label === '密集表格') {
      assert.equal(findings.length, cells);
      assert.deepEqual([findings[0].line, findings[0].col], [3, 3]);
      assert.deepEqual([findings.at(-1).line, findings.at(-1).col], [3, 3 * cells]);
    } else {
      assert.equal(findings.length, 1);
      assert.deepEqual([findings[0].line, findings[0].col], [1, text.length]);
    }
  }
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

test('中文：小数与版本连续串整体计一字且保留分隔边界', () => {
  for (const [text, count] of [
    ['API', 1], ['v2.1', 1], ['3.14', 1], ['v2.1.3rc1', 1],
    ['HTTP v2.1', 2], ['HTTP,v2.1', 2], ['API.HTTP', 2],
    ['v2。1', 2], ['v2..1', 2], ['a.1', 2], ['1.a', 2],
    ['汉v2.1汉API汉', 5], ['v2.1 `API` HTTP', 2],
    ['```\nv2.1\n```', 0], ['    HTTP v2.1', 0],
  ]) {
    assert.equal(lint(text, '<stdin>', 'description', null, 'zh')[1], count, text);
  }
});

test('中文：版本串在指令二十字边界不误报', () => {
  for (const [hanCount, status] of [[19, 0], [20, 1]]) {
    const result = runCli(['--language', 'zh', '--text-type', 'instruction', '--json'], `${'汉'.repeat(hanCount)} v2.1。`);
    assert.equal(result.status, status);
    const data = JSON.parse(result.stdout);
    assert.equal(data.words, hanCount + 1);
    assert.equal(data.hard_count, status);
    if (status) assert.equal(data.violations[0].rule, 'zh-long-sentence');
  }
});

test('中文：分号为硬性问题，悬空连接词仅作建议', () => {
  assert.equal(findingsFor('检查；记录。', 'zh-semicolon', { language: 'zh' })[0].level, 'advisory-free');
  const dangling = findingsFor('- 配置网络和\n- 记录结果或\n', 'zh-dangling-conjunction', { language: 'zh' });
  assert.equal(dangling.length, 2);
  assert.deepEqual([dangling[0].line, dangling[1].line], [1, 2]);
  assert.ok(dangling.every(({ level }) => level === 'advisory'));
});

test('中文：连接词后缀不能确定词边界，不导致硬性失败', () => {
  for (const text of [
    '- 确认连接池未饱和', '- 统计各分片的总和',
    '- 配置网络和', '- 记录结果或', '- 检查配置以及',
    '- 检查配置并且', '- 检查配置或者', '- 检查配置同时',
  ]) {
    const result = runCli(['--language', 'zh', '--json'], text);
    assert.equal(result.status, 0, text);
    const data = JSON.parse(result.stdout);
    assert.equal(data.hard_count, 0, text);
    const dangling = data.violations.filter(({ rule }) => rule === 'zh-dangling-conjunction');
    assert.equal(dangling.length, 1, text);
    assert.equal(dangling[0].level, 'advisory', text);
  }
  assert.deepEqual(findingsFor('- 确认连接池状态', 'zh-dangling-conjunction', { language: 'zh' }), []);
  const rule = RULES_ZH.find(({ id }) => id === 'zh-dangling-conjunction');
  assert.equal(rule.type, 'heuristic');
  assert.match(rule.limitations, /词边界.*总和.*饱和/u);
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
  // 跨语言 ID 必须报错；只有当前语言启用的规则可以禁用。
  const crossLanguage = runCli(['--language', 'zh', '--disable', 'semicolon'], 'Clear.');
  assert.equal(crossLanguage.status, 2);
  assert.match(crossLanguage.stderr, /属于 --language en/);
  const unknown = runCli(['--language', 'zh', '--disable', 'nope'], 'Clear.');
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /未知规则 ID/);
  const otherWay = runCli(['--language', 'en', '--disable', 'zh-semicolon'], 'Clear.');
  assert.equal(otherWay.status, 2);
  assert.match(otherWay.stderr, /属于 --language zh/);
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
  // 单字「应」「须」曾命中「响应」「应用」「必须」等普通词，导致误报。
  const falsePositive = '系统返回响应。应用读取对应配置。需要的字段已列出。';
  assert.deepEqual(findingsFor(falsePositive, 'zh-list-required', { language: 'zh' }), []);
  assert.deepEqual(findingsFor('这一项需要处理。', 'zh-list-required', { language: 'zh' }), []);
  // 真实的要求强度词仍然计数。
  assert.equal(findingsFor('必须先停止服务。应当记录配置。可以重试一次。',
    'zh-list-required', { language: 'zh' }).length, 1);
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
