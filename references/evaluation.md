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

当前技能为 0.6.0，案例集扩展为 24 例。原 10 例的请求和约束也已修订，减少在请求中直接教给模型检查目标，并为确定需要改写的输入增加原文回显排除；无需改动及固定内容例外不强迫变更。案例或技能变化会改变摘要。

[历史 10 例运行及独立代理复核](../evals/results/review-2026-10-02.md)及其原始报告保留原始字节，描述的是当时的技能、案例和提示。历史文档中的“当前文件”核对是该次复核时的结果，不能解释为与此后的 0.6.0 或 24 例相同。新增案例与本轮修订尚未获得新的实际模型调用记录；不得沿用历史通过结果作为新版模型验证。

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
