/** 跨文件一致性门禁：规则、版本、覆盖表与资源清单必须互相吻合。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { RULES, RULES_ZH } from '../scripts/ste-lint.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = name => readFileSync(resolve(ROOT, name), 'utf8');
const ruleIds = rules => rules.map(rule => rule.id).sort();

test('一致性：保留被动不豁免安全条件组织，列表不豁免多主题分组', () => {
  const skill = read('SKILL.md');
  const safety = /^\| 安全说明 \|([^|]+)\|/mu.exec(skill)?.[1];
  assert.ok(safety, '必须保留安全说明规则');
  assert.match(safety, /明确条件或命令开头/u);
  assert.match(safety, /施事者未知可保留被动/u);
  assert.match(safety, /不改变 must、only 等要求强度和前提/u);
  assert.match(safety, /仍把已有条件放句首/u);
  const paragraphs = /^\| 段落和列表 \|([^|]+)\|/mu.exec(skill)?.[1];
  assert.ok(paragraphs, '必须保留段落和列表规则');
  assert.match(paragraphs, /不同处理阶段或条件分支/u);
  assert.match(paragraphs, /先确定分组/u);
  assert.match(paragraphs, /按主题分组；.*各组的句子或列表/u);
  assert.match(paragraphs, /不用平铺列表代替主题组织/u);
  const actions = /^\| 每句一条指令 \|([^|]+)\|/mu.exec(skill)?.[1];
  assert.ok(actions, '必须保留每句一条指令规则');
  assert.match(actions, /分别成句或独立列项/u);
  assert.match(actions, /先做 A，再做 B/u);
  assert.match(actions, /共享条件或要求强度/u);
  const cases = JSON.parse(read('evals/cases.json'));
  const safetyReview = cases.find(item => item.id === 'safety-condition-first').human_review[4];
  assert.match(safetyReview, /施事者未知可保留被动/u);
  assert.match(safetyReview, /已有条件放句首/u);
  assert.match(safetyReview, /保留 must、only 等要求强度、排他前提/u);
  assert.match(safetyReview, /不强制改成直接命令/u);
  for (const id of ['paragraph-structure', 'zh-paragraph-structure']) {
    const item = cases.find(entry => entry.id === id);
    assert.ok(item, `缺少主题组织案例：${id}`);
    assert.ok(item.human_review.some(dimension => /按.*主题/u.test(dimension)), `${id} 不能删除主题组织判据`);
  }
});

test('一致性：三项人工判据不混入待定决策、删除等待时间或固定列表形式', () => {
  const cases = JSON.parse(read('evals/cases.json'));
  const reviewOf = id => {
    const item = cases.find(entry => entry.id === id);
    assert.ok(item, `缺少案例：${id}`);
    return item.human_review.join('\n');
  };
  const retry = reviewOf('meaning-and-scope');
  assert.match(retry, /取消状态与禁止范围保持/u);
  assert.match(retry, /完整时间关系判据/u);
  assert.doesNotMatch(retry, /需在此确认|若要收紧/u);
  const deletion = reviewOf('zh-requirement-strength');
  assert.match(deletion, /只适用于超过 24 小时的临时文件/u);
  assert.match(deletion, /不得改成等待 24 小时后删除任意临时文件/u);
  assert.doesNotMatch(deletion, /限定在 24 小时之后/u);
  const conditions = reviewOf('condition-list');
  assert.match(conditions, /独立成句或单独列项/u);
  assert.match(conditions, /必须保留 must，不得把它扩展到前三项/u);
  assert.doesNotMatch(conditions, /四个条件分别列出/u);
});

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
  const allowed = new Set(['contains', 'forbidden', 'forbidden_line_prefix', 'any_contains', 'not_equals', 'equals_input', 'requires_list',
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


test('一致性：边界优先级由 SKILL.md 定义，中文规范引用而不复制', () => {
  // 该规则是产品行为的一部分：它使「边界不明」优先于「先完成能确定的部分」。
  // 两节（输入边界、输出契约）曾对同一输入给出相反指示，导致模型行为不稳定；
  // 删除或弱化这条规则会重新引入该歧义。
  const skill = read('SKILL.md');
  const boundary = /## 输入与执行指令的边界\n([\s\S]*?)\n## /u.exec(skill)?.[1] ?? '';
  assert.ok(boundary.includes('先请求用户指出'), '输入边界节必须要求先请求澄清');
  assert.match(boundary, /优先级高于其他改写偏好/u,
    '输入边界节必须声明其判断优先于其他改写偏好，否则会与输出契约节冲突');
  assert.match(boundary, /两种理解会导致不同输出/u,
    '必须说明什么情况下需要澄清，否则会过度泛化到所有不确定表达');
  assert.match(boundary, /澄清只针对当前未知信息/u);
  assert.match(boundary, /原文边界尚未确认时，只询问待改写范围/u);
  assert.match(boundary, /不根据尚未确认的编辑要求推断冲突/u);
  assert.match(boundary, /要求说明改动不意味着必须发生改动/u);
  assert.match(boundary, /用户要求说明而实际无改动时，如实说明没有改动/u);
  assert.ok(skill.includes('**默认只输出改写稿，语言与原文一致。**'));
  assert.ok(skill.includes('无需改动时原样返回原文，不添加“已经符合规则”等说明。'));
  const cases = JSON.parse(read('evals/cases.json'));
  const review = cases.find(item => item.id === 'source-boundary-clarification').human_review.join('\n');
  assert.match(review, /边界未确认时不根据疑似编辑要求推断冲突/u);
  assert.match(review, /不得误称不改原句与解释每项改动必然矛盾/u);
  assert.match(review, /说明改动不要求必须发生改动，无改动时可如实说明/u);
  const coverage = read('references/evaluation.md').split('\n')
    .find(line => line.startsWith('| 必要澄清与原文区域 |'));
  assert.match(coverage, /边界未确认时不根据疑似编辑要求推断冲突/u);
  assert.match(coverage, /不误称不改原句与解释每项改动必然矛盾/u);
  assert.match(coverage, /要求说明不强制发生改动，无改动时如实说明/u);
  const contract = /## 输出契约\n([\s\S]*?)\n\n\*\*/u.exec(skill)?.[1] ?? '';
  assert.match(contract, /只适用于不会改变输出的不确定性/u,
    '输出契约节必须限定「保留并继续」的适用范围，并指向边界节');
  const zh = read('references/chinese-writing-rules.md');
  assert.ok(zh.includes('../SKILL.md#输入与执行指令的边界'), '中文规范必须链接共享边界规则');
  assert.doesNotMatch(zh, /先询问哪些部分属于原文/u, '中文规范不得复制共享边界规则');
  for (const name of ['每句一条指令', '分号', '完整句子', '安全说明']) {
    const row = zh.split('\n').find(line => line.startsWith(`| ${name} |`));
    assert.ok(row, `中文规范缺少规则映射：${name}`);
    assert.match(row, /同 SKILL\.md/u, `${name} 必须引用核心规则`);
    assert.match(row.split('|')[3], /同 SKILL\.md/u, `${name} 的共享例外也必须引用核心规则`);
  }
});


test('一致性：约束缺陷的计数在文档间必须一致', () => {
  // 同一事实曾被写成三个不同数字（六处 / 五处 / 四处）。
  // 本测试不硬编码具体数字（新增缺陷时只需改文档），而是要求各文档声明同一个数。
  //
  // AGENTS.md 是开发文档，不是技能运行资源，不会进入安装副本；
  // 若它在场就必须参与一致性检查，缺失时只校验 evaluation.md 内部的两处。
  const claims = [];
  const collect = (label, text, pattern) => {
    const match = pattern.exec(text);
    // 保留原始字符串：中文数字不能先经过 Number() 转换。
    if (match) claims.push({ label, raw: match[1] });
  };
  const evaluation = read('references/evaluation.md');
  // 缺陷表：「六处，…」（需要 m 标志，否则 ^ 只匹配全文开头，该声明会被静默漏采）
  collect('evaluation.md 缺陷表', evaluation, /^([一二三四五六七八九十\d]+)处，前/mu);
  // 教训段：「已出现六处实例」
  collect('evaluation.md 教训段', evaluation, /已出现([一二三四五六七八九十\d]+)处实例/u);
  const agentsPath = resolve(ROOT, 'AGENTS.md');
  if (existsSync(agentsPath)) {
    collect('AGENTS.md 教训', read('AGENTS.md'), /已出现([一二三四五六七八九十\d]+)处实例/u);
  }
  // evaluation.md 的两处是必须存在的；缺任何一处说明声明被删除或写法改变。
  assert.ok(claims.filter(c => c.label.startsWith('evaluation.md')).length === 2,
    'evaluation.md 应同时包含缺陷表与教训段的计数声明');
  const numerals = { '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9, '十': 10 };
  // 支持阿拉伯数字与中文数字（一至十，足够本用途）。
  const asNumber = raw => (/^\d+$/u.test(raw) ? Number(raw) : numerals[raw]);
  const normalized = claims.map(c => ({ ...c, n: asNumber(c.raw) }));
  for (const c of normalized) assert.ok(c.n, `${c.label} 的计数无法解析：${c.raw}`);
  const unique = [...new Set(normalized.map(c => c.n))];
  assert.equal(unique.length, 1,
    `约束缺陷的计数在各文档间不一致：${normalized.map(c => c.label + '=' + c.n).join('、')}`);
});


test('一致性：文档中的评测数字声明与记录一致', () => {
  // 本会话中「五轮/六轮」「31 例」「4/5 还是要/5」等声明曾多次与记录脱节，
  // 全靠人工核对。此测试把可机检的那部分固定下来。
  const recordPath = resolve(ROOT, 'evals/results/real-model-2026-10-10-rounds.json');
  assert.ok(existsSync(recordPath), '历史评测记录必须存在，不能静默跳过数字一致性检查');
  const record = JSON.parse(readFileSync(recordPath, 'utf8'));
  // 统计用 valid_matrix：源文已修订的案例在修订前轮次标为 -，避免把旧源文的输出算作失败。
  const matrix = record.cross_round_matrix.valid_matrix ?? record.cross_round_matrix.matrix;
  const rawMatrix = record.cross_round_matrix.matrix;
  const roundCount = record.rounds.length;
  const caseCount = Object.keys(matrix).length;
  const neverFailed = Object.values(matrix).filter(s => !/[XE]/u.test(s)).length;
  const numerals = { '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9, '十': 10 };
  const asNumber = raw => (/^\d+$/u.test(raw) ? Number(raw) : numerals[raw]);

  const readme = read('README.md');
  const evaluation = read('references/evaluation.md');

  // README：轮次数
  // 捕获范围必须只含数字，否则 asNumber 会收到「六轮」这样的带单位字符串。
  const readmeRounds = /已有([一二三四五六七八九十\d]+)轮全量真实模型调用记录/u.exec(readme)?.[1];
  assert.ok(readmeRounds, 'README 应声明全量评测轮次数');
  assert.equal(asNumber(readmeRounds), roundCount,
    `README 声明的轮次（${readmeRounds}）与记录（${roundCount}）不符`);

  // README：案例总数
  const readmeCases = /历史 (\d+) 例已有/u.exec(readme)?.[1];
  assert.ok(readmeCases, 'README 应声明历史案例数');
  assert.equal(Number(readmeCases), caseCount, `README 声明的案例数（${readmeCases}）与记录（${caseCount}）不符`);
  const currentCaseCount = JSON.parse(read('evals/cases.json')).length;
  for (const [label, declared] of [['README', /当前 (\d+) 例/u.exec(readme)?.[1]],
    ['evaluation.md', /案例集扩展为 (\d+) 例/u.exec(evaluation)?.[1]]]) {
    assert.ok(declared, `${label} 应单独声明当前案例数`);
    assert.equal(Number(declared), currentCaseCount, `${label} 的当前案例数必须匹配 cases.json，不匹配历史快照`);
  }

  // README 与 evaluation.md：从未失败的案例数。两处都必须与有效矩阵一致。
  const neverClaims = [
    ['README', /中 (\d+) 例从未失败/u.exec(readme)?.[1]],
    ['evaluation.md', /有 (\d+)\/38 例从未失败/u.exec(evaluation)?.[1]],
  ];
  for (const [label, claimed] of neverClaims) {
    assert.ok(claimed, `${label} 应声明从未失败的案例数`);
    assert.equal(Number(claimed), neverFailed,
      `${label} 声明的「从未失败」（${claimed}）与有效统计（${neverFailed}）不符`);
  }

  // evaluation.md：输出完全相同的案例数（该统计随轮次增加会变，容易写成旧值）。
  // 原始输出已拆到独立文件（record.output_index），主记录只保留判定。
  const outputsPath = resolve(ROOT, record.output_index ?? '');
  assert.ok(record.output_index && existsSync(outputsPath),
    `主记录引用的输出文件不存在：${record.output_index}（缺少它就无法重算输出一致性）`);
  const outputsDoc = JSON.parse(readFileSync(outputsPath, 'utf8'));
  const outputOf = (round, cid) => outputsDoc.outputs[`r${round}.${cid}`]?.output ?? '';
  let identicalOutputs = 0;
  for (const cid of Object.keys(record.cross_round_matrix.matrix)) {
    const outs = [];
    for (const r of record.rounds) {
      const c = r.results.find(x => x.case_id === cid);
      if (!c || c.operation_error) continue;
      const text = outputOf(r.round, cid);
      if (!text.trim()) continue;
      outs.push(text);
    }
    if (outs.length >= 2 && new Set(outs).size === 1) identicalOutputs += 1;
  }
  const identicalClaim = /38 例中 (\d+) 例在全部已跑轮次中输出\*\*完全相同\*\*/u.exec(evaluation)?.[1];
  assert.ok(identicalClaim, 'evaluation.md 应声明输出完全相同的案例数');
  assert.equal(Number(identicalClaim), identicalOutputs,
    `evaluation.md 声明「完全相同的案例数」（${identicalClaim}）与重算结果（${identicalOutputs}）不符；`
    + '该统计随轮次增加会变，新增轮次后需更新');

  // README：逐案例失败数声明。支持两种写法，否则散文写法会绕过检查：
  //   分式：`case-id`（4/6）
  //   散文：`case-id`（7 轮中 4 轮未改简单时态…）
  const claimsSeen = new Map();
  const checkClaim = (id, claimed, total, raw) => {
    assert.ok(matrix[id], `README 引用了记录中不存在的案例：${id}`);
    const actual = matrix[id].split('').filter(c => c === 'X').length;
    assert.equal(Number(claimed), actual, `${id}：README 声明失败 ${claimed} 次（${raw}），记录为 ${actual} 次`);
    // 总轮次按原始矩阵算（含作废轮），因为 README 描述的是「跑了多少轮」。
    assert.equal(Number(total), rawMatrix[id].length, `${id}：README 声明总轮次 ${total}（${raw}），记录为 ${rawMatrix[id].length}`);
    claimsSeen.set(id, raw);
  };
  for (const match of readme.matchAll(/`([a-z-]+)`（(\d+)\/(\d+)/gu)) {
    checkClaim(match[1], match[2], match[3], match[0]);
  }
  for (const match of readme.matchAll(/`([a-z-]+)`（(\d+) 轮中 (\d+) 轮/gu)) {
    // 散文写法把总轮次放在前、失败次数在后。
    checkClaim(match[1], match[3], match[2], match[0]);
  }
  // README 提到的每个反复失败案例都必须有受检的失败数声明。
  // README 提到的每个反复失败案例都必须有受检的失败数声明，
  // 除非它的源文已修订且有效轮次不足（那时写失败数会误导）。
  const revisedInsufficient = new Set();
  for (const rev of record.case_revisions ?? []) {
    const cid = rev.case_id;
    const validRounds = (matrix[cid] ?? '').split('').filter(c => c !== '-').length;
    if (rev.valid_from_round && validRounds < 3) revisedInsufficient.add(cid);
  }
  const mentioned = new Set([...readme.matchAll(/`([a-z-]+)`（/gu)].map(m => m[1]).filter(id => matrix[id]));
  for (const id of mentioned) {
    if (revisedInsufficient.has(id)) {
      // 仍需在 README 中显式说明数据作废，不能静默略过。
      assert.match(readme, new RegExp('`' + id + '`（[^）]*作废', 'u'),
        `${id} 的有效轮次不足，README 必须显式说明其旧数据作废`);
      continue;
    }
    assert.ok(claimsSeen.has(id), `${id} 在 README 中被提及但未包含可校验的失败数声明`);
  }

  // evaluation.md：轮次数
  const evRounds = /跑过([一二三四五六七八九十\d]+)轮全量/u.exec(evaluation)?.[1];
  assert.ok(evRounds, 'evaluation.md 应声明全量评测轮次数');
  assert.equal(asNumber(evRounds), roundCount,
    `evaluation.md 声明的轮次（${evRounds}）与记录（${roundCount}）不符`);

  // evaluation.md：各轮失败数序列
  const claimed = /（([\d、]+)）/u.exec(evaluation)?.[1];
  assert.ok(claimed, 'evaluation.md 应声明各轮失败数序列');
  const actual = record.rounds.map(r => r.summary.automatic_failed).join('、');
  assert.equal(claimed, actual, `evaluation.md 的失败数序列（${claimed}）与记录（${actual}）不符`);
});

test('一致性：历史作废轮次、矩阵遮罩与可比性数字对应全部轮次', () => {
  const record = JSON.parse(read('evals/results/real-model-2026-10-10-rounds.json'));
  const matrix = record.cross_round_matrix;
  const revisions = record.case_revisions;
  assert.equal(matrix.rows.length, record.rounds.length);
  for (const [id, raw] of Object.entries(matrix.matrix)) {
    const revision = revisions.find(item => item.case_id === id);
    const invalidated = revision?.invalidated_rounds ?? [];
    const expected = [...raw].map((value, index) => invalidated.includes(record.rounds[index].round) ? '-' : value).join('');
    assert.equal(matrix.valid_matrix[id], expected, `${id} 的作废轮次必须与 valid_matrix 遮罩一致`);
    if (!invalidated.length) continue;
    const description = matrix.invalidated_rows[id];
    assert.ok(description, `缺少 ${id} 的作废轮次说明`);
    const range = /r(\d+)\s*[-–]\s*r?(\d+)/u.exec(description);
    assert.ok(range, `${id} 的说明必须明确 r 起止轮次`);
    const stated = Array.from({ length: Number(range[2]) - Number(range[1]) + 1 }, (_, index) => Number(range[1]) + index);
    assert.deepEqual(stated, invalidated, `${id} 的 invalidated_rows 说明不得遗漏已作废轮次`);
  }
  const counts = record.rounds.map(round => round.summary.automatic_failed);
  assert.ok(matrix.comparability_warning.includes(counts.join('、')),
    `可比性说明必须列全 ${counts.length} 轮历史失败数：${counts.join('、')}`);
  assert.match(matrix.comparability_warning, /不可比较/u);
  assert.match(record.case_design_review.review_scope, /保留/u);
  assert.match(record.case_design_review.review_scope, /撤回/u);
  assert.match(record.case_design_review.review_scope, /不是当前审批/u);
  assert.match(record.skill_change_validation_2.historical_scope, /保留/u);
  assert.match(record.skill_change_validation_2.historical_scope, /不描述当前判据/u);
  assert.match(record.skill_change_validation_2.historical_scope, /未归档/u);
  const findings = record.skill_change_validation_2.full_run_findings;
  assert.match(findings.real_noncompliance_again, /safety-condition-first/u);
  assert.match(findings.current_review_note, /撤回/u);
  assert.match(findings.current_review_note, /only after/u);
  assert.match(findings.current_review_note, /不能证明安全动作顺序错误/u);
  assert.match(findings.current_review_note, /原历史字段与判定保留/u);
});


test('一致性：简单时态按完整时间关系判断而非孤立词', () => {
  const skill = read('SKILL.md');
  const row = /^\|\s*简单时态的判据\s*\|([^|]+)\|([^|]+)\|/mu.exec(skill);
  assert.ok(row, 'SKILL.md 必须包含「简单时态的判据」行');
  const [, body, boundary] = row;
  assert.match(body, /延续至今|影响现在/u, '必须说明什么时候保留现在完成时');
  assert.match(body, /已结束的过去/u, '必须说明什么时候改用简单过去时');
  assert.match(body, /since Monday/u, '应给出「延续至今」的示例');
  assert.match(body, /完整时间表达/u);
  assert.match(body, /不凭孤立词/u);
  assert.match(body, /since yesterday/u);
  assert.match(boundary, /本身不说明重启已经发生/u);
  assert.match(boundary, /不明时保留原时态/u, '必须给出时间不明时的退路，避免过度改写');

  const cases = JSON.parse(read('evals/cases.json'));
  const conversion = cases.find(c => c.id === 'simple-tense-conversion');
  const relevance = cases.find(c => c.id === 'current-time-relevance');
  assert.ok(conversion && relevance, '两个时态案例必须同时存在（一个好改、一个必须保留）');
  assert.match(conversion.source, /The restart finished yesterday\./u,
    'simple-tense-conversion 必须明确重启已结束');
  assert.match(relevance.source, /since \w+/u,
    'current-time-relevance 应含延续至今的时间标记');
  for (const id of ['future-restart-tense', 'since-yesterday-continuity', 'unclear-restart-tense']) {
    const item = cases.find(entry => entry.id === id);
    assert.ok(item, `缺少时态边界案例：${id}`);
    assert.ok(item.human_review.some(dimension => dimension.includes('人工')));
  }
});


test('一致性：「稳定遵守」章节不得列入有失败记录的案例', () => {
  // 本会话中 ambiguous-actor（r1 失败）与 safety-condition-first（三轮失败）
  // 曾被列进「稳定遵守」章节，理由是当时手上只有 5 轮的旧数据。
  const recordPath = resolve(ROOT, 'evals/results/real-model-2026-10-10-rounds.json');
  assert.ok(existsSync(recordPath), '历史评测记录必须存在，不能静默跳过稳定性检查');
  const record = JSON.parse(readFileSync(recordPath, 'utf8'));
  const matrix = record.cross_round_matrix.valid_matrix ?? record.cross_round_matrix.matrix;
  const evaluation = read('references/evaluation.md');

  // 只取「稳定遵守」章节里「有效轮次内无失败」那段。
  const section = /#### 稳定遵守[^\n]*\n([\s\S]*?)(?=\n下列案例|\n####)/u.exec(evaluation)?.[1] ?? '';
  assert.ok(section, 'evaluation.md 应有「稳定遵守」章节');

  const offenders = [];
  for (const match of section.matchAll(/`([a-z][a-z0-9-]+)`/gu)) {
    const id = match[1];
    if (!matrix[id]) continue;
    const failures = matrix[id].split('').filter(c => c === 'X' || c === 'E').length;
    if (failures > 0) offenders.push(`${id}(${failures} 次失败)`);
  }
  assert.deepEqual(offenders, [],
    `「稳定遵守」章节列入了有失败记录的案例：${offenders.join('、')}；应移入「有失败记录」段或修正数据`);

  // 反向：「有失败记录」段提到的案例必须真的有失败。
  const failedSection = /下列案例\*\*有失败记录[^\n]*\n([\s\S]*?)(?=\n`current-time|\n####)/u.exec(evaluation)?.[1] ?? '';
  const wrong = [];
  for (const match of failedSection.matchAll(/`([a-z][a-z0-9-]+)`/gu)) {
    const id = match[1];
    if (!matrix[id]) continue;
    if (!/[XE]/u.test(matrix[id])) wrong.push(id);
  }
  assert.deepEqual(wrong, [],
    `「有失败记录」段列入了零失败的案例：${wrong.join('、')}`);
});


test('一致性：评测主记录引用的输出文件存在且条目完整', () => {
  // 逐例原始输出已拆到独立文件，主记录只保留判定与结论。
  // 若输出文件丢失或被截断，主记录的判定就无法核对。
  const recordPath = resolve(ROOT, 'evals/results/real-model-2026-10-10-rounds.json');
  assert.ok(existsSync(recordPath), '历史评测记录必须存在，不能静默跳过输出完整性检查');
  const record = JSON.parse(readFileSync(recordPath, 'utf8'));
  assert.ok(record.output_index, '主记录应声明 output_index');
  const outputsPath = resolve(ROOT, record.output_index);
  assert.ok(existsSync(outputsPath), `主记录引用的输出文件不存在：${record.output_index}`);
  const outputs = JSON.parse(readFileSync(outputsPath, 'utf8'));

  // 每个 (轮次, 案例) 都必须有对应条目。
  const missing = [];
  let total = 0;
  for (const r of record.rounds) {
    for (const c of r.results) {
      total += 1;
      if (!outputs.outputs[`r${r.round}.${c.case_id}`]) missing.push(`r${r.round}.${c.case_id}`);
    }
  }
  assert.deepEqual(missing.slice(0, 5), [],
    `输出文件缺少 ${missing.length}/${total} 条条目，例如：${missing.slice(0, 5).join('、')}`);
  assert.equal(outputs.entry_count, Object.keys(outputs.outputs).length,
    '输出文件的 entry_count 与实际键数不符');
  const missingSources = Object.entries(outputs.outputs).filter(([, entry]) => entry.source === '');
  const missingRounds = [...new Set(missingSources.map(([key]) => Number(/^r(\d+)\./u.exec(key)[1])))];
  assert.equal(missingSources.length, 190, '历史缺失不得用当前 source 补填');
  assert.deepEqual(missingRounds, [3, 4, 5, 6, 7]);
  for (const disclosure of [record.output_index_note, read('references/evaluation.md')]) {
    assert.match(disclosure, new RegExp(`共 ${missingSources.length} 条 source 为空`, 'u'));
    assert.match(disclosure, /r3–r7/u);
    assert.match(disclosure, /历史来源缺失/u);
    assert.match(disclosure, /无法[^。]*重建[^。]*输入/u);
    assert.match(disclosure, /不用当前案例补填/u);
  }
  assert.equal(record.semantic_approval, 'pending-human-review');

  // 主记录不得回退成内嵌原始输出（那会重新变大、影响复核）。
  const leaked = [];
  for (const r of record.rounds) {
    for (const c of r.results) {
      if ('output' in c || 'source' in c) leaked.push(`r${r.round}.${c.case_id}`);
    }
  }
  assert.deepEqual(leaked.slice(0, 5), [],
    `主记录不应内嵌原始输出（已拆到 ${record.output_index}）：${leaked.slice(0, 5).join('、')}`);
});


test('一致性：记录中的叙述字段与逐轮数据一致', () => {
  // 独立复核发现：逐轮字段（rounds/matrix）可信，但写给读者看的叙述字段
  // （reading、skill_revisions.effect、constraint_defects_fixed 等）停留在过去的轮次，
  // 且没有任何门禁。本测试把可机检的部分固定下来。
  const recordPath = resolve(ROOT, 'evals/results/real-model-2026-10-10-rounds.json');
  assert.ok(existsSync(recordPath), '历史评测记录必须存在，不能静默跳过叙述一致性检查');
  const record = JSON.parse(readFileSync(recordPath, 'utf8'));
  const rounds = record.rounds.length;
  const validMatrix = record.cross_round_matrix.valid_matrix;

  // 1. cross_round_matrix.reading 不得残留旧轮次的数据。
  const reading = (record.cross_round_matrix.reading ?? []).join(' ');
  assert.ok(reading, 'cross_round_matrix 应含 reading');
  // 模式串必须与当前轮次数等长（旧版残留的是 4 字符模式）。
  for (const match of reading.matchAll(/`?([oX]{2,})`?/gu)) {
    assert.equal(match[1].length, rounds,
      `reading 里的模式串 ${match[1]} 长度为 ${match[1].length}，与当前 ${rounds} 轮不符（疑似旧轮次残留）`);
  }
  const cn = { '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9, '十': 10 };
  // 只检查「轮次总数」的表述，例如「七轮中」「七轮全量」「N 轮全部通过」。
  // 「随后六轮通过」「第二轮」等相对/序数表述是合法的，不应误报。
  for (const match of reading.matchAll(/([一二三四五六七八九十\d]+)轮(?:中|全量|全部|里)/gu)) {
    const n = /^\d+$/u.test(match[1]) ? Number(match[1]) : cn[match[1]];
    assert.equal(n, rounds, `reading 的轮次总数「${match[1]}轮」与当前 ${rounds} 轮不符`);
  }

  // 2. reading 里提到的失败次数≥2 案例，必须与 valid_matrix 一致。
  const repeated = new Set(record.cross_round_matrix.valid_candidates_with_repeated_failures.map(x => x.case_id));
  for (const [id, row] of Object.entries(validMatrix)) {
    const fails = row.split('').filter(c => c === 'X').length;
    const mentioned = reading.includes(id);
    if (fails >= 2) {
      assert.ok(mentioned, `reading 未提及失败 ${fails} 次的案例：${id}`);
    }
  }
  assert.ok(repeated.size > 0, '应至少有一个失败次数≥2 的案例');

  // 3. skill_revisions_after_evaluation.effect 不得声称「所有轮次」同一版本，
  //    除非逐轮 skill_sha256 真的只有一个值。
  const versions = new Set(record.rounds.map(r => r.skill_sha256).filter(Boolean));
  for (const rev of record.skill_revisions_after_evaluation ?? []) {
    if (/所有轮次|均绑定/u.test(rev.effect ?? '')) {
      assert.equal(versions.size, 1,
        `effect 声称所有轮次同版本，但逐轮 skill_sha256 有 ${versions.size} 个不同值`);
    }
  }

  // 4. 适配器是否入库的两种说法不得并存。
  const notes = [record.adapter_note, record.environment?.adapter_scope].filter(Boolean).join(' ');
  const saysIncluded = /已(?:作为示例)?纳入仓库/u.test(notes);
  const saysExcluded = /未纳入仓库/u.test(notes);
  assert.ok(!(saysIncluded && saysExcluded),
    '记录同时声称适配器「已纳入仓库」与「未纳入仓库」');

  // 5. 约束缺陷计数：记录数组长度必须等于 summary 声明的总数。
  const defects = record.findings?.constraint_defects_fixed ?? [];
  const summary = /共 (\d+) 处/u.exec(record.findings?.constraint_defects_summary ?? '')?.[1];
  if (summary) {
    assert.equal(defects.length, Number(summary),
      `constraint_defects_fixed 有 ${defects.length} 条，但 summary 声明 ${summary} 处`);
  }
  const lesson = record.constraint_testing_lesson;
  assert.equal(cn[/已出现([一二三四五六七八九十]+)处/u.exec(lesson)?.[1]], defects.length);
  for (const category of ['误杀', '误放']) {
    const count = defects.filter(defect => defect.includes(`（${category}）`)).length;
    assert.match(lesson, new RegExp(`${category} ${count}(?!\\d)`, 'u'));
  }

  const review = record.case_design_review;
  for (const [category, verdict] of [
    ['案例设计缺陷', /^案例设计有缺陷/u],
    ['约束缺陷', /^约束缺陷/u],
    ['规则冲突', /^SKILL\.md 规则本身有冲突/u],
    ['真实模型未执行', /^案例设计正确，模型确实未执行/u],
  ]) {
    const count = review.reviewed.filter(item => verdict.test(item.verdict)).length;
    assert.ok(count > 0, `${category} 应对应真实复核条目`);
    assert.match(review.outcome, new RegExp(`${category} ${count} 个`, 'u'));
  }
  assert.match(review.outcome, new RegExp(`复核的 ${review.reviewed.length} 个案例`, 'u'));

  const tenseId = 'simple-tense-conversion';
  const tenseReading = record.cross_round_matrix.reading.find(item => item.startsWith(`${tenseId}：`));
  assert.ok(tenseReading, '简单时态应明确列出失败与通过轮次');
  const claims = [...tenseReading.matchAll(/((?:r\d+、)*r\d+) (失败|通过)/gu)];
  assert.equal(claims.length, 2);
  for (const [, labels, verdict] of claims) {
    for (const label of labels.split('、')) {
      const round = Number(label.slice(1));
      const passed = verdict === '通过';
      assert.equal(validMatrix[tenseId][round - 1], passed ? 'o' : 'X');
      assert.equal(record.rounds.find(item => item.round === round).results
        .find(item => item.case_id === tenseId).automatic_passed, passed);
    }
  }
  const firstRound = record.rounds.find(item => item.round === 1);
  const firstColumn = Object.values(record.cross_round_matrix.matrix).map(row => row[0]);
  const failures = firstColumn.filter(value => value === 'X').length;
  const errors = firstColumn.filter(value => value === 'E').length;
  assert.equal(firstRound.summary.automatic_failed, failures + errors);
  assert.match(firstRound.summary_note, new RegExp(`${failures} 个 X 加 ${errors} 个 E`, 'u'));
  const secondRoundNote = record.rounds.find(item => item.round === 2).note;
  assert.match(secondRoundNote, /当时约束集/u);
  assert.doesNotMatch(secondRoundNote, /最终约束集的权威测量/u);

  const probe = record.stability_probe;
  const safety = probe.behavior_distribution['safety-condition-first'];
  const notFirst = safety.filter(value => value === '未前置').length;
  const safetyConclusion = probe.conclusions.find(item => item.startsWith('safety-condition-first：'));
  assert.equal(safety.length, probe.rounds);
  assert.match(safetyConclusion, new RegExp(`${safety.length - notFirst}/${safety.length} 前置`, 'u'));
  assert.match(safetyConclusion, new RegExp(`${notFirst}/${safety.length} 未前置`, 'u'));
  assert.match(safetyConclusion, /原始专项报告未归档/u);
  assert.match(safetyConclusion, /不确定/u);

  // 6. 记录中不得残留 SKILL.md:NN 行号引用（SKILL.md 会追加规则行，行号会失效）。
  const lineRefs = [...JSON.stringify(record).matchAll(/SKILL\.md:\d+/gu)].map(m => m[0]);
  assert.deepEqual([...new Set(lineRefs)], [],
    `记录中残留 SKILL.md 行号引用（改用规则名）：${[...new Set(lineRefs)].join('、')}`);
  // 7. 主记录不得回退到逐字段展开的格式（那会从 800 行涨到 2500+ 行，
  //    重新拖慢复核）。逐例判定应压成一行一条。
  const rawRecord = readFileSync(recordPath, 'utf8');
  const lineCount = rawRecord.split('\n').length;
  assert.ok(lineCount < 1500,
    `主记录 ${lineCount} 行，超过 1500 行的上限：逐例判定被展开成多行，`
    + '会重新拖慢独立复核。请用紧凑序列化重排（每例一行）。');
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
