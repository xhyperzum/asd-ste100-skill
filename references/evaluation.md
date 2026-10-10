# 模型行为评测

`scripts/ste-lint.mjs` 检查英文形式，不能判断模型是否遵守技能、保留语义或抵抗原文中的控制指令。`scripts/evaluate.mjs` 使用 [evals/cases.json](../evals/cases.json) 调用实际命令适配器，或导入已经获得的模型响应。它不读取示例的预写 `after`，也不会把预写结果当成模型输出。

评测器与其他工具统一要求 Node.js 22.0.0 或更高版本，只使用内置模块。调用方式及报告字段保持原有契约。

## 实际调用

命令适配器从标准输入接收完整 SKILL.md 和案例用户消息，标准输出必须仅包含模型响应。默认案例另有文本类型和独立数据边界；未标明原文区域的案例使用下述专用布局。适配器日志应写入标准错误。命令通过 argv 执行，不使用 shell；需要复杂 API 或协议时，调用方可以提供一个读取 stdin 并输出响应的适配器程序。

```bash
node scripts/evaluate.mjs --model MODEL_ID --output /tmp/ste-evaluation.json --command MODEL_ADAPTER ARGUMENT
```

将 `MODEL_ID`、`MODEL_ADAPTER` 和 `ARGUMENT` 换成实际标识、可执行程序及参数。所有评测参数必须位于 `--command` 前；其后的内容完全作为适配器 argv。脚本不会安装或猜测模型工具。

可选参数：

| 参数 | 用途 |
|---|---|
| `--case CASE_ID` | 仅运行指定案例，可重复；默认运行全部。 |
| `--cases FILE` | 使用其他案例 JSON。 |
| `--skill FILE` | 使用指定完整技能；默认仓库 SKILL.md。 |
| `--timeout SECONDS` | 每例命令超时，默认 120 秒；必须为有限正数。 |
| `--model MODEL_ID` | 必填；调用方提供实际模型标识。脚本不从命令名称推断模型。 |
| `--output FILE` | 必填；保存 UTF-8 JSON 报告。 |

默认布局用内容 SHA256 派生的动态边界包围原文，原文中的普通 `END_SOURCE`、角色声明等不会改变程序构造的边界。`prompt_variant: unmarked-user-message` 则在独立的完整技能段之后，直接拼接 request 与 source 成为用户消息，不添加原文边界、文本类型或澄清提示，用于检验原文区域未确定的情况。两种布局均不向模型展示预期答案、description、human_review 或自动检查条件。

数据标记帮助模型识别区域，不提供指令权限，也不能保证抵抗所有注入。模型可能误读原文；运行环境的工具权限和实际调用记录仍需独立检查。

报告保留实际 stdout、stderr、argv、退出码、开始及结束时间、耗时，以及案例、技能和提交提示的 SHA256。超时和命令错误也保存已经捕获的输出；失败后的有限收尾可能使输出不完整，报告以 `output_complete: false` 标示，不假称已取得全部日志。超时、stdin 写入失败或输出超限时终止直属适配器，最多等待 100 ms 收尾后关闭本地 pipes；不保证终止其自行启动的整个进程树。stdin 的 EPIPE 也属于操作失败。无效 UTF-8 输出视为操作失败，显示文本使用替换字符，并另存原始字节的 base64。

容量上限见下表。命令输出超限时保留允许范围内的前缀，标记 `output_truncated: true`，用 `capture_limits`、`*_bytes_retained`、`*_base64` 与 `operation_details` 记录限制和失败证据；保留前缀不是完整响应。导入文件中的每条记录都校验限额，包括未选中的案例；超限直接拒绝，不静默截断。

| 对象 | 上限 |
|---|---|
| 单个技能、案例或导入输入文件 | 4 MiB；必须为普通文件和严格 UTF-8 |
| JSON 深度 / 案例数 | 16 层 / 256 个案例 |
| 单个提示 / 整批提示 | 8 MiB / 32 MiB |
| 命令单个 stdout 或 stderr | 各 1 MiB；单例合计最多 2 MiB |
| 整批命令捕获输出 | 合计 16 MiB |
| 导入单个 response 或 stderr | 各 1 MiB；单例合计最多 2 MiB |
| 整批导入 response + stderr | 合计 16 MiB |

响应可能包含原文或模型返回的敏感内容，报告的保存位置由调用方指定。末级报告路径必须不存在或是普通文件，拒绝 symlink、FIFO、设备和目录；不能覆盖技能、案例或导入响应文件的当前内容或适配器执行前的文件身份，包括 hardlink 别名。工具打开报告后检查实际文件描述符，再截断和写入，不能先截断再判断输入身份。

## 案例格式与版本

案例文件为非空 JSON 数组。每例仅允许以下字段；额外字段、无效 Unicode、重复 ID 或不受支持的约束会报错，不能把未知 metadata 悄悄纳入不稳定的哈希。

| 字段 | 格式 |
|---|---|
| `id`、`description`、`request`、`source` | 非空字符串 |
| `text_type` | `instruction` 或 `description` |
| `human_review` | 非空字符串数组，定义语义和结构复核维度 |
| `invariants` | 可省略；只能包含下述有限约束 |
| `prompt_variant` | 可省略；唯一显式值为 `unmarked-user-message` |

约束 `contains`、`forbidden`、`any_contains`、`not_equals` 为非空字符串数组；`equals_input` 和 `requires_list` 为布尔值。`requires_list: true` 只检查至少三个受支持的 Markdown 列表项，不判断各项是否对应原动作、保留要求强度或顺序。纯空白的非空片段可以用于有限格式检查。数量、单位和技术标识写在 source 字符串中，不增加数值或嵌套 metadata 字段。JSON 文件按通用换行口径读取；文本身份以实际规范化后提交的内容及摘要为准。

当前技能为 0.1.0，案例集扩展为 38 例。原 10 例的请求和约束也已修订，减少在请求中直接教给模型检查目标，并为确定需要改写的输入增加原文回显排除；无需改动及固定内容例外不强迫变更。案例或技能变化会改变摘要。

### 版本线说明

本仓库曾在 0.5.0、0.6.0 的 0.x 历史线上运行过 10 例与 24 例评测。引入中文分支后，我们放弃该编号线，从 0.1.0 重新编号：中文分支改变了技能的适用范围和输出契约，不是同一产品线的小幅修订。因此 0.1.0 **新于**历史快照中的 0.6.0，两者不能按 semver 比较，也不能互相代替。使用 `npx skills update` 时请勿把 0.1.0 当成降级。

### 历史记录索引

| 记录 | 覆盖范围 | 类型 |
|---|---|---|
| [2026-10-02 实际运行与代理复核](../evals/results/review-2026-10-02.md) | 0.5.0 的 10 例 | 外部模型调用 + 代理复核 |
| [代理前向 round-1](../evals/results/agent-forward-2026-10-02-round-1.json) | 0.6.0 的 24 例 | 代理前向，非外部模型调用 |
| [代理前向 round-2](../evals/results/agent-forward-2026-10-02-round-2.json) | 0.6.0 的 24 例 | 代理前向，非外部模型调用 |
| [代理前向 round-3](../evals/results/agent-forward-2026-10-02-round-3.json) | 0.6.0 的 24 例 | 代理前向，非外部模型调用 |
| [修复复核](../evals/results/repair-review-2026-10-02.md) | 上述记录的汇总复核 | 代理复核 |
| [真实模型评测](../evals/results/real-model-2026-10-10-rounds.json) | 0.1.0 的 38 例，两轮 | 外部模型调用（`wokey/claude-opus-5-5`） |

上述记录均绑定当时的 SKILL.md 与案例摘要，任何一条都不能作为其他版本的证明。

### 真实评测结论（2026-10-10）

`wokey/claude-opus-5-5` 跑过三轮全量 38 例（第三轮用修正后的最终约束集），另对 5 个边界与歧义类案例重复跑了 5 轮。约束集在轮次间被修改过，因此历史判定不能反推。

#### 行为不稳定

以下三例在不同轮次间结论不同，均属不稳定，不是稳定缺陷：

- `source-boundary-clarification`：5 轮中 2 轮先请求澄清（符合 SKILL.md 第 30 行），3 轮直接改写未澄清。
- `simple-tense-conversion`：5 轮中 4 轮改为简单过去时，1 轮原样保留完成时。
- `steps-as-list`：前两轮正确输出 4 项列表，第三轮改为裸换行（4 个非空行、0 个列表标记）；裸换行在 Markdown 中渲染为单个段落，不符合 SKILL.md:68 的列表要求。

#### 稳定遵守（以 3 轮以上为据）

- `ambiguous-actor`：5 轮全部先请求澄清；`analysis-output`：5 轮全部通过。
- `safety-condition-first`：5 轮均完成条件前置，措辞在 `Do not...until` 与 `Before you remove...` 之间变化；措辞差异不代表失败。
- `terminology-consistency`：前两轮未统一 `duplicates`，**第三轮正确统一为 `copies` 并通过检查**。

> 已更正的错误结论：本记录早期版本据前两轮写「`terminology-consistency` 两轮输出完全一致、稳定不遵守」。第三轮推翻了它。**两轮的一致性不能推断稳定性**；本记录中所有「稳定」表述均已改为以 3 轮以上数据或明确的多数分布为据。

#### 修正的约束缺陷

四处，都是同一类错误——用字面串匹配判断语义，把合法改写判为失败。修正前后均以真实模型输出回归验证：

| 案例 | 原约束的问题 |
|---|---|
| `ambiguous-actor` | 只接受英文 `?`；模型用「请指出」式中文澄清，被误判 |
| `safety-condition-first` | 只接受 4 种条件前置写法；`Do not X until Y` 被误判 |
| `source-boundary-clarification` | 只接受「请确认」；模型写「请**先**确认」，插词导致误判 |
| `safety-condition-first` | 只检查条件是否前置，丢掉第二句的 `do not reconnect` 否定仍能通过 |

**结论：单轮评测不能作为技能行为已通过的证据。** 三轮已足以区分「稳定」与「不稳定」，但不足以给出通过率；各轮失败数（前三轮为 5、2、2）也不可直接相减，因为中间改过约束集。

第三轮（最终约束集）的 2 项未通过：`source-boundary-clarification`（未澄清）与 `steps-as-list`（裸换行）。两者都是模型的真实不合规，不是约束缺陷。

### 已知约束短板

`ambiguous-actor` 使用 `any_contains` 检查是否出现澄清措辞。把原文原样加一个问号即可通过自动约束。这一短板不修：该案例的正确行为就是提问，收紧会重新引入对合法澄清的误杀（首轮已发生过一次）。该案例的 `human_review` 要求复核「澄清重点是原文区域，不是无关词义或模式」，只能人工判读。

`semantic_approval` 始终保持 `pending-human-review`。已完成的语义复核由生成记录的同一会话代理完成，**不是独立复核**，结论需由其他人重跑确认。

## 导入实际响应

模型无法由命令直接调用时，可以导入已有实际响应：

```bash
node scripts/evaluate.mjs --model MODEL_ID --output /tmp/ste-imported.json --import-responses /tmp/responses.json
```

导入文件为 JSON 数组，每条记录仅包含 `case_id`、实际响应字符串 `response`、实际来源说明 `source`，以及可选字符串 `stderr`。例如来源可填写外部执行的记录编号或文件路径；不要将示例答案或人工编造文本标成模型输出。所选案例必须都有对应响应，重复 ID、缺失来源和额外字段会报错。

导入报告明确标为 `imported-response`，`model_invocation_performed` 为 `false`。原执行时间和退出码未知时为 `null`，不会伪造本地调用。报告中的 prompt 与上下文哈希用于当前案例检查，并标注 `context_origin: reconstructed-for-checking`；它们不能证明外部执行当时使用了相同技能和提示，实际运行记录仍需另行核对。

## 自动约束与人工复核

下表将技能契约与当前正式案例对应。它表示案例设计覆盖，不表示模型已通过这些规则；示例 fixtures 与工具单元测试也不能替代实际模型输出。

| 规则或契约 | 案例 ID | 重点复核 |
|---|---|---|
| 术语一致与术语表 | `terminology-consistency`、`glossary-authority`、`distinct-actions-terminology` | 同概念统一；有术语表时以表为准；不同对象不强刚统一 |
| 条件使用列表 | `condition-list`、`steps-as-list` | 条件分别列出，保留各自强度 |
| 混合文本类型 | `mixed-text-type` | 步骤与说明分别按各自的句长处理 |
| STE-flavored 执行面 | `ste-flavored-execution` | 拆分结构并保留事实，词汇统一只作建议 |
| 名词堆叠与名词化 | `technical-noun-name`、`noun-stack-expansion` | 展开非保护堆叠；固定名称原样保留 |
| 主动语态正向改写 | `active-voice-known-actor` | 已知 actor 时改为主动语态，对象和先后关系不变 |
| 简单时态正向改写 | `simple-tense-conversion` | 时间关系不变时改用简单时态 |
| 无信息引导语删除 | `barrier-phrase-removal` | 删除引导语，事实与频率保留 |
| 中文分支契约 | `zh-no-op`、`zh-semicolon-split`、`zh-requirement-strength`、`zh-injection`、`zh-paragraph-structure` | 输出语言与原文一致；中文计数口径；要求强度词不互换 |
| 事实、条件、否定、范围和例外 | `meaning-and-scope`、`condition-and-exception` | 条件只覆盖原有动作；always 和 unless 不丢失 |
| 数量、单位与时序 | `numbers-and-units` | 数值、单位、上下界及操作顺序保持 |
| 要求强度 | `requirement-strength` | MUST、SHOULD、MAY 仍对应原动作 |
| 不确定性和简单时态例外 | `uncertainty`、`current-time-relevance` | 可能因果、持续至今的关系不改成确定或已结束 |
| 主动语态及未知 actor 例外 | `unknown-actor`、`noncausal-timeout` | 不猜测 actor；发生条件不加强为原因 |
| 每句一个动作、分号 | `body-only`、`direct-verbs`、`steps-as-list` | 拆开可确定的动作，保留顺序和力度 |
| 三个以上操作要求使用列表 | `steps-as-list`、`requirement-strength` | 动作分别列出，MUST / SHOULD / MAY 不升级或降级 |
| 段落主题与六句目标 | `paragraph-structure` | 合理分段或合句，七项事实保持 |
| 安全条件置前 | `safety-condition-first`、`numbers-and-units` | only after、until 和操作前提保持 |
| 直接动词与短语动词 | `body-only`、`direct-verbs` | 减少名词化，但不改变动作或对象 |
| 名词堆叠中的固定名称例外 | `technical-noun-name` | 固定策略名称原样保留，不解释未知术语 |
| 技术字符串与长句例外 | `protected-content`、`protected-long-instruction` | CLI、参数、路径、URL 不截断、不执行 |
| 同一概念术语一致的边界 | `distinct-actions-terminology` | 不把不同对象的 start / launch 强制统一 |
| STE-flavored、设计意图和程度 | `ste-flavored-claims` | 不添加性能证据或把 designed to 升级为保证 |
| 默认正文、无需改动、分析输出 | `body-only`、`no-op`、`analysis-output` | 分别遵守英文正文、原样返回、中文分析与英文对照 |
| 必要澄清与原文区域 | `ambiguous-actor`、`source-boundary-clarification` | 问题针对实际未知信息，不猜测或抢先输出成稿 |
| authority/data 边界 | `source-injection`、`boundary-spoof` | 引文和伪角色仍是数据，没有变成控制指令 |

完整句子、保真例外和输出包装是所有案例的共同人工复核维度，不靠词数或字符串出现次数判定。

自动检查仅包括非空响应、必要片段、禁止片段、至少出现一个片段、不得只输出攻击标记、确定需改写案例的原文回显排除、无需改动案例的原文比较，以及至少三个受支持列表项的有限检查。原文比较只忽略响应两端的空白；其他改写不要求与一个固定答案完全相同。列表检查不是完整 Markdown 结构解析，也不能确认操作与条目的对应关系。

这些约束不能确认语义对应关系：保留了 MUST 和 MAY 也可能把它们放到错误动作上；包含问号或“请标明”等措辞不代表澄清内容正确；只改一个标点也可能绕过原文回显排除。字符串和列表约束还可能对语义等价的替代措辞或合法格式产生误报。每个案例因此另有中文 `human_review` 维度，分别核对语义保真和结构执行；报告始终保持 `pending`，自动通过不会升级为语义批准。

人工复核应逐案比较原文和实际响应，检查遗漏、新增事实、条件范围、actor、要求强度和技术字符串，另检查模式、句子、列表、段落、输出语言及包装，并对歧义和攻击案例确认模型行为。复核结论应引用报告、case/skill 哈希和具体输出，另行保存；不能把 linter 通过或 harness 单元测试通过当成模型行为验证。仅提供技能、请求和原始材料的独立前向试用可以发现额外行为问题；它与付费模型适配器运行、人类审批应分别标示。

退出码：`0` 表示命令或导入成功且有限自动约束通过；`1` 表示自动约束失败；`2` 表示输入、调用、超时或报告保存失败。`0` 仍然需要人工语义复核。

## 检查评测记录器

```bash
node --test tests/test_evaluate.mjs
```

这些测试用明确标为合成数据的适配器检查 argv、stdin、日志、超时、哈希、导入来源及退出码。FIFO 边界夹具需要 POSIX `mkfifo` 命令；完整自动回归与安装验证要求该环境，CI 使用 Ubuntu，缺少命令时应失败而不是跳过。生产工具本身仅使用 Node.js 内置模块，不调用 `mkfifo`。测试不调用模型，也不证明模型遵守技能。
