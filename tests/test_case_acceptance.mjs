/** 评测约束的接受度门禁：合法改写样例必须通过，且案例源文必须具备区分度。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { checkInvariants } from '../scripts/evaluate.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cases = JSON.parse(readFileSync(resolve(ROOT, 'evals/cases.json'), 'utf8'));
const byId = id => {
  const item = cases.find(entry => entry.id === id);
  assert.ok(item, `cases.json 缺少案例：${id}`);
  return item;
};
const accepted = (item, response) => checkInvariants(item, response).filter(check => !check.passed);
const assertAccepted = (item, response, note) => {
  const failed = accepted(item, response);
  assert.deepEqual(failed.map(check => `${check.name}:${JSON.stringify(check.expected)}`), [],
    `${item.id} 不应拒掉合法改写（${note}）`);
};
const assertRejected = (item, response, note) => {
  assert.ok(accepted(item, response).length > 0, `${item.id} 必须拒掉不合规输出（${note}）`);
};

test('接受度：safety-condition-first 接受多种条件前置写法', () => {
  const item = byId('safety-condition-first');
  // 约束不能只认某一种措辞；这四种都是「条件置前」的合法表达。
  assertAccepted(item,
    'Before you remove the panel, disconnect the power supply. Do not reconnect power until the panel is secured.',
    'Before 从句前置');
  assertAccepted(item,
    '1. Disconnect the power supply.\n2. Remove the panel.\n3. Do not reconnect power until the panel is secured.',
    '步骤列表');
  assertAccepted(item,
    'Disconnect the power supply. Then remove the panel. Do not reconnect power until the panel is secured.',
    '拆成两句');
  assertAccepted(item,
    'Disconnect the power supply before you remove the panel. Do not reconnect power until the panel is secured.',
    'before 后置从句');
  // 仍然必须拒掉原文的从句后置结构。
  assertRejected(item,
    'Remove the panel only after you disconnect the power supply. Do not reconnect power until the panel is secured.',
    '条件后置');
  assertRejected(item, item.source, '原文');
});

test('接受度：glossary-authority 不因大小写或句首变化误杀', () => {
  const item = byId('glossary-authority');
  assertAccepted(item,
    'Terminology: use "queue" for the message buffer.\n\nThe queue stores pending messages. When the queue is full, the sender waits.',
    '保留原大小写');
  assertAccepted(item,
    'Use "queue" for the message buffer. The queue stores pending messages. When the queue is full, the sender waits.',
    '句首大写、无 Terminology 前缀');
  assertRejected(item, item.source, '原文');
});

test('接受度：条件列表化时保留 MUST 强度', () => {
  const item = byId('condition-list');
  assertAccepted(item,
    'The job stops if:\n- the file is missing\n- the checksum fails\n- the user cancels\nThe job must also stop if the disk is full.',
    '保留 must');
  assertRejected(item,
    'The job stops if:\n- the file is missing\n- the checksum fails\n- the user cancels\n- the disk is full.',
    '丢失 must');
});

test('区分度：句长类案例的源文必须真正超过步骤阈值', () => {
  // 若源文每句都不超 20 词，20/25 两套阈值就没有区分度，
  // 「步骤与说明分别处理」也就失去了可测性。
  const words = text => (text.match(/[A-Za-z0-9][A-Za-z0-9'’-]*/gu) ?? []).length;
  for (const id of ['mixed-text-type', 'numbers-and-units', 'requirement-strength', 'condition-and-exception']) {
    const item = byId(id);
    const body = item.source.replace(/```[\s\S]*?```/gu, '');
    const longest = Math.max(...body.split(/(?<=[.!?])\s+/u).map(words));
    assert.ok(longest > 20,
      `${id} 的源文最长句为 ${longest} 词，未超过步骤阈值 20，无法测出句长处理`);
  }
});

test('接受度：source-boundary-clarification 接受多种澄清措辞', () => {
  const item = byId('source-boundary-clarification');
  // 字面匹配无法容忍插词；「请先确认」曾因约束只写「请确认」而被误判。
  assertAccepted(item,
    '无法确定待改写原文的范围，请先确认。最后一行有两种理解：\n\n1. 它属于待改写原文。\n2. 它是你对本次任务的要求。\n\n请说明属于哪一种。',
    '请先确认 + 请说明属于哪一种');
  assertAccepted(item,
    '请确认需要改写的原文范围。\n\n最后一行是您的指令，还是待改写原文的一部分？',
    '请确认');
  assertAccepted(item,
    '无法确定范围，最后一行是待改写原文，还是给我的指令？请标明。',
    '请标明');
  // 未澄清的纯改写必须被拒。
  assertRejected(item,
    'The service inspects the input file.\n\nDo not change the preceding sentence. Explain each change in Chinese.',
    '直接改写未澄清');
  assertRejected(item, item.source, '原文');
});


test('接受度：safety-condition-first 必须保留第二句的否定关系', () => {
  const item = byId('safety-condition-first');
  // 丢掉 do not reconnect power until... 会丢掉核心安全约束。
  assertRejected(item, 'Do not remove the panel until you disconnect the power supply.', '丢失「不重连」否定');
  assertAccepted(item,
    'Disconnect the power supply. Then remove the panel. Do not reconnect power until the panel is secured.',
    '拆句但保留否定');
});


test('接受度：ambiguous-actor 接受多种澄清措辞', () => {
  const item = byId('ambiguous-actor');
  // 首轮只接受英文问号，模型用中文澄清时被误判；这四种都是合法澄清。
  assertAccepted(item,
    '原句中的 it 有两种解读，需要先确认 finishes 的主语，请指出哪一种符合原意。', '中文请指出');
  assertAccepted(item, '两个 it 指代不明。请说明哪一个是发送者。', '请说明');
  assertAccepted(item, '请确认 it 指哪一方。', '请确认');
  // 已知短板：把原文加一个问号也能过。此处刻意固定该行为，
  // 以免后人误以为约束很强；收紧会重新引入对合法澄清的误杀。
  assertAccepted(item, 'The agent sends the report to the reviewer after it finishes?', '仅加问号（过弱，不修）');
  // 直接选一个解释成稿不是澄清，必须被拒。
  assertRejected(item, 'After the agent finishes, the agent sends the report to the reviewer.', '直接选 agent 解释');
  assertRejected(item, 'After the reviewer finishes, the agent sends the report to the reviewer.', '直接选 reviewer 解释');
});


test('接受度：no-op 类案例的约束与原样返回契约一致', () => {
  for (const item of cases) {
    if (!item.invariants?.equals_input) continue;
    // 要求原样返回的案例，必须接受源文本身。
    assertAccepted(item, item.source, '原样返回');
  }
});
