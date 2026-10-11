# 0.1.1 最终独立规范轴审查

日期：2026-10-11。对象：当前工作区，不限于 HEAD。审查者未参与产品修改；唯一写入为本报告。不读取认证或 provider 配置，不运行全套测试或付费模型。

## 结论与评分

**规范评分 100/100，剩余可修规范阻塞 0。** 这是规范/结构判断，不是模型语义审批或发布自批准。不因预设满分放宽安全前提，也不把自动接受写成语义等价。

| 规范轴 | 分数 | 本轮依据 |
|---|---:|---|
| 规则来源 | 20/20 | 新安全例外和多主题列表规则只在 SKILL 核心表定义；中文规范引用，rubric 应用而非另建规则 |
| 安装交付 | 20/20 | adapter 与测试仍登记；资源入口及版本引用一致；未提交只作交付提醒 |
| 检查器契约 | 20/20 | 行前缀文档与实际 CRLF/CR/LF、trimStart/startsWith 一致；适配器明确失败停止原因不输出正文 |
| 测试防回归 | 20/20 | 条件前置被动正例、规则/rubric 对齐、主题组织、异常停止及旧响应不复用均有断言 |
| 文档诚实性 | 20/20 | 当前版本 0.1.1 与历史 0.1.0 分离，词法和人工边界未夸大；旧归档不冒充新运行 |
| 合计 | 100/100 | 模型运行后身份核验、归档和人工审批仍需独立完成 |

## 安全规则与 rubric

- `SKILL.md:62` 的未知/无关施事者被动例外保留。`SKILL.md:66` 新增“未知施事者可保留被动，但保留 must、only 并把已有条件放句首”，与保真优先级一致，不猜测执行者、不升级建议或许可。
- `evals/cases.json:614` 的第 5 项 rubric 不再强迫改成直接命令，允许条件前置被动；第 1 项仍允许明确条件或命令开头。新增限制是在保留被动这一分支适用，没有把命令开头一律列为不合规。
- `tests/test_case_acceptance.mjs:28` 真实断言接受“Only after the power supply is disconnected must the panel be removed.”，完整保留 must/only；第 31 行锁定对应人工判据。
- `tests/test_consistency.mjs:13` 同时断言 SKILL 规则与安全第 5 项 rubric，防止再出现“规则允许被动、复核强制直接命令”的冲突。
- 自动约束仍不判断动作顺序、排他性或主被动。去 only 的响应在 `tests/test_case_acceptance.mjs:59` 被记录为已知自动接受限制；第 76 行的逆序输出同样只是漏检边界，须人工拒绝，绝不计为合法安全改写。

只读可复现场景：使用 safety-condition-first 的当前源文及上述条件前置被动响应，有限自动约束应通过，人工 rubric 也允许该结构；使用“Remove the panel after ...”去掉 only，自动仍可能通过，但人工不得因自动通过认定排他前提保持。

## 多主题列表与检查深度

- `SKILL.md:71` 明确多主题列表也按主题分组，平铺列表不能替代主题组织；原来每段一个主题、最多六句目标、三个以上操作或条件列表化及要求强度边界均保留。
- `evals/cases.json:537`、`evals/cases.json:743` 的两语主题判据仍在。`tests/test_consistency.mjs:21` 锁定新规则，第 32 行起确认两语 rubric 的主题组织要求没有删除。
- `references/chinese-writing-rules.md:43`、`references/chinese-writing-rules.md:44` 继续引用 SKILL；明确检查器不判断主题是否不同。没有另抄新规则或把语义主题分析包装成机械门禁。
- 只读场景：将两语七句工具说明全部压成一张平铺清单，可能通过最低事实片段检查，却不能据此认定已完成主题组织。分组是否合理由人工核对，不能靠列表数量替代。这是已披露的检查深度，不是新增代码缺陷。

## adapter 失败闭合

- `evals/adapter-pi-example.mjs:69` 对 length/error/aborted 明确调用失败路径，即使事件带非空正文也不当作成功；第 103 行后的 close 分支遇到 failure 只写 stderr、设置非零退出，不写已积累 text。
- `tests/test_adapter_pi.mjs:127` 用“先有旧响应、后 length”覆盖截断不能复用旧文本；第 130、133 行覆盖无 errorMessage 的 error/aborted。
- `tests/test_adapter_pi.mjs:142` 的通用断言要求非零退出、stdout 为空、诊断匹配；不是只检查错误文案。
- `tests/test_adapter_pi.mjs:153` 明确正常或未知停止原因兼容。文档也披露未知/缺失停止原因不是完整协议验证；本轮没有把“已知失败原因闭合”扩大为“所有可能失败原因都拒绝”。
- 中性系统提示、stdin 完整提示、宿主隔离、EOF JSON 和 surrogate/UTF-8 拒绝设计继续保留。未读取任何凭据验证实际 provider 身份。

可复现场景：假 pi 先输出有效 message_end 文本，再输出 stopReason=length 的非空 message_end，适配器应非零退出且 stdout 为空；error/aborted 单个事件同理。对应测试已有真实进程夹具，不需要付费调用。

## 行前缀及版本精度

- `scripts/evaluate.mjs:230` 的 split 仅识别 CRLF、CR、LF，再逐行 trimStart/startsWith。`references/evaluation.md:260` 现在精确声明同一范围，明确不把 Unicode 行分隔符作为新行边界。
- 原始数据中的引号、代码和块引用不会仅因包含标记就被判为执行。行前缀只是有限词法证据，不能证明一般注入防护或语义保真。
- `SKILL.md:5`、`README.md:74`、`references/evaluation.md:87` 当前版本均为 0.1.1。历史 0.1.0/38 例及重新编号说明仍是历史来源，没有为版本同步改写旧结果。
- `scripts/check-install.mjs:19`、`scripts/check-install.mjs:32` 仍登记 adapter 与测试。交付时新增资源需与引用方一起纳入；本审查不暂存或提交。

## 输入冻结及验证证据

独立计算 release-0.1.1-before.json 所列五项当前文件 SHA-256，全部与运行前清单相符：

| 输入 | SHA-256 |
|---|---|
| SKILL.md | eaffc22e61418d4627e5f10e57b1c0eb155c45a0361fb9c9e4608d26698b9665 |
| references/chinese-writing-rules.md | 4623c20ee6379a49e6f7e979b24ee8753c0e4c3c3d82cf18b3680e2a475262b0 |
| evals/cases.json | e2f06c9b77ee5f592c3b5a1a91c4c4cab840e9a595564d49435d82dcee0240dc |
| scripts/evaluate.mjs | 0459fded70d0885119bbcc68ba678a54010219d1390d318452ac619140ea88cf |
| evals/adapter-pi-example.mjs | c78f681c28d85c5a9dfc282a8f2da475c1133bc7738a412f78b3d162e72adc16 |

清单记录 0.1.1、实际路由模型名、Node/pi 版本、启动器身份、中性 system prompt 及未显式设置采样项。明确未归档认证/provider 配置；路由名不能证明供应商内部服务身份。本审查只核对文件摘要，不认证运行前记录的工具版本。

已读取 v0.1.1-node-22.0 与 v0.1.1-node-22.23 的八份收据：回归均 247/247、自检均 79/79、编码与安装均 done=true/code=0。它们是主代理生成的实际收据，不写成审查者重跑。31 项定向结果未单独核验，不靠该数字作额外结论。

当前 evals/results 已有 canonical 0.1.0 报告和 review-2026-10-11-inputs.json；它们只证明各自冻结输入。新的 0.1.1 release.json 正在执行，不因旧报告移动归档或本轮规范满分就视为完成。须等新报告完整写入，再核对运行后摘要与运行前一致，并将新输入清单、原始报告和独立审批随报告持久归档。未归档旧 source 是历史证据限制，不要求补造。

## 未覆盖与剩余收尾

未执行全套测试、定向测试、付费模型、外部安装 CLI、主题分组模型语义裁决或逐例审批；未读取认证/provider 配置。检查器机械通过与安全/主题语义通过分开评价。

可修规范阻塞为 0；0.1.1 完整模型报告、运行后输入身份、持久归档和人工审批仍是证据/审批收尾，不能宣称已完成。本报告不修改产品或自批准。

本轮先使用 graft 定位实现及回归：两次检索，工具估算节省约 37,192 tokens；随后定向回读当前源码和文档。该数值不是实测计费节省。
