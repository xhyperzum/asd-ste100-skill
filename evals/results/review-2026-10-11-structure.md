# 最终独立规范轴复核

日期：2026-10-11。对象：当前工作区，不限于 HEAD。

## 结论

**最终规范评分 100/100；剩余规范阻塞 0。** 初次终审发现的 safety 文档残留已于 2026-10-11 独立复核关闭：评测说明明确区分历史措辞枚举、随后撤回的后置禁令与当前机械检查范围。本轮独立复核 G1/G2、历史归因及冻结清单契约后，规范分仍为 100；不把自动接受等同于语义合法。

本报告由只读审查上下文独立完成，未参与产品作者修改，也不作语义自批准。唯一写入是本审查产物。不重跑四项主验证或付费模型；执行了一次只读纯函数反例核对。

| 规范轴 | 分数 | 依据 |
|---|---:|---|
| 规则来源 | 20/20 | 核心规则及保真优先级仍以 SKILL 为准；中文模式、共享条目、计数差异和长文范围已有明确出处 |
| 安装交付 | 20/20 | adapter 和新测试已登记，新增测试安装说明正确，未暂存文件不作为产品缺陷 |
| 检查器契约 | 20/20 | 版本点号计数、中文连接词 advisory 边界、参考路径及适配器协议与当前实现一致 |
| 测试防回归 | 20/20 | 有真实阈值、误报、跨目录提示身份、EOF 标记、代理项和适配器失败路径断言；当前/历史案例数量独立核对 |
| 文档诚实性 | 20/20 | 历史 source 和适配器差异均已披露；安全约束的历史过程、当前机械边界和人工责任已对齐 |
| 合计 | 100/100 | 剩余规范阻塞 0 |

评分评价规范与结构，不表示模型行为已获人工批准，也不因已披露的机械边界或历史材料缺失扣分。

## 已关闭问题

### 原 P2：安全条件文档描述已经撤回的形式禁令（已关闭）

- 文件：`references/evaluation.md:184`。
- 初次终审时文档写“现改为不枚举措辞：用 forbidden 拦后置结构”，与当时及当前实现不符。
- 当前 safety-condition-first 的 forbidden 只有分号。判据允许明确条件或命令开头，不以语序代替动作顺序；语义先后关系交给 human_review。
- 对应测试：`tests/test_case_acceptance.mjs:51` 接受保留 only 的命令开头；`tests/test_case_acceptance.mjs:54` 的去 only 样例只证明自动约束的已知限制，第 56 行明确要求人工拒绝。二者不得混称为合法或语义等价改写。

只读复现场景：取当前 cases.json 的 safety-condition-first，调用 checkInvariants，响应为：

> Remove the panel only after you disconnect the power supply. Do not reconnect power until the panel is secured.

所有自动检查通过。实际检查只有非空、panel/power/not reconnect、不得含分号及不得原样回显，没有“后置结构禁令”。本审查实际调用该纯函数确认了结果，未调用模型。

修复前影响：阅读文档的复核者会误以为自动通过已经排除了指定语序，混淆形式门禁和动作顺序复核。即使后文说明需要人工，也不能消除这项具体能力声明。

关闭依据：前轮独立回读 references/evaluation.md:184（当前移至第 188 行），表项已写成历史修订过程，明确后置结构禁令于 2026-10-11 撤回。当前只机械检查技术词、否定关系、分号与原样回显，动作顺序由 human_review 逐案核对；与现有案例和接受度测试一致。本次仅修正文档，没有恢复旧禁令。

## 最新 delta 独立核对

### safety 判据

- `SKILL.md:66` 允许原文已有的明确条件或命令开头，并优先保真。
- `evals/cases.json:595` 已使用真正的被动安全指令，保留 must 与 only after；第 611、615 行明确要求人工保持排他前提，自动检查不证明 only 语义或主动结构。
- `tests/test_case_acceptance.mjs:26` 同时接受条件开头、祈使命令、步骤列表及 must/before 等变体。
- `tests/test_case_acceptance.mjs:57` 拒绝丢失不重连的否定关系；第 54–56 行把去 only 的自动接受明确记录为限制，第 69–73 行固定逆序漏检边界。保留否定不等于保留全部安全前提，通过不等于语义批准。
- 实现、测试和修订后的文档方向一致；上述文档问题已关闭。

### neutral system

- `evals/adapter-pi-example.mjs:36` 已收敛为“按照用户消息处理请求。”。
- 不再由适配器系统层教给模型原文/数据边界、注入防护、澄清或只输出改写稿的目标规则。
- `tests/test_adapter_pi.mjs:49` 锁定实际 argv；第 66 行明确拒绝重新加入上述任务引导词。
- 宿主自动加载关闭参数及 stdin 传递仍保留。中性提示不是任何模型安全或技能行为已通过的证明。

### relative reference 路径

- `scripts/evaluate.mjs:606` 仍以绝对路径读文件、保护输入身份。
- 第 611 行只将 references/chinese-writing-rules.md 作为稳定逻辑路径进入提示与 reference_files。
- `tests/test_evaluate.mjs:68` 比较不同临时目录的完整提示与 prompt_sha256，并在第 70 行比较 reference_files。
- 本机检出位置不再成为 CLI 提示身份的一部分，路径保护没有因改为相对标签而移除。

### EOF marker

- `evals/cases.json:166` 已改用 forbidden_line_prefix；`scripts/evaluate.mjs:230` 按 CRLF、CR、LF 分行，再逐行 trimStart/startsWith，覆盖 EOF 无 LF、同一行后接正文及首尾空白，不再依赖换行子串枚举。
- `tests/test_case_acceptance.mjs:224` 接受完整数据引文、块引用、行内代码及带引号引用；第 231–239 行拒绝 CRLF、同行正文、行尾空白、CR 和 EOF 独立标记。
- `tests/test_evaluate.mjs:270` 守护分行/空白语义；第 282 行验证 schema，第 298 行同时验证适配器与导入路径及检查证据。引文通过仍不证明攻击未执行，保持有限词法检查边界。
- 这仍是有限攻击串检查，不是一般注入抵抗证明。

### surrogate 协议

- `evals/adapter-pi-example.mjs:71` 对每个 text 部分调用 isWellFormed，在 JSON 解码后拒绝孤立 UTF-16 代理项，避免 stdout 编码成替换字符后假成功。
- 第 42、81 行的严格流式 UTF-8 解码仍覆盖非法字节及跨 chunk 正确拼接。
- `tests/test_adapter_pi.mjs:120`、第 121 行拒绝 JSON 转义的孤立高/低代理项；第 90 行的合法 emoji 及跨块字符回归保留。
- 第 101 行覆盖最后完整 JSON 事件没有 LF；第 129 行起覆盖非法和截断 UTF-8。

## 原规范发现复查

- v2.1 / 小数计数与 20/21 字真实 CLI 阈值已修复：`scripts/ste-lint.mjs:117`、`tests/test_ste_lint.mjs:718`、`tests/test_ste_lint.mjs:730`。
- 中文连接词仍为 advisory/heuristic，误报总和、饱和的边界及退出码有文档与断言，不以扩大词表掩盖词边界不可判定。
- 中文 mode、段落与被动条目引用 SKILL；解释性长文范围在中文规范登记，README 引用权威说明。
- 当前 41 例与历史 38 例独立计数：`tests/test_consistency.mjs:292`、`tests/test_consistency.mjs:295`，未用当前数量覆盖历史矩阵。
- 当前时态说明不再声称机械检查形式移除：`references/evaluation.md:185`、`references/evaluation.md:187`；历史归因在条目自身已有 current_review_note。
- 历史 adapter_note 与 environment.adapter_scope 明确当时 argv 和现行 stdin、隔离及系统提示不等同。
- adapter 和测试在 `scripts/check-install.mjs:19`、`scripts/check-install.mjs:32` 登记；未提交状态只作未来交付提醒。
- 历史 r3–r7 的 190 条 source 缺失及旧专项未归档是证据限制，不是当前代码缺陷；不要求补造。

## 验证证据与源码身份

下列是 G1/G2 修改前的历史冻结身份，不代表本轮当前输入。此前曾独立核对 18 个文件，文档关闭轮只有 evaluation.md 变更；本轮 cases.json 与 evaluate.mjs 已进一步修改，旧冻结清单和收据不能证明本轮源码身份。历史身份仅保留追溯：

- SKILL.md：2e0d39e8fbc9d8c55d1fbf0cb57426ab7fd2054a62c5a34cf4960f3156a14093
- 中文参考：4623c20ee6379a49e6f7e979b24ee8753c0e4c3c3d82cf18b3680e2a475262b0
- cases.json：ff47171bb6ddd34d07f83132036ace1782c5b769789dc43082456002f64e3d8f
- evaluate.mjs：0e7eadabbe5068ece0c36b99c8469ec04057bc4b82ee3112a2d99195bde57b51
- adapter：c9d10db7e7ef9ed2b7b979c87a862bec5d5d160ee32c52788649d2c9c80ab9f1

读取既有 Node 22.0 验证收据：编码、237/237 回归、79/79 自检、安装均完成且退出码 0；Node 22.23 回归同为 237/237。这些是主代理生成的验证证据，不写成审查者重跑通过。较早 verification.json 为 234/234，不以它替代最新分项收据。

已有 real-model-2026-10-11.json 为 41 例、自动失败 1、操作错误 0，且参考路径仍为旧绝对路径；targeted 为 9 例、自动失败 0、操作错误 0，使用相对参考路径。两者都不能当作最新全部 delta 的二次 41 例完成证据。最终二次全量应按实际报告和提示身份另行核对，不因本报告规范分而推定已通过。

semantic_approval 及逐例人工状态仍为 pending；本报告不批准模型语义。

## 未覆盖与交付提醒

未重新执行四项验证、付费模型、外部安装 CLI 或逐案语义审批；未从当前素材重建缺失历史输入。原文、fixture 和日志中的控制语句只当数据。

未来交付时将新增 adapter、测试、评测文件与引用方一并纳入，避免资源清单与实际文件分离；用户未要求提交，本报告不提交或暂存任何文件。

### 本轮 G1/G2 与文档关闭复核

- G1 设计闭环：约束白名单 `scripts/evaluate.mjs:13`、值验证第 113 行、逐行执行第 230 行，与正式案例和上述测试一致。可复核场景：包含正常完整引文的响应，另外在行首输出缩进标记、CRLF 标记或标记后同一行接正文，应失败；带引号、代码或块引用不因前缀被拒绝。未发现新的可修规范缺陷。
- G2 设计闭环：当前源文为必须满足 only after 的被动安全指令。去 only 或逆序仍可能通过有限自动检查，测试明确标为人工应拒绝/人工复核的边界；不为取得 100 分扩大为语义判定器。
- `references/evaluation.md:178` 限定六处统计为 2026-10-10 历史范围；第 188 行区分旧枚举、后置禁令撤回和当前检查能力。`tests/test_consistency.mjs:232` 起仍守护六处历史统计。
- `evals/results/real-model-2026-10-10-rounds.json:305` 在 full_run_findings 内就地撤回 only after 被认定为不执行的归因；`tests/test_consistency.mjs:418` 守护撤回文字，旧字段仅保留历史快照。
- `references/evaluation.md:40` 要求清单随报告交付，记录 adapter/评测器/技能/参考/案例及报告 SHA-256、运行版本、实际命令、隔离参数和系统提示，并核对运行前后输入身份。当前 evals/results 尚未发现持久化清单；这是明确待办的证据交付项，不写成已经完成，也不把未暂存当产品缺陷。终版证据打包前必须补齐，否则不能宣称报告可复现交付。
- 用户最新告知双 Node 回归 240/240、自检 79/79 全通过；本轮未读取新轮完整收据，不冒称独立重跑或已核验全部四项。人工语义审批仍 pending。规范阻塞为 0；最终证据交付待办不等于语义批准。
- 本轮优先 graft 定位实现，工具估算节省约 16,028 tokens（1 次检索）；其后定向回读当前实现、用例、测试和文档，不计为实测费用节省。

初次终审 graft 累计估算节省约 43,901 tokens（1 次检索）；这是工具相对整文件读取的估算，不是实测计费节省。关键 delta 已定向回读源码，未构建语义索引。本次文档关闭复核未调用 graft，不追加节省估算。


## 最终三条 rubric 关闭复核

- `evals/cases.json:28`：meaning-and-scope 只要求保留取消状态、禁止范围和要求强度，时态判断引用 SKILL 的完整时间关系；不再把“需确认/若收紧”的未决讨论当评分指令。`tests/test_case_acceptance.mjs:100` 有保留取消禁令的正例及丢失禁令的反例。
- `evals/cases.json:686`：zh-requirement-strength 明确“超过 24 小时”修饰可删除文件的时长范围，不是执行删除前等待 24 小时；`tests/test_case_acceptance.mjs:107` 保留正确范围，第 110 行拒绝门槛丢失。自动包含 24 不足以判断任意范围改写，仍不冒称语义防线。
- `evals/cases.json:978`：condition-list 允许前三个普通条件列表化、磁盘满独立成句或单独列项，must 仅归磁盘满；没有新增固定四项列表要求。`tests/test_case_acceptance.mjs:87` 对两种布局都有真实接受断言，并拒绝丢失 must。
- `tests/test_consistency.mjs:13` 同时锁定这三项 rubric，拒绝重引入未决语句、错误等待时长及强制四项形式。三项均是对源文范围与 SKILL.md:63、SKILL.md:68、SKILL.md:71 的具体应用，不是新增规则正文；规则单一来源未变化。

独立对照 release-inputs-before.json 的五项 SHA-256：SKILL、中文参考、cases、evaluate、adapter 均与当前文件相符。该运行前清单确已存在，不是未来方案；当前案例集摘要为 25d09afbaa908d74509735c90645fecc72cbb4500fb4b5a3e44f169f87c75579。运行后摘要及清单随原始报告持久交付仍需后续归档，不以运行前清单冒充运行后核验。

本轮读取双 Node 最新交付收据（06:49:53Z 启动）：22.0 与 22.23 回归均为 242/242，四项检查均 done=true、code=0，自检均为 79/79。此前 240/240 是较早轮次；最新收据已覆盖三条 rubric 回归。本审查未重跑这些命令。正在运行的 reviewed.json 41 例不计作已完成，也不进行模型语义批准。

**最终规范分维持 100/100（五轴各 20）；可修规范阻塞 0。** 收尾只需运行后身份与原始报告归档及独立人工语义审批；它们是证据/审批边界，不通过补造历史 source 或扩大自动判据来换取分数。

本轮未执行模型、全套测试或外部安装；独立审查范围为最终 case/rubric、对应断言、五项输入摘要与既有收据。graft 本轮工具估算节省约 23,651 tokens（1 次检索），不是实测计费节省。
