# 0.1.1 最终交付独立核验

日期：2026-10-11。对象：当前工作区及 canonical evals/results 证据包。只读核验交付文件，唯一写入为本报告；没有重跑全套检查或模型，没有读取认证/provider 配置。

## 结论

**已核验的交付证据一致；实际阻断项 0。** 可以交付这份审查证据包，但不批准生产发布、不代替人类语义审批。综合报告没有把规范满分冒充行为满分，也没有把代理意见提升为人类批准。

审查开始时最终交付收据与清单尚未出现；后续读取时两者已生成。以下完成判断来自实际读取后的状态，不是根据后台任务启动推断。

## 评分来源与审批边界

| 综合报告引用 | 独立来源 | 核验结果 |
|---|---|---|
| 规范 100/100 | evals/results/review-2026-10-11-structure-0.1.1.md:7 | 五轴各 20；与原结构审查 artifact 字节摘要一致，评分只覆盖规范/结构 |
| 行为 92/100 | evals/results/review-2026-10-11-semantic-0.1.1.md:9 | 23＋23＋22＋24＝92，四项满分各 25；保留作用域与证据扣分 |
| pi 结构 91/100 | evals/results/review-2026-10-11-pi-0.1.1.md:98 | 18＋19＋18＋18＋18＝91，没有被综合报告抹成 100 |
| pi 行为 88/100 | evals/results/review-2026-10-11-pi-0.1.1.md:109 | 23＋23＋23＋19＝88，没有平均投票或变成通过率 |

- evals/results/review-2026-10-11.md:5 明确禁止行为满分、人类批准及官方认证的宣称；第 49 行保留具体人工裁定项。
- README.md:78、references/evaluation.md:278、references/evaluation.md:280 的新入口明确当前 0.1.1、网络失败保留及审批 pending；没有用旧 0.1.0 运行替代新输出。
- 两份原始报告均为 semantic_approval=pending-human-review，全部 42 条结果的 human_review.status=pending；成功选择、冻结凭据、pi 收据、交付清单及最终检查收据也未升级审批。
- pi 审查调用另计，不在 42 次被测案例调用之内；review-2026-10-11-pi-receipt-0.1.1.json:1 明确其角色为独立代理，而非人类审批。

## 实际计数与失败保存

独立从原始 results 重新计数，不只相信摘要：

| 范围 | 调用数 | 成功数 | 操作失败 |
|---|---:|---:|---:|
| real-model-2026-10-11-release.json:1 首批 | 41 | 40 | 1 |
| real-model-2026-10-11-release-retry.json:1 定向重试 | 1 | 1 | 0 |
| 合计 | 42 | 41 个成功响应 | 1 |

首批失败仍是 ste-flavored-claims：stderr 为“模型错误：Connection error.”，returncode=143，operation_error 为命令适配器非零退出；首批 summary 仍为 automatic_failed=1、operation_errors=1，执行总退出码仍为 2。重试只执行该例且成功，没有覆盖原失败或改写首批记录。

review-2026-10-11-selection-0.1.1.json:1 恰好选择 41 个唯一案例：40 个来自首批成功项、1 个来自真实重试；与当前 cases.json 的 41 个 ID 一一对应，无缺失。所选结果均 returncode=0、operation_error=null、automatic_passed=true。这只是有限自动判据，不等于人类语义通过率。

## 逐例输入与输出身份

通过当前评测器的纯函数只读重建全部 42 条尝试：

- 原始 case、request、source、human_review 的 canonical case 摘要一致。
- 当前完整 SKILL、中文参考正文及相对逻辑路径重建的 prompt，与实际报告全文逐字一致；case/skill/reference/prompt 摘要全部一致。
- context_origin 均为 submitted-to-adapter，provenance 均为 command-adapter；没有 import 冒充实际调用。
- 41 条成功索引的 case/skill/prompt/stdout 摘要与指定原始结果一致；两份原始报告文件摘要与 selection 和 pi 收据同时一致。
- review-2026-10-11-evidence-0.1.1.json:1 的五项 before/after SHA-256 相同，且与当前 SKILL、中文参考、cases、evaluate、adapter 实际文件摘要一致。

核验得到：42 次尝试、41 个所选唯一案例、缺失案例 0、身份/来源/审批差异 0。不重新调用模型，也不通过重新导入生成替代报告。

## pi 实际调用核验

读取收据指向的本机 pi-0.1.1-final.jsonl：原始事件流 SHA-256 与 canonical 收据相符；最终 assistant 事件中的模型路由为 wokey/claude-opus-5-5，工具调用数 0。提取实际文本与 canonical review-2026-10-11-pi-0.1.1.md 去除两端空白后完全一致。

这支持“指定路由实际生成该审查文本”，不证明隐藏供应商服务身份。原始事件流只留本机、交付收据保留摘要这一边界已在综合报告披露；不因此宣称归档了认证信息或所有 provider 配置。

## 索引及最终交付收据

- 最终综合报告有 12 个本地链接；11 个目标已存在，唯一待出现的是 review-2026-10-11-delivery.md，按用户指定将在本审查 artifact 原样复制后闭合。它是预期复制流程，不是遗漏或阻断。README 22 个、evaluation 14 个本地文件链接目标均存在。只核对文件目标，不额外声称逐个 Markdown 锚点渲染验证。
- 最终八项 delivery-node 本机收据均 done=true/code=0；canonical review-2026-10-11-delivery-checks.json:1 已生成，记录两种 Node 的编码、回归、安装、自检全部完成。
- 两种 Node 回归均 247/247，自检均 79/79；这些是实际收据读取结果，不是审查者重跑。
- review-2026-10-11-manifest.json:1 已生成：61 项交付文件逐一重新计算摘要，缺失 0、摘要变化 0。README/evaluation、两份真实报告、selection/evidence、四类独立报告及交付检查收据均在清单中；head 与当前 Git HEAD 相符。
- 清单明确排除自身、最后核验清单的 review-2026-10-11-delivery.md 及 .git/.omc/.commandcode/graft 本机缓存，避免循环摘要；本审查 artifact 不属于交付产品变更。未暂存、新文件未提交只作后续提交完整性的提醒，不当作产品缺陷。

## 未覆盖与交付含义

本轮不是新增功能审查或逐案重新评分。不重跑测试/模型，不复审多供应商稳定性、开放工具权限、真实设备操作、按需触发、官方批准词典或隐藏 provider 身份，不补造 190 条历史 source。

最终结论是“交付证据、计数、摘要、来源、索引和状态一致”，不是“人类语义已批准”。保留规范 100、行为 92、pi 91/88 的原始差异和人工争议；实际阻断项 0，人类审批仍 pending。

本轮优先 graft 定位提示与摘要实现，1 次检索，工具估算节省约 6,249 tokens；随后只读重建身份与检查文件摘要。该数值不是实测计费节省。

## 最终冻结收据

最后独立复核的 manifest recorded_at 为 2026-10-11T07:26:49.299Z。61/61 文件存在且 SHA-256 匹配；包括旧 rounds 历史文件、全部已归档 raw 报告、新 canonical 报告及 README/evaluation。清单排除自身与最终 delivery.md 的策略准确，未形成循环摘要。

- manifest SHA-256：5733935e10bb01636f3c9ddf65387d7fe9708edb614f681d8cc4292725fbaa36
- delivery-checks SHA-256：db4dfef9214d018513852aefa338087f631f19644fce43aac9fead91ee948a41
- 八项实际收据均完成且退出码 0；回归两份各 247/247、自检两份各 79/79。
- 再次纯读取重建全部 42 项身份与 41 项成功选择，差异 0；SKILL/README/evaluation 均为 0.1.1。42 调用、1 网络失败、40＋1 成功的口径未变，原失败保留。
- 综合报告仍引用规范 100、行为 92、pi 结构 91/行为 88，源报告未被改成满分；所有语义审批仍 pending。

**最终交付证据核验通过，实际阻断 0。** 唯一后续文件操作是由主代理把本 artifact 原样复制到 evals/results/review-2026-10-11-delivery.md；截至本核验时尚未复制，不宣称该目标已存在。不需要改 core、重跑模型或更改任何审批字段。本结论不等于人类语义批准。
