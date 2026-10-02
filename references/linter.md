# 检查器：CLI、能力与边界

本文是 `scripts/ste-lint.mjs` 的接口与机械检查能力说明。技能的改写规则以 [SKILL.md](../SKILL.md) 为准。检查器仅依赖 Node.js 22 或更高版本的内置模块，不需要 npm 依赖，不调用模型、外部词典或 NLP 服务。

## 输入与 CLI

检查文件，也可以不传文件名而从标准输入读取：

```bash
node scripts/ste-lint.mjs --text-type instruction instructions.md
node scripts/ste-lint.mjs --text-type description description.md
printf '%s\n' 'The job may have failed.' | node scripts/ste-lint.mjs --json
node scripts/ste-lint.mjs --baseline 5 legacy.md
node scripts/ste-lint.mjs --disable passive-voice,present-perfect text.md
node scripts/ste-lint.mjs --list-rules
node scripts/ste-lint.mjs --list-rules --json
node scripts/ste-lint.mjs --selftest
```

| 参数 | 含义 |
|---|---|
| `FILE [FILE ...]` | 以 UTF-8 读取一个或多个文件；省略时读取标准输入。 |
| `--text-type instruction` | 所有输入按指令检查，单句上限为 20 词。 |
| `--text-type description` | 所有输入按说明检查，单句上限为 25 词；这是默认值。 |
| `--json` | 输出结构化结果。检查报告包含 `schema_version`（整数 `1`）、`text_type`、`max_words`、`violations`、`count`、`hard_count`、`baseline`、`words` 和 `per_100_words`。 |
| `--baseline N` | 允许硬性问题总数不超过非负整数 `N`；默认 `0`。 |
| `--disable rule1,rule2` | 按规则 ID 禁用检查。规则 ID 以 `--list-rules` 为准；未知 ID 或空项会报参数错误。 |
| `--list-rules` | 显示规则 ID、等级及能力说明，可与 `--json` 配合。 |
| `--selftest` | 使用 `node:test` 运行 `tests/test_ste_lint.mjs`，只覆盖 Node 检查器回归。 |

文本类型由调用方选择，检查器不会自动识别指令或推断 Strict 模式。混合文档应拆成不同输入并分别设置类型。

`--selftest` 必须单独使用；`--list-rules` 仅可与 `--json` 组合。两种操作互斥，都不能携带文件、`--baseline`、`--disable` 或 `--text-type`；即使显式传入默认值也会报错。无效组合返回 `2`，不会忽略选项后继续运行。普通文本检查可以组合这些检查参数。

正常检查时，硬性问题总数超过基准返回退出码 `1`，否则返回 `0`。advisory 不增加硬性问题数。参数或输入错误返回退出码 `2`，并提供错误说明。

## 规则等级

运行时的规则 ID、等级、类型和限制以 `--list-rules` 返回的统一元数据为准。下表解释当前规则的能力，不作为另一份规则配置维护。

每条规则同时登记元数据和可调用的执行器，`lint()` 统一执行目录中的检查器。登记时拒绝缺失执行器和重复 ID，新增规则不能只出现在帮助中而不参与检查。

“硬性”指确定出现受支持的形式，不代表判断出语义错误或官方 STE 不合规。结构化结果保留等级名称 `advisory-free`（硬性）和 `advisory`（建议）；规则类型为 `deterministic` 或 `heuristic`。`--list-rules --json` 输出 `schema_version` 和 `rules`，每条规则含 `id`、`level`、`type`、`description`、`limitations`。

| 规则 ID | 等级 | 检查内容与限制 |
|---|---|---|
| `semicolon` | 硬性 | 正文分号；代码区域不参与检查。 |
| `long-sentence` | 硬性 | 正文句子超过选定文本类型的词数上限；句子切分是启发式处理。 |
| `dangling-conjunction` | 硬性 | 受支持列表项末尾的英文 `and` 或 `or`；不判断完整句法。 |
| `phrasal-verb` | advisory | 内置的有限短语动词模式，不涵盖所有英语短语动词。 |
| `nominalization` | advisory | 内置动作名词化模式，不进行完整词性或语义分析。 |
| `marketing-adjective` | advisory | 提示部分质量主张；不能证明没有依据，也不能要求删掉原文程度或虚构数据。 |
| `passive-voice` | advisory | 正则识别可能的被动语态；不猜测 actor，也可能匹配形容词。 |
| `present-perfect` | advisory | 正则识别部分复合时态；保护部分情态完成式，如 `may have failed`，不是完整语法分析。 |
| `synonym-rotation` | advisory | 文件内出现词表中的多个近义词时提示；不能确认它们描述同一概念、对象或动作。 |

例如 `Start the service. Launch the browser.` 可以触发近义词提示，但两个动作语境不同，不能据此强制改成同一动词。advisory 应结合原文判断，不能通过自动替换直接“修复”。

## 计数与源位置

正文按空白分隔计算词数，标点不单独计词。排除代码围栏、缩进代码、inline code、列表标记、ATX 标题开头的 `#` 标记、表格分隔行及水平线或 Setext 分隔行。行内代码视为不计词的独立操作数，防止其两侧单词被正则拼接成新的短语。

段落内的软换行合并后检查句长，不能通过将一个长句拆成多个物理行规避阈值。空行与 Markdown 块边界分隔检查单元。普通标题正文和表格正文单元格也参与检查。

行号和列号指向**原始输入**，从 `1` 开始；列号按 Unicode code point 计算，不是终端显示宽度。跨行问题定位到该问题在原文中的起始位置。删除或遮蔽 inline code 后不会把其后的报告位置左移。

## 支持的 Markdown 子集

- 列表标记前允许 `0` 至 `3` 个空格；支持 `-`、`*`、`+`、数字加 `.` 或 `)`；标记后使用 ASCII 空格。按标记及间隔宽度识别续行，检查最后一条有效内容是否为悬空连词。
- 围栏使用反引号或波浪号，开启与关闭标记必须各占独立物理行，前面仅有空格缩进。关闭围栏必须与开启围栏使用相同字符，且长度至少相同；围栏内另一种字符不会结束当前围栏。
- 忽略围栏代码和受支持的缩进代码；inline code 不参与词语检查。
- 常见 pipe 表格通过表头及分隔行识别，列数相同的正文行按单元格分别检查；表格分隔行不参与正文检查。

它不是完整 CommonMark 解析器。引用块内的列表、使用 Tab 分隔标记的列表、懒惰续行和完整嵌套列表语义不在支持范围内。列表标记同一行直接开启的围栏（例如 `- ```python`）不受支持；应将开启围栏另起一行并按列表内容缩进。ATX 标题可选的结尾 `#` 标记不会去除，因此可能计入词数。缩写、小数、复杂嵌套结构等可能影响句子切分或分段，不应将解析结果视为正式语言学分析。

## 检查器不能证明的事项

检查器不比较原文与改写稿，因此不验证事实、条件、数量、否定、要求强度、时间关系或 actor 是否保持。它也不检查所有技能规则，例如名词堆叠、每句一条指令、段落主题及安全条件覆盖范围，更不核验官方批准词典。

结果为零只表示当前启用规则在受支持输入范围内没有发现问题。用户应按技能的保真流程对照原文；合法的保真例外可以保留并在用户要求分析时说明。

## 示例资源

[英文语料](../examples/fixtures.json)记录独立英文输入、输出和词数；[中文解释](../examples/before-after.md)说明其保真要求。[边界样例](../examples/linter-edge-cases.md)故意包含两个悬空连词硬性问题，执行以下命令应报告它们并返回 `1`：

```bash
node scripts/ste-lint.mjs examples/linter-edge-cases.md
```
