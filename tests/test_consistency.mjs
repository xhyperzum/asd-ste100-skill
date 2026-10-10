/** 跨文件一致性门禁：规则、版本、覆盖表与资源清单必须互相吻合。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { RULES, RULES_ZH } from '../scripts/ste-lint.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = name => readFileSync(resolve(ROOT, name), 'utf8');
const ruleIds = rules => rules.map(rule => rule.id).sort();

/** 取出 Markdown 表格首列中被反引号包围的规则 ID。 */
function tableRuleIds(text) {
  const ids = [];
  for (const line of text.split('\n')) {
    const match = /^\|\s*`([a-z][a-z0-9-]+)`\s*\|/u.exec(line);
    if (match) ids.push(match[1]);
  }
  return ids.sort();
}

/** 取出被反引号包围且形如案例 ID 的标识符。 */
function backticked(text) {
  return new Set([...text.matchAll(/`([a-z][a-z0-9]*(?:-[a-z0-9]+)*)`/gu)].map(match => match[1]));
}

test('一致性：linter.md 的规则表等于检查器实际启用的规则', () => {
  const ids = tableRuleIds(read('references/linter.md'));
  const expected = [...ruleIds(RULES), ...ruleIds(RULES_ZH)].sort();
  assert.deepEqual(ids, expected,
    'references/linter.md 的规则表必须逐条对应 ste-lint.mjs 的 RULES 与 RULES_ZH');
});

test('一致性：中文规范的规则 ID 清单等于 RULES_ZH', () => {
  const text = read('references/chinese-writing-rules.md');
  const declared = backticked(text);
  for (const id of ruleIds(RULES_ZH)) {
    assert.ok(declared.has(id), `中文规范缺少规则 ID：${id}`);
  }
  // 规范里出现的任何「像规则 ID」的标识必须真实存在，防止写错 ID。
  // 规则 ID 的形态：zh- 前缀，或无前缀的英文规则名（如 semicolon、long-sentence）。
  // 不用写死白名单，但排除等级名与类型名这类非规则标识。
  const known = new Set([...ruleIds(RULES), ...ruleIds(RULES_ZH)]);
  const notRules = new Set(['advisory', 'advisory-free', 'deterministic', 'heuristic',
    'schema-version', 'text-type']);
  const looksLikeRule = id => /^zh-[a-z]+(?:-[a-z]+)*$/u.test(id)
    || /^[a-z]+(?:-[a-z]+)+$/u.test(id);
  const stray = [...declared].filter(looksLikeRule)
    .filter(id => !known.has(id) && !notRules.has(id));
  assert.deepEqual(stray, [], `中文规范声明了不存在的规则 ID：${stray.join(', ')}`);
});


test('一致性：SKILL.md 覆盖全部 advisory-free 规则的语义条目', () => {
  const skill = read('SKILL.md');
  // SKILL.md 不登记规则 ID，因此按规则语义关键词核对。
  // 每个硬性规则必须映射到一个必须出现在 SKILL.md 的关键词。
  const keywordOf = {
    semicolon: '分号',
    'long-sentence': '句长',
    'dangling-conjunction': '列表项末尾连接词',
  };
  for (const rule of RULES) {
    if (rule.level !== 'advisory-free') continue;
    const keyword = keywordOf[rule.id];
    assert.ok(keyword, `硬性规则 ${rule.id} 未在测试中登记语义关键词，新增规则时必须补充`);
    assert.ok(skill.includes(keyword), `SKILL.md 缺少规则条目：${keyword}（对应 ${rule.id}）`);
  }
});


test('一致性：中文规范覆盖全部 zh advisory-free 规则', () => {
  const text = read('references/chinese-writing-rules.md');
  // 硬性规则计入退出码，必须在中文规范里有明确出处。
  for (const rule of RULES_ZH) {
    if (rule.level !== 'advisory-free') continue;
    assert.ok(text.includes(`\`${rule.id}\``),
      `硬性规则 ${rule.id} 计入退出码，必须在中文规范中登记`);
  }
});


test('一致性：英文硬性规则都在 SKILL.md 里有规则出处', () => {
  const skill = read('SKILL.md');
  // SKILL.md 不登记规则 ID，因此按规则语义关键词核对必须存在的条目。
  const expected = ['列表项末尾连接词', '分号', '每句一条指令', '句长', '安全说明',
    '简单时态', '完整句子', '名词堆叠', '段落和列表', '术语一致'];
  for (const keyword of expected) {
    assert.ok(skill.includes(keyword), `SKILL.md 缺少规则条目：${keyword}`);
  }
  for (const rule of RULES) {
    if (rule.level !== 'advisory-free') continue;
    assert.ok(rule.limitations, `硬性规则 ${rule.id} 必须声明限制`);
  }
});

test('一致性：评测覆盖表与 cases.json 双向对应', () => {
  const cases = JSON.parse(read('evals/cases.json'));
  const ids = cases.map(item => item.id);
  assert.equal(new Set(ids).size, ids.length, 'cases.json 存在重复 ID');
  // 只从覆盖表区域提取案例 ID，避免正文里的偶然提及被当成覆盖。
  const text = read('references/evaluation.md');
  const start = text.indexOf('| 规则或契约 |');
  assert.ok(start >= 0, 'evaluation.md 缺少覆盖表表头');
  const declared = backticked(text.slice(start));
  const missing = ids.filter(id => !declared.has(id));
  assert.deepEqual(missing, [], `cases.json 中未被覆盖表提及的案例：${missing.join(', ')}`);
  // 覆盖表里形如案例 ID 的标识必须真实存在（排除约束字段名等）。
  const known = new Set(ids);
  const allowed = new Set(['contains', 'forbidden', 'any_contains', 'not_equals', 'equals_input', 'requires_list',
    'schema-version', 'prompt-variant']);
  const ghost = [...declared].filter(id => /^[a-z]+(?:-[a-z]+)+$/u.test(id))
    .filter(id => !known.has(id) && !allowed.has(id));
  assert.deepEqual(ghost, [], `覆盖表引用了不存在的案例：${ghost.join(', ')}`);
});

test('一致性：版本号在 SKILL.md、README、evaluation.md 三处一致', () => {
  // 只从 frontmatter 区块提取 version，避免匹配到正文里的 version 字样。
  const frontmatter = /^---\n([\s\S]*?)\n---\n/u.exec(read('SKILL.md'))?.[1];
  assert.ok(frontmatter, 'SKILL.md 缺少 frontmatter 区块');
  const version = /^\s+version:\s*"([^"]+)"/mu.exec(frontmatter)?.[1];
  assert.ok(version, 'SKILL.md frontmatter 缺少 metadata.version');
  assert.match(version, /^\d+\.\d+\.\d+$/u);
  // 加右边界，防止 0.1.0 匹配到 0.1.00。
  const pattern = new RegExp(`当前技能为 ${version.replace(/\./gu, '\\.')}(?!\\d)`, 'u');
  assert.match(read('README.md'), pattern, `README.md 的版本号必须等于 ${version}`);
  assert.match(read('references/evaluation.md'), pattern, `references/evaluation.md 的版本号必须等于 ${version}`);
});

test('一致性：文档声明的案例数与 cases.json 实际数量一致', () => {
  const cases = JSON.parse(read('evals/cases.json'));
  // 不允许任何与真实数量不符的案例数声明。
  const declared = [...read('references/evaluation.md').matchAll(/案例集(?:扩展)?为 (\d+) 例/gu)].map(m => Number(m[1]));
  assert.ok(declared.length, 'evaluation.md 必须声明案例数');
  for (const value of declared) {
    assert.equal(value, cases.length, `evaluation.md 声明的案例数 ${value} 与实际 ${cases.length} 不符`);
  }
  for (const [, raw] of read('README.md').matchAll(/正式案例集扩展为 (\d+) 例/gu)) {
    assert.equal(Number(raw), cases.length, `README.md 声明的案例数 ${raw} 与实际 ${cases.length} 不符`);
  }
});

test('一致性：SKILL.md 的 description 覆盖技能实际支持的语言', () => {
  const description = /^description:\s*"([^"]+)"/mu.exec(read('SKILL.md'))?.[1] ?? '';
  assert.ok(description, 'SKILL.md frontmatter 缺少 description');
  // 触发词部分是技能被调用的入口；只检查全文出现「中文」不足以防止中文分支失联。
  const triggers = /触发词：([^。]+)/u.exec(description)?.[1] ?? '';
  assert.ok(triggers.includes('中文'), '触发词必须包含中文入口，否则中文请求不会命中技能');
  const zhSpec = read('references/chinese-writing-rules.md');
  // 规范标题是一个稳定锚点，用它确认 description 与中文分支指向同一份规范。
  const title = /^#\s+(.+)$/mu.exec(zhSpec)?.[1]?.trim();
  assert.ok(title && description.includes(title.split('规范')[0] + '规范'),
    `description 应引用中文规范标题：${title}`);
});

test('一致性：案例约束不得空转或大小写错配', async () => {
  const { checkInvariants } = await import('../scripts/evaluate.mjs');
  const cases = JSON.parse(read('evals/cases.json'));
  const idle = [];
  const mismatched = [];
  for (const item of cases) {
    const invariants = item.invariants ?? {};
    // not_equals 是「不得恰好等于」；若对原文自身也通过，它永远拒不了未改写输出。
    if (invariants.not_equals && checkInvariants(item, item.source).every(check => check.passed)) {
      idle.push(item.id);
    }
    // contains 是大小写敏感的字面匹配，错配会让正确输出永远通不过。
    for (const part of invariants.contains ?? []) {
      if (!item.source.includes(part) && item.source.toLowerCase().includes(part.toLowerCase())) {
        mismatched.push(`${item.id}: ${JSON.stringify(part)}`);
      }
    }
  }
  assert.deepEqual(idle, [], `not_equals 对原文也通过，约束空转：${idle.join(', ')}`);
  assert.deepEqual(mismatched, [], `contains 大小写错配：${mismatched.join(', ')}`);
});


test('一致性：equals_input 案例不得与改写型约束并存', () => {
  const cases = JSON.parse(read('evals/cases.json'));
  for (const item of cases) {
    if (!item.invariants?.equals_input) continue;
    const others = Object.keys(item.invariants).filter(key => key !== 'equals_input');
    assert.deepEqual(others, [], `${item.id} 要求原样返回，不能同时要求改写`);
  }
});


test('一致性：人工复核维度不得要求保留原文没有的内容', () => {
  // human_review 是给复核者的指令。若它要求「保留原有的 MUST」而原文根本没有 MUST，
  // 复核者会去寻找不存在的东西，该维度就是无效的。
  const stopWords = ['MUST', 'SHOULD', 'MAY', '必须', '应当', '可以'];
  const invalid = [];
  for (const item of JSON.parse(read('evals/cases.json'))) {
    const review = (item.human_review ?? []).join(' ');
    for (const word of stopWords) {
      // 大小写不敏感，并容忍「保留原有的 SHOULD」这种插词与空格。
      // 「的」必须独立可选：择一分支写成 (?:原有|原文的) 时，
      // 「原有的」既不匹配「原有」也不匹配「原文的」，会漏检。
      const pattern = new RegExp(`保留\\s*(?:原有|原文)?的?\\s*${word}`, 'iu');
      if (pattern.test(review) && !new RegExp(word, 'iu').test(item.source)) {
        invalid.push(`${item.id}: 要求保留 ${word}，但源文没有该词`);
      }
    }
  }
  assert.deepEqual(invalid, [], invalid.join('；'));
});


test('一致性：必需资源清单覆盖 tests/ 下的全部测试文件', async () => {
  const { REQUIRED_PATHS } = await import('../scripts/check-install.mjs');
  const { readdirSync } = await import('node:fs');
  // 新增测试文件必须同步登记，否则安装副本校验会漏掉它。
  const listed = new Set(REQUIRED_PATHS.map(entry => entry[0]));
  const onDisk = readdirSync(resolve(ROOT, 'tests'))
    .filter(name => /^test_.*\.mjs$/u.test(name)).map(name => `tests/${name}`).sort();
  assert.ok(onDisk.length, 'tests/ 下应有测试文件');
  const missing = onDisk.filter(name => !listed.has(name));
  assert.deepEqual(missing, [], `未登记到必需资源清单的测试文件：${missing.join(', ')}`);
});


test('一致性：必需资源清单覆盖所有被 SKILL.md 链接的仓库文件', async () => {
  const { REQUIRED_PATHS } = await import('../scripts/check-install.mjs');
  const listed = new Set(REQUIRED_PATHS.map(entry => entry[0]));
  const skill = read('SKILL.md');
  // 目标允许带锚点（如 references/evaluation.md#版本线说明），锚点不属于路径。
  const targets = [...skill.matchAll(/\]\((?!https?:)([^)\s]+)\)/gu)].map(match => match[1].split('#')[0]);
  assert.ok(targets.length, 'SKILL.md 应包含指向仓库文件的链接');
  const files = targets.filter(target => /\.[a-z]+$/u.test(target));
  for (const target of files) {
    assert.ok(listed.has(target), `SKILL.md 链接的 ${target} 必须列入 check-install.mjs 的必需资源清单`);
  }
});
