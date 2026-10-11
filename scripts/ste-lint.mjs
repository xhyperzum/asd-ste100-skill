#!/usr/bin/env node
/** 检查 STE 结构规则，并提供不改变原意的启发式建议。 */
import { readFile, stat } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runTests } from './run-tests.mjs';

export class Rule {
  constructor(id, level, type, description, limitations, checker) {
    if (typeof checker !== 'function') throw new Error(`规则 ${id} 缺少可执行 checker`);
    Object.assign(this, { id, level, type, description, limitations, checker });
    Object.freeze(this);
  }

  metadata() {
    const { id, level, type, description, limitations } = this;
    return { id, level, type, description, limitations };
  }
}

// Python 的 Unicode 空白集合包含 U+001C 至 U+001F，且不包含 BOM。
const SPACE_BODY = String.raw`\t\n\v\f\r\u001c-\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000`;
const WORD_BODY = String.raw`\p{L}\p{N}_`;
const WORD_BOUNDARY = `(?:(?<=[${WORD_BODY}])(?![${WORD_BODY}])|(?<![${WORD_BODY}])(?=[${WORD_BODY}]))`;

/** 显式迁移 Unicode 词字符、边界和空白，避免 JavaScript 默认 ASCII 边界改变结果。 */
function compatibleRegex(source, flags = '') {
  let expanded = '';
  let inClass = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (character === '\\') {
      const next = source[++index];
      if (next === 'w') expanded += inClass ? WORD_BODY : `[${WORD_BODY}]`;
      else if (next === 's') expanded += inClass ? SPACE_BODY : `[${SPACE_BODY}]`;
      else if (next === 'b' && !inClass) expanded += WORD_BOUNDARY;
      else expanded += `\\${next}`;
    } else if (character === '[') {
      inClass = true;
      expanded += character;
    } else if (character === ']') {
      inClass = false;
      expanded += character;
    } else if (!inClass && flags.includes('i') && /[iI]/.test(character)) {
      // Python re.I 还会匹配点状和无点的土耳其字母 I。
      expanded += '[iIİı]';
    } else {
      expanded += character;
    }
  }
  if (flags.includes('i')) expanded = expanded.replaceAll('[A-Za-z]', '[A-Za-zİıſK]');
  return new RegExp(expanded, flags.includes('u') ? flags : `${flags}u`);
}

const TRIM_START = compatibleRegex(String.raw`^\s+`);
const SPACE_CHARACTER = compatibleRegex(String.raw`^\s$`);
const trimStart = text => text.replace(TRIM_START, '');
const trim = text => {
  let end = text.length;
  while (end > 0 && SPACE_CHARACTER.test(text[end - 1])) end -= 1;
  return trimStart(text.slice(0, end));
};
const codepointLength = text => [...text].length;
const CODE_OPERAND = '\ufffc';
const BACKTICK_RUN = /`+/gu;
const CODE_FENCE = /^(?<marker>`{3,}|~{3,})(?<tail>.*)$/u;
const BLANK_LINE = /^[ \t]*$/u;
const LIST_ITEM_START = /^(?<indent> {0,3})(?<marker>[-*+]|[0-9]+[.)])(?<gap> +)(?<body>.*)$/u;
const TABLE_SEPARATOR_CELL = /^:?-+:?$/u;
const CONJUNCTION_END = compatibleRegex(String.raw`\b(?:and|or)\s*$`, 'i');
const MODAL_BEFORE_HAVE = compatibleRegex(String.raw`\b(?:may|might|could|should|would|must|can|will|shall)(?:n't)?(?:\s+(?:not|never|also|already|just|even|still|yet|ever|well|perhaps|\w+ly))*\s*(?=have\b)`, 'ig');
const ABBREVIATION_END = compatibleRegex(String.raw`(?:\b(?:[A-Za-z]\.){2,}|\b(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr|vs|etc|Fig|No)\.)$`, 'i');
const WORD_TOKEN = compatibleRegex(String.raw`[^\s\ufffc]+`, 'g');
const BLOCK_SEPARATOR = /^ {0,3}(?:-(?:[ \t]*-){2,}|\*(?:[ \t]*\*){2,}|_(?:[ \t]*_){2,})[ \t]*$/u;
const SETEXT_UNDERLINE = /^ {0,3}(?:=+|-+)[ \t]*$/u;
const HEADING = /^ {0,3}#{1,6}(?:[ \t]+|$)/u;
const SENTENCE_BOUNDARY = compatibleRegex(String.raw`(?<=[.!?])["'”’)\]}]*\s+`, 'g');
const TEXT_LIMITS = Object.freeze({ instruction: 20, description: 25 });
const SCHEMA_VERSION = 1;
const SYNONYM_GROUPS = [
  ['check', 'verify', 'confirm', 'validate'], ['delete', 'remove', 'erase'],
  ['start', 'launch', 'begin', 'initiate'], ['stop', 'halt', 'terminate'],
  ['show', 'display'], ['use', 'utilize', 'employ'], ['fix', 'repair', 'correct'],
  ['send', 'transmit'], ['get', 'retrieve', 'fetch', 'obtain'], ['change', 'modify', 'alter'],
];

// 中文术语一致性只提示有限词表内的近义词，不判断不同对象或动作是否同义。
const SYNONYM_GROUPS_ZH = [
  ['检查', '核查', '校验'], ['删除', '移除', '清除'],
  ['启动', '开启', '发起'], ['停止', '终止', '停用'],
  ['显示', '展示', '呈现'], ['使用', '采用', '利用'],
  ['修改', '更改', '变更'], ['获取', '读取', '取得'],
  ['发送', '传输', '传送'], ['创建', '新建', '生成'],
];
// 要求强度词用于估计一段中的操作要求数量，不判断它们是否真的对应不同操作。
// 要求强度词只在完整词形下计数；单字「应」「须」会命中「响应」「应用」「必须」等普通词。
const ZH_REQUIREMENT_MODAL = /(?:必须|应当|应该|可以|不得|禁止|需要)/gu;
const ZH_PARAGRAPH_SENTENCE_TARGET = 6;

// 中文规范按汉字与西文词计数；句长上限为项目适配值，与英文词数上限不是换算关系。
const TEXT_LIMITS_ZH = Object.freeze({ instruction: 20, description: 30 });
const ZH_CONJUNCTION_END = compatibleRegex(String.raw`(?:和|或|以及|并且|或者|同时)\s*$`);
const HAN_CHARACTER = /\p{Script=Han}/u;
const HAN_VARIATION_SELECTOR = /^[\uFE00-\uFE0F\u{E0100}-\u{E01EF}]$/u;
const TOKEN_CHARACTER = /[\p{L}\p{N}\p{M}]/u;
const DECIMAL_DIGIT = /^\p{Nd}$/u;
const ZH_TOKEN = /[\p{L}\p{N}\p{M}]/gu;
const ZH_SENTENCE_TERMINATOR = /[。！？]/u;
const ZH_SENTENCE_CLOSER = new Set(['”', '’', '」', '』', '）', ')', ']', '】', '》']);

/** 英文按空白切词，返回词数与首词索引。 */
function countTokensEn(text) {
  const tokens = [...matches(WORD_TOKEN, text)];
  return [tokens.length, tokens.length ? tokens[0].index : -1];
}

/** 中文每个汉字计 1，连续西文或数字串计 1，标点与行内代码不计。 */
function countTokensZh(text) {
  let count = 0;
  let first = -1;
  for (const match of matches(ZH_TOKEN, text)) {
    const offset = match.index;
    let previous = [...text.slice(Math.max(0, offset - 2), offset)].at(-1) ?? '';
    if (HAN_VARIATION_SELECTOR.test(match[0]) && HAN_CHARACTER.test(previous)) continue;
    if (HAN_VARIATION_SELECTOR.test(previous)) {
      const base = [...text.slice(Math.max(0, offset - 4), offset - previous.length)].at(-1) ?? '';
      if (HAN_CHARACTER.test(base)) previous = base;
    }
    const continuesNumber = previous === '.'
      && DECIMAL_DIGIT.test([...text.slice(Math.max(0, offset - 3), offset - 1)].at(-1) ?? '')
      && DECIMAL_DIGIT.test(match[0]);
    // 汉字逐个计；西文串只在它不是紧跟在同类字符之后时计 1。
    if (HAN_CHARACTER.test(match[0])
      || previous === '' || (!TOKEN_CHARACTER.test(previous) && !continuesNumber) || HAN_CHARACTER.test(previous)) {
      if (first < 0) first = offset;
      count += 1;
    }
  }
  return [count, first];
}

/** 英文句边界沿用缩写保护后的 `.`、`!`、`?`。 */
function enSentenceEnds(text) {
  return [...matches(SENTENCE_BOUNDARY, text)]
    // 名称缩写最长 5 个字符；两个末尾字母加点已足以识别点状缩写。
    // 保留前一个 Unicode 字符的空间，避免截断词边界，同时不反复扫描正文前缀。
    .filter(match => !ABBREVIATION_END.test(text.slice(Math.max(0, match.index - 8), match.index)))
    .map(match => match.index + match[0].length);
}

/** 中文按 `。`、`！`、`？` 分句，并允许句末闭合引号或括号。 */
function zhSentenceEnds(text) {
  const ends = [];
  for (let index = 0; index < text.length; index += 1) {
    if (!ZH_SENTENCE_TERMINATOR.test(text[index])) continue;
    let end = index + 1;
    while (end < text.length && ZH_SENTENCE_CLOSER.has(text[end])) end += 1;
    ends.push(end);
  }
  return ends;
}

function matches(pattern, text) {
  const global = pattern.flags.includes('g') ? pattern : new RegExp(pattern.source, `${pattern.flags}g`);
  return text.matchAll(global);
}

class Segment {
  constructor(listId = null) {
    this.text = '';
    this.positions = [];
    this.listId = listId;
  }

  append(text, line, column) {
    if (this.text) {
      this.text += ' ';
      this.positions.push([line, column]);
    }
    this.text += text;
    let offset = 0;
    for (const character of text) {
      // UTF-16 的两个单元共享同一个 Unicode 字符列号。
      for (let unit = 0; unit < character.length; unit += 1) this.positions.push([line, column + offset]);
      offset += 1;
    }
  }
}

/** 每个代码字符替换一个操作数，并同步调整 UTF-16 索引到原始位置的映射。 */
function maskInlineCode(text, positions = Array.from({ length: text.length }, (_, index) => index)) {
  let masked = '';
  const mapped = [];
  let previous = 0;
  const runs = [...matches(BACKTICK_RUN, text)];
  const closingIndexes = new Array(runs.length);
  const escapedClosingIndexes = new Array(runs.length);
  const nextByLength = new Map();
  for (let runIndex = runs.length - 1; runIndex >= 0; runIndex -= 1) {
    const length = runs[runIndex][0].length;
    closingIndexes[runIndex] = nextByLength.get(length) ?? -1;
    escapedClosingIndexes[runIndex] = nextByLength.get(length - 1) ?? -1;
    nextByLength.set(length, runIndex);
  }
  for (let runIndex = 0; runIndex < runs.length; runIndex += 1) {
    const opening = runs[runIndex];
    let escapes = 0;
    while (text[opening.index - escapes - 1] === "\\") escapes += 1;
    const markerLength = opening[0].length - escapes % 2;
    if (!markerLength) continue;
    const closingIndex = (escapes % 2 ? escapedClosingIndexes : closingIndexes)[runIndex];
    if (closingIndex < 0) continue;
    const start = opening.index + escapes % 2;
    const end = runs[closingIndex].index + markerLength;
    masked += text.slice(previous, start);
    for (let index = previous; index < start; index += 1) mapped.push(positions[index]);
    let index = start;
    for (const character of text.slice(start, end)) {
      masked += CODE_OPERAND;
      mapped.push(positions[index]);
      index += character.length;
    }
    previous = end;
    runIndex = closingIndex;
  }
  masked += text.slice(previous);
  for (let index = previous; index < positions.length; index += 1) mapped.push(positions[index]);
  return [masked, mapped];
}

function indentation(line) {
  let length = 0;
  let width = 0;
  while (line[length] === ' ' || line[length] === '\t') {
    width += line[length] === '\t' ? 4 - width % 4 : 1;
    length += 1;
  }
  return { length, width };
}

function trimAscii(text) {
  let end = text.length;
  while (end > 0 && (text[end - 1] === ' ' || text[end - 1] === '\t')) end -= 1;
  return text.slice(0, end).replace(/^[ \t]+/u, '');
}

function isEscaped(text, index) {
  let backslashes = 0;
  while (index > 0 && text[index - 1] === '\\') {
    backslashes += 1;
    index -= 1;
  }
  return backslashes % 2 === 1;
}

function splitTableRow(line) {
  let left = line.length - line.replace(/^[ \t]+/u, '').length;
  let content = trimAscii(line);
  if (!content.includes('|')) return null;
  const endsWithPipe = content.endsWith('|') && !isEscaped(content, content.length - 1);
  const hasOuterPipe = content.startsWith('|') || endsWithPipe;
  if (content.startsWith('|')) {
    content = content.slice(1);
    left += 1;
  }
  if (endsWithPipe) content = content.slice(0, -1);
  const [masked, offsets] = maskInlineCode(content);
  const cuts = [...matches(/\|/gu, masked)]
    .filter(match => !isEscaped(masked, match.index)).map(match => offsets[match.index]);
  if (!cuts.length && !hasOuterPipe) return null;
  const cells = [];
  let start = 0;
  let column = left;
  for (const end of [...cuts, content.length]) {
    const raw = content.slice(start, end);
    const leading = raw.length - raw.replace(/^[ \t]+/u, '').length;
    cells.push([trimAscii(raw), column + leading]);
    column += codepointLength(raw) + 1;
    start = end + 1;
  }
  return cells;
}

function splitLines(text) {
  if (!text) return [];
  const lines = text.split(/\r\n|[\n\r\v\f\u001c-\u001e\u0085\u2028\u2029]/u);
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

function segmentsFor(text) {
  const lines = splitLines(text);
  const segments = [];
  const items = [];
  let current = null;
  let activeItem = null;
  let fence = null;
  let tableWidth = null;
  const flush = () => {
    if (current !== null && trim(current.text)) {
      [current.text, current.positions] = maskInlineCode(current.text, current.positions);
      segments.push(current);
      if (current.listId !== null) items[current.listId].segments.push(current);
    }
    current = null;
  };
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index];
    const line = index + 1;
    const { length: indentLength, width: indent } = indentation(raw);
    const blank = BLANK_LINE.test(raw);
    const stripped = raw.slice(indentLength);
    const fenceMatch = CODE_FENCE.exec(stripped);
    if (fence !== null) {
      if (fence[2] > 0 && !blank && indent < fence[2]) {
        fence = null;
        activeItem = null;
      } else {
        if (fenceMatch && fenceMatch.groups.marker[0] === fence[0]
            && fenceMatch.groups.marker.length >= fence[1] && BLANK_LINE.test(fenceMatch.groups.tail)
            && indent <= fence[2] + 3) fence = null;
        continue;
      }
    }
    if (!blank && activeItem !== null && indent < items[activeItem].contentIndent) {
      if (current !== null && current.listId === activeItem) flush();
      activeItem = null;
      tableWidth = null;
    }
    const fenceIndent = activeItem === null ? 0 : items[activeItem].contentIndent;
    if (fenceMatch && indent <= fenceIndent + 3
        && (fenceMatch.groups.marker[0] !== '`' || !fenceMatch.groups.tail.includes('`'))) {
      flush();
      tableWidth = null;
      fence = [fenceMatch.groups.marker[0], fenceMatch.groups.marker.length, indent >= fenceIndent ? fenceIndent : 0];
      continue;
    }
    if (blank) {
      flush();
      tableWidth = null;
      continue;
    }
    const itemContinuation = activeItem !== null && indent >= items[activeItem].contentIndent;
    const blockIndent = itemContinuation ? indent - items[activeItem].contentIndent : indent;
    const heading = blockIndent <= 3 ? HEADING.exec(stripped) : null;
    const separatorBlock = blockIndent <= 3 &&
      (BLOCK_SEPARATOR.test(stripped) || (current !== null && current.listId === activeItem
        && SETEXT_UNDERLINE.test(stripped)));
    let start = heading || separatorBlock ? null : LIST_ITEM_START.exec(raw);
    if (start && current !== null && current.listId === null
        && (BLANK_LINE.test(start.groups.body)
          || (/^[0-9]/u.test(start.groups.marker) && !/^0*1[.)]$/u.test(start.groups.marker)))) start = null;
    const continuation = itemContinuation && !start;
    if (!continuation) activeItem = null;
    const codeIndent = continuation ? items[activeItem].contentIndent + 4 : 4;
    const indented = indent >= codeIndent;
    const row = (!indented || tableWidth !== null) && !start && !heading && !separatorBlock
      ? splitTableRow(raw) : null;
    if (!row || row.length !== tableWidth) tableWidth = null;
    if (row && !indented && tableWidth === null && index + 1 < lines.length) {
      const next = lines[index + 1];
      const nextIndent = indentation(next).width;
      const minIndent = activeItem === null ? 0 : items[activeItem].contentIndent;
      const separator = nextIndent >= minIndent && nextIndent < codeIndent && !LIST_ITEM_START.test(next)
        ? splitTableRow(next) : null;
      if (separator && separator.length === row.length
          && separator.every(([cell]) => TABLE_SEPARATOR_CELL.test(cell))) {
        tableWidth = row.length;
        index += 1;
      }
    }
    if (indented && current === null && tableWidth === null) {
      flush();
      continue;
    }
    if (tableWidth !== null) {
      flush();
      for (const [cell, column] of row) {
        const segment = new Segment(activeItem);
        segment.append(cell, line, column + 1);
        [segment.text, segment.positions] = maskInlineCode(segment.text, segment.positions);
        segments.push(segment);
        if (activeItem !== null && trim(segment.text)) items[activeItem].segments.push(segment);
      }
      continue;
    }
    if (separatorBlock) {
      flush();
      continue;
    }
    let body;
    let column;
    if (start) {
      flush();
      activeItem = items.length;
      body = start.groups.body;
      const emptyBody = BLANK_LINE.test(body);
      const bodyIndex = start.groups.indent.length + start.groups.marker.length
        + (emptyBody ? 1 : start.groups.gap.length);
      items.push({ markerPosition: [line, start.groups.indent.length + 1], contentIndent: bodyIndex, segments: [] });
      if (emptyBody) continue;
      current = new Segment(activeItem);
      column = bodyIndex + 1;
    } else if (heading) {
      flush();
      body = stripped.slice(heading[0].length);
      column = indentLength + heading[0].length + 1;
      current = new Segment(activeItem);
    } else {
      if (current === null || current.listId !== activeItem) {
        flush();
        current = new Segment(activeItem);
      }
      body = trimStart(raw);
      column = codepointLength(raw) - codepointLength(body) + 1;
    }
    current.append(body, line, column);
    if (heading) flush();
  }
  flush();
  return { segments, items };
}

function regexChecker(pattern, protectModal = false) {
  return function* check(context) {
    for (const segment of context.segments) {
      const protectedHave = protectModal
        ? new Set([...matches(MODAL_BEFORE_HAVE, segment.text)].map(match => match.index + match[0].length)) : null;
      for (const match of matches(pattern, segment.text)) {
        if (protectModal && match[1].toLowerCase() === 'have' && protectedHave.has(match.index)) continue;
        yield { position: segment.positions[match.index], match: match[0] };
      }
    }
  };
}

function regexRule(id, level, type, description, limitations, pattern, protectModal = false) {
  return new Rule(id, level, type, description, limitations, regexChecker(pattern, protectModal));
}

function* checkLongSentences(context) {
  for (const segment of context.segments) {
    let sentenceStart = 0;
    for (const sentenceEnd of [...context.sentenceEnds(segment.text), segment.text.length]) {
      const [tokens, firstIndex] = context.countTokens(segment.text.slice(sentenceStart, sentenceEnd));
      if (tokens > context.maxWords) {
        yield {
          position: segment.positions[sentenceStart + Math.max(0, firstIndex)],
          match: `${tokens} ${context.measureMatch}`,
          message: `句子有 ${tokens} 个${context.measureNoun}（上限 ${context.maxWords}）。请拆分句子。`,
        };
      }
      sentenceStart = sentenceEnd;
    }
  }
}

function* checkDanglingConjunction(context) {
  for (const item of context.items) {
    if (!item.segments.length) continue;
    const last = item.segments.at(-1);
    const match = context.conjunctionEnd.exec(last.text);
    if (match) {
      const source = last.positions[match.index];
      const position = source[0] === item.markerPosition[0] ? item.markerPosition : source;
      yield { position, match: trim(last.text) };
    }
  }
}

function comparePositions(left, right) {
  return left[0] - right[0] || left[1] - right[1];
}

function* checkSynonymRotation(context) {
  const seen = new Map();
  for (const segment of context.segments) {
    SYNONYM_GROUPS.forEach((group, groupIndex) => {
      for (const base of group) {
        const key = `${groupIndex}:${base}`;
        if (seen.has(key)) continue;
        const pattern = compatibleRegex(String.raw`\b${base}(?:s|es|ed|d|ing)?\b`, 'i');
        const match = pattern.exec(segment.text);
        if (match) seen.set(key, { position: segment.positions[match.index], match: match[0], base });
      }
    });
  }
  for (let groupIndex = 0; groupIndex < SYNONYM_GROUPS.length; groupIndex += 1) {
    const present = SYNONYM_GROUPS[groupIndex].map(base => seen.get(`${groupIndex}:${base}`)).filter(Boolean)
      .sort((left, right) => comparePositions(left.position, right.position) || (left.base < right.base ? -1 : 1));
    if (present.length > 1) {
      const first = present[0].base;
      for (const { position, match, base } of present.slice(1)) {
        yield { position, match, message: `出现了 '${base}' 和 '${first}'。请核对是否表示同一动作；不同动作可以使用不同词。` };
      }
    }
  }
}

/** 一段中出现三个或更多要求强度词时，提示改为列表。 */
function* checkListRequired(context) {
  for (const segment of context.segments) {
    const hits = [...matches(ZH_REQUIREMENT_MODAL, segment.text)];
    if (hits.length < 3) continue;
    yield {
      position: segment.positions[hits[0].index],
      match: `${hits.length} 项要求`,
      message: `一段中有 ${hits.length} 个要求强度词。三个或更多操作要求或条件建议改为列表。`,
    };
  }
}

/** 段落句子数超过目标上限时，提示分段或合并。 */
function* checkParagraphTopic(context) {
  for (const segment of context.segments) {
    let sentences = 0;
    let start = 0;
    for (const end of [...context.sentenceEnds(segment.text), segment.text.length]) {
      if (context.countTokens(segment.text.slice(start, end))[0] > 0) sentences += 1;
      start = end;
    }
    if (sentences > ZH_PARAGRAPH_SENTENCE_TARGET) {
      yield {
        position: segment.positions[0],
        match: `${sentences} 句`,
        message: `段落有 ${sentences} 句（目标最多 ${ZH_PARAGRAPH_SENTENCE_TARGET} 句）。请考虑分段或合并。`,
      };
    }
  }
}

/** 中文近义词轮换提示；不判断不同对象或动作是否同义。 */
function* checkSynonymRotationZh(context) {
  const seen = new Map();
  for (const segment of context.segments) {
    SYNONYM_GROUPS_ZH.forEach((group, groupIndex) => {
      for (const base of group) {
        const key = `${groupIndex}:${base}`;
        if (seen.has(key)) continue;
        const index = segment.text.indexOf(base);
        if (index >= 0) seen.set(key, { position: segment.positions[index], match: base, base });
      }
    });
  }
  for (let groupIndex = 0; groupIndex < SYNONYM_GROUPS_ZH.length; groupIndex += 1) {
    const present = SYNONYM_GROUPS_ZH[groupIndex].map(base => seen.get(`${groupIndex}:${base}`)).filter(Boolean)
      .sort((left, right) => comparePositions(left.position, right.position) || (left.base < right.base ? -1 : 1));
    if (present.length > 1) {
      const first = present[0].base;
      for (const { position, match, base } of present.slice(1)) {
        yield { position, match, message: `出现了 '${base}' 和 '${first}'。请核对是否表示同一概念；不同对象或动作可以使用不同术语。` };
      }
    }
  }
}

export function ruleCatalog(rules) {
  const catalog = new Map();
  for (const rule of rules) {
    if (typeof rule.checker !== 'function') throw new Error(`规则 ${rule.id} 缺少可执行 checker`);
    if (catalog.has(rule.id)) throw new Error(`规则 ID 重复：${rule.id}`);
    catalog.set(rule.id, rule);
  }
  return catalog;
}

export const RULES = Object.freeze([
  regexRule('semicolon', 'advisory-free', 'deterministic', '正文含分号。请拆分为多个句子。', '代码内容不参与检查。', /;/u),
  new Rule('long-sentence', 'advisory-free', 'deterministic', '句子词数超过文本类型上限。',
    '按空白切词；按 .!? 及其后的引号或右括号加空白分句，保护常见缩写和首字母缩写，不实现完整英语语法。', checkLongSentences),
  new Rule('dangling-conjunction', 'advisory-free', 'deterministic', '列表项以 and 或 or 结尾。请补全该项，或将它与下一项合并。',
    '仅支持普通列表标记和按内容缩进的续行；不检查引用内列表。', checkDanglingConjunction),
  regexRule('phrasal-verb', 'advisory', 'heuristic', '可能是宽泛的短语动词。请结合语境考虑简单动词（start、contact、read、begin）。',
    '只匹配有限词表，不判定技术术语或实际含义。', compatibleRegex(String.raw`\b(spin(?:ning|s)? up|spun up|reach(?:ing|es|ed)? out|div(?:e|es|ing|ed) into|dove into|kick(?:ing|s|ed)? off|circl(?:e|es|ing|ed) back|touch(?:ing|es|ed)? base)\b`, 'i')),
  regexRule('marketing-adjective', 'advisory', 'heuristic', '可能是营销修饰语。请核对该主张是否有原文依据。',
    '只匹配有限词表，不要求增加测量数据或删除已有事实。', compatibleRegex(String.raw`\b(seamless(?:ly)?|robust(?:ly)?|cutting-edge|effortless(?:ly)?|blazing[- ]fast|world-class|state-of-the-art|game-chang(?:ing|er))\b`, 'i')),
  regexRule('nominalization', 'advisory', 'heuristic', '可能将动作名词化。请结合语境考虑使用动词。',
    '仅匹配部分动词和名词后缀，不使用词性分析。', compatibleRegex(String.raw`\b(perform|performs|performed|conduct|conducts|conducted|carry out|carries out|carried out)\s+(?:a|an|the)\s+\w+(?:tion|sion|ment|ance|ence|ysis)\b`, 'i')),
  regexRule('passive-voice', 'advisory', 'heuristic', '可能使用了被动语态。仅在原文提供施事者且改写保留原意时使用主动语态。',
    '正则无法可靠区分形容词、分词和被动语态。', compatibleRegex(String.raw`\b(is|are|was|were|been|being)\s+(\w+ed|given|taken|made|done|found|seen|known|shown|written|built|sent|set|run|read|kept|held|left|put)\b(?!\s+(?:to|for|by)\s+\w+ing)`, 'i')),
  regexRule('present-perfect', 'advisory', 'heuristic', '可能使用了复合时态。请核对时间关系；保留有意义的当前相关性和确信程度。',
    '只匹配部分分词；情态动词后的完成式不定式受到保护。', compatibleRegex(String.raw`\b(has|have|had)\s+(?:been\s+)?\w+(?:ed|en)\b`, 'i'), true),
  new Rule('synonym-rotation', 'advisory', 'heuristic', '出现了同组的不同动词。请核对它们是否表示同一动作，再决定是否统一。',
    '有限词表只提示用词一致性，不能判断不同对象或动作是否同义。', checkSynonymRotation),
]);
// 中文规范的核心结构规则；与英文规则并存，由 --language 选择。
export const RULES_ZH = Object.freeze([
  regexRule('zh-semicolon', 'advisory-free', 'deterministic', '中文正文含分号。请拆分为多个句子。', '代码内容不参与检查。', /[;；]/u),
  new Rule('zh-long-sentence', 'advisory-free', 'deterministic', '句子字数超过中文上限。',
    '按汉字与西文词计数；按 。！？ 及句末闭合引号分句，不实现完整中文语法分析。', checkLongSentences),
  new Rule('zh-dangling-conjunction', 'advisory', 'heuristic', '列表项可能以连接词结尾。确认后再补全该项，或将它与下一项合并。',
    '后缀匹配无法确定中文词边界，会误报「总和」「饱和」等词；仅支持普通列表标记和按内容缩进的续行，不检查引用内列表。', checkDanglingConjunction),
  new Rule('zh-list-required', 'advisory', 'heuristic', '一段中出现三个或更多要求强度词。建议改为列表。',
    '按要求强度词的完整词形计数，不判断它们是否真的对应不同操作；不识别单字「应」「须」。', checkListRequired),
  new Rule('zh-paragraph-topic', 'advisory', 'heuristic', '段落句子数超过目标上限。请考虑分段或合并。',
    '按 。！？ 计数句子，不判断主题是否真的不同。', checkParagraphTopic),
  regexRule('zh-multi-action', 'advisory', 'heuristic', '一句可能包含多个动作。请考虑每句只保留一个动作。',
    '只匹配有限连接词，不判断多个分句是否真的表示不同动作。', /(?:并且|而且|同时|以及)/u),
  regexRule('zh-nominalization', 'advisory', 'heuristic', '可能将动作名词化。请结合语境考虑使用直接动词。',
    '只匹配有限动词加双字名词模式，不进行词性分析。', /(?:进行|作出|做出|开展|实施|加以|予以|从事)[\p{Script=Han}]{2}/u),
  regexRule('zh-marketing-adjective', 'advisory', 'heuristic', '可能是空泛修饰语。请核对该主张是否有原文依据。',
    '只匹配有限词表，不要求增加数据或删除已有事实。', /(?:赋能|闭环|抓手|无缝|极致|领先|革命性|颠覆性|强大|卓越|业界|生态化|全方位)/u),
  regexRule('zh-passive', 'advisory', 'heuristic', '可能使用了被动表达。仅在原文提供施事者且改写保留原意时使用主动语态。',
    '正则无法可靠区分被动结构、名词和固定搭配。', /(?:被|受到|遭到)[\p{Script=Han}]/u),
  regexRule('zh-barrier-phrase', 'advisory', 'heuristic', '可能是不承载信息的引导语。请核对删除后是否丢失含义。',
    '只匹配有限词表，不能判断该表达是否承载语气或衔接功能。', /(?:众所周知|不言而喻|值得注意的是|需要指出的是|综上所述|总而言之|简而言之|毋庸置疑|显而易见)/u),
  new Rule('zh-synonym-rotation', 'advisory', 'heuristic', '出现了可能表示同一概念的多个术语。请核对是否统一。',
    '有限词表只提示用词一致性，不能判断不同对象或动作是否同义。', checkSynonymRotationZh),
]);

const LANGUAGE_PROFILES = Object.freeze({
  en: { language: 'en', limits: TEXT_LIMITS, rules: RULES, sentenceEnds: enSentenceEnds, countTokens: countTokensEn,
    conjunctionEnd: CONJUNCTION_END, measureNoun: '词', measureMatch: 'words' },
  zh: { language: 'zh', limits: TEXT_LIMITS_ZH, rules: RULES_ZH, sentenceEnds: zhSentenceEnds, countTokens: countTokensZh,
    conjunctionEnd: ZH_CONJUNCTION_END, measureNoun: '字', measureMatch: '字' },
});
// --disable 只接受当前语言启用的规则 ID；禁用另一种语言的 ID 会报错而不是静默忽略。
const ALL_RULE_CATALOG = ruleCatalog([...new Map(
  [...RULES, ...RULES_ZH].map(rule => [rule.id, rule])).values()]);

export function lint(text, filename = '<stdin>', textType = 'description', rules = null, language = 'en') {
  const profile = LANGUAGE_PROFILES[language];
  if (!profile) throw new Error('language 必须为 en 或 zh');
  if (!Object.hasOwn(profile.limits, textType)) throw new Error('text_type 必须为 instruction 或 description');
  const activeRules = rules === null ? profile.rules : rules;
  ruleCatalog(activeRules);
  const { segments, items } = segmentsFor(text);
  const context = { segments, items, maxWords: profile.limits[textType],
    sentenceEnds: profile.sentenceEnds, countTokens: profile.countTokens,
    conjunctionEnd: profile.conjunctionEnd, measureNoun: profile.measureNoun, measureMatch: profile.measureMatch };
  const findings = [];
  for (const rule of activeRules) {
    for (const hit of rule.checker(context)) {
      findings.push({ file: filename, line: hit.position[0], col: hit.position[1], rule: rule.id,
        level: rule.level, match: hit.match, message: hit.message || rule.description });
    }
  }
  findings.sort((left, right) => left.line - right.line || left.col - right.col || (left.rule < right.rule ? -1 : left.rule > right.rule ? 1 : 0));
  const words = segments.reduce((total, segment) => total + profile.countTokens(segment.text)[0], 0);
  return [findings, words];
}

/** 对 IEEE-754 数值做十进制银行家舍入，避免 Math.round 改变半数边界。 */
function roundOneDecimal(value) {
  if (value === 0) return 0;
  const buffer = new ArrayBuffer(8);
  const view = new DataView(buffer);
  view.setFloat64(0, value);
  const bits = view.getBigUint64(0);
  const exponent = Number((bits >> 52n) & 0x7ffn);
  let numerator = (bits & ((1n << 52n) - 1n)) | (exponent ? 1n << 52n : 0n);
  let denominator = 1n;
  const power = (exponent || 1) - 1075;
  if (power >= 0) numerator <<= BigInt(power);
  else denominator <<= BigInt(-power);
  numerator *= 10n;
  let integer = numerator / denominator;
  const remainder = numerator % denominator;
  if (remainder * 2n > denominator || (remainder * 2n === denominator && integer % 2n === 1n)) integer += 1n;
  return Number(integer) / 10;
}

function report(findings, words, asJson, hardCount, baseline, textType, profile) {
  const rate = words ? roundOneDecimal(findings.length * 100 / words) : 0;
  if (asJson) {
    console.log(JSON.stringify({ schema_version: SCHEMA_VERSION, language: profile.language, text_type: textType,
      max_words: profile.limits[textType], violations: findings, count: findings.length,
      hard_count: hardCount, baseline: typeof baseline === 'bigint' ? JSON.rawJSON(baseline.toString()) : baseline, words, per_100_words: rate }, null, 2));
    return;
  }
  for (const finding of findings) console.log(`${finding.file}:${finding.line}:${finding.col} ${finding.rule}: ${finding.message} [${finding.match}]`);
  console.log(`\n共 ${findings.length} 项问题（硬性 ${hardCount} 项，基准值 ${baseline}），${words} 个${profile.measureNoun}，每 100 ${profile.measureNoun} ${rate.toFixed(1)} 项`);
  console.log('启发式建议需结合语境判断；保留原文的情态、确信程度和时间关系。');
}

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const ROOT_PATH = resolve(dirname(SCRIPT_PATH), '..');
const USAGE = '用法：ste-lint.mjs [-h] [--json] [--baseline N] [--disable IDS] [--language en|zh] [--text-type instruction|description] [--list-rules | --selftest] [FILE ...]';
const HELP = `${USAGE}\n\n检查 STE 结构规则与启发式建议。未提供文件时从 stdin 读取。需要 Node.js 22 或更高版本。\n\n位置参数\n  FILE                 UTF-8 输入文件\n\n选项\n  -h, --help           显示帮助并退出\n  --json               输出 JSON 报告或规则目录\n  --baseline N         允许的硬性问题数，默认 0\n  --disable IDS        禁用规则 ID，以逗号分隔\n  --language LANG      en 使用英文规则（默认）；zh 使用中文规则与字数上限\n  --text-type TYPE     en 为 20/25 词；zh 为 20/30 字\n  --list-rules         列出规则、等级、类型和限制；仅可与 --json 和 --language 组合\n  --selftest           运行 Node.js 回归测试；必须单独使用\n  --                   后续参数全部作为文件名\n`;

class UsageError extends Error {}

function parseArguments(argv) {
  const options = { paths: [], json: false, selftest: false, listRules: false,
    baseline: 0, disable: null, textType: 'description', language: 'en', help: false };
  const provided = new Set();
  let onlyPaths = false;
  const flagNames = new Map([['--json', 'json'], ['--selftest', 'selftest'], ['--list-rules', 'listRules'], ['--help', 'help'], ['-h', 'help']]);
  const valueNames = new Map([['--baseline', 'baseline'], ['--disable', 'disable'], ['--text-type', 'textType'], ['--language', 'language']]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (onlyPaths || !argument.startsWith('-') || argument === '-') {
      options.paths.push(argument);
      continue;
    }
    if (argument === '--') {
      onlyPaths = true;
      continue;
    }
    const equal = argument.indexOf('=');
    const name = equal < 0 ? argument : argument.slice(0, equal);
    if (flagNames.has(name)) {
      if (equal >= 0) throw new UsageError(`参数 ${name} 不接受参数值`);
      options[flagNames.get(name)] = true;
      provided.add(name);
      continue;
    }
    if (!valueNames.has(name)) throw new UsageError(`未知参数：${argument}`);
    let value;
    if (equal >= 0) value = argument.slice(equal + 1);
    else {
      if (index + 1 >= argv.length || (argv[index + 1].startsWith('-') && !/^-[\p{Nd}]+(?:_[\p{Nd}]+)*$/u.test(argv[index + 1]))) {
        throw new UsageError(`参数 ${name} 缺少参数值`);
      }
      value = argv[++index];
    }
    provided.add(name);
    if (name === '--baseline') {
      const normalized = trim(value);
      if (/[\u001c-\u001f]/u.test(value) || !/^[+-]?[\p{Nd}]+(?:_[\p{Nd}]+)*$/u.test(normalized)) {
        throw new UsageError('基准值必须为非负整数');
      }
      // 保留 Unicode 十进制数字、负零和大整数的输入行为，不引入安全整数上限。
      const digits = [...normalized].filter(character => character !== '_').map(character => {
        if (!/\p{Nd}/u.test(character)) return character;
        const point = character.codePointAt(0);
        let first = point;
        while (/\p{Nd}/u.test(String.fromCodePoint(first - 1))) first -= 1;
        return String((point - first) % 10);
      }).join('');
      const number = BigInt(digits);
      if (number < 0n) throw new UsageError('基准值必须为非负整数');
      options.baseline = number <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(number) : number;
    } else if (name === '--text-type') {
      if (!Object.hasOwn(TEXT_LIMITS, value)) throw new UsageError(`参数 --text-type 无效选项值：${value}（可选值为 instruction、description）`);
      options.textType = value;
    } else if (name === '--language') {
      if (!Object.hasOwn(LANGUAGE_PROFILES, value)) throw new UsageError(`参数 --language 无效选项值：${value}（可选值为 en、zh）`);
      options.language = value;
    } else options.disable = value;
  }
  if (options.help) return options;
  if (options.selftest && options.listRules) throw new UsageError('--selftest 和 --list-rules 不能同时使用');
  if (options.selftest || options.listRules) {
    const incompatible = ['--baseline', '--disable', '--text-type'].filter(name => provided.has(name));
    if (options.selftest && provided.has('--language')) incompatible.push('--language');
    if (options.paths.length) incompatible.push('FILE');
    if (options.selftest && options.json) incompatible.push('--json');
    if (incompatible.length) throw new UsageError(`${options.selftest ? '--selftest' : '--list-rules'} 不能与以下参数组合：${incompatible.join(', ')}`);
  }
  options.disabled = new Set(options.disable === null ? [] : options.disable.split(','));
  // 按 --disable 生效时实际使用的规则集校验，而不是两种语言的并集。
  const selectable = ruleCatalog(LANGUAGE_PROFILES[options.language].rules);
  const unknown = [...options.disabled].filter(id => !selectable.has(id)).sort();
  if (unknown.length) {
    const other = options.language === 'en' ? 'zh' : 'en';
    const cross = unknown.filter(id => ALL_RULE_CATALOG.has(id));
    const hint = cross.length ? `（${cross.join(', ')} 属于 --language ${other}，请先切换语言）` : '';
    throw new UsageError(`未知规则 ID：${unknown.join(', ')}${hint}`);
  }
  return options;
}

export async function selftest() {
  const suite = resolve(ROOT_PATH, 'tests', 'test_ste_lint.mjs');
  try {
    if (!(await stat(suite)).isFile()) throw new Error('测试路径不是文件');
  } catch {
    console.error('自检失败：缺少 tests/test_ste_lint.mjs。请使用包含测试文件的完整技能目录。');
    return false;
  }
  try {
    const result = await runTests([suite]);
    if (!result.success) {
      console.error('自检失败：回归测试缺失、未执行或执行失败。');
      return false;
    }
    console.log(`自检完成：${result.registered} 项测试，${result.passed} 项通过。`);
    return true;
  } catch (error) {
    console.error(`自检失败：无法加载测试：${error.message}`);
    return false;
  }
}

async function strictInput(path = null) {
  let buffer;
  if (path !== null) buffer = await readFile(path);
  else {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    buffer = Buffer.concat(chunks);
  }
  // ignoreBOM:true 表示将 BOM 保留为正文字符，与 UTF-8 原文读取口径一致。
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer);
}

export async function main(argv = process.argv.slice(2), selftestRunner = selftest) {
  try {
    const options = parseArguments(argv);
    if (options.help) {
      process.stdout.write(HELP);
      return 0;
    }
    if (options.selftest) return await selftestRunner() ? 0 : 1;
    const profile = LANGUAGE_PROFILES[options.language];
    if (options.listRules) {
      if (options.json) console.log(JSON.stringify({ schema_version: SCHEMA_VERSION, language: options.language, rules: profile.rules.map(rule => rule.metadata()) }, null, 2));
      else for (const rule of profile.rules) {
        console.log(`${rule.id} [${rule.level === 'advisory-free' ? '硬性' : '建议'}，${rule.type === 'deterministic' ? '确定性' : '启发式'}] ${rule.description}\n  限制：${rule.limitations}`);
      }
      return 0;
    }
    let findings = [];
    let words = 0;
    try {
      if (options.paths.length) {
        for (const path of options.paths) {
          const [found, count] = lint(await strictInput(path), path, options.textType, null, options.language);
          for (const finding of found) findings.push(finding);
          words += count;
        }
      } else [findings, words] = lint(await strictInput(), '<stdin>', options.textType, null, options.language);
    } catch (error) {
      throw new UsageError(`无法读取输入：${error.message}`);
    }
    findings = findings.filter(finding => !options.disabled.has(finding.rule));
    const hardCount = findings.filter(finding => finding.level === 'advisory-free').length;
    report(findings, words, options.json, hardCount, options.baseline, options.textType, profile);
    return Number(hardCount > options.baseline);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    console.error(USAGE);
    console.error(`ste-lint.mjs：错误：${error.message}`);
    return 2;
  }
}

let isMain = false;
if (process.argv[1]) {
  try { isMain = realpathSync(resolve(process.argv[1])) === realpathSync(SCRIPT_PATH); } catch { isMain = false; }
}
if (isMain) process.exitCode = await main();
