# 0.1.2 适配器／评测器工程最终验收

审查日期：2026-10-11。作者退出后独立审查稳定补丁，实际执行定向回归、性能及语义探针，并核验冻结输入和真实调用证据。本次只新增本报告，不修改被审实现、测试或案例。

## 结论与边界

- **适配器／评测器工程资源与本次性能修复：100/100。** 新发现的评测器尾部裁剪重复扫描问题已独立复现并确认修复，不是直接沿用旧批准。
- **接受度：90/100。** 有限自动约束的固有语义扣分保持不变，42 项接受度测试通过不等于任意改写语义正确。
- **不批准整体产品 100 分。** 当前另一个 lane 正在修复 linter 模态正则重叠问题；本报告不覆盖其实现、性能或修复验收，不为未完成工作背书。
- 当前评测器只核验了一次真实 `glossary-authority` 调用。历史 full41 与真实重试继续作为原 harness 的冻结证据，不能写成当前评测器已全量重跑 41 例。人工语义审批仍待复核。

## 独立定向回归

本机 Node.js `v22.22.1`；三组独立任务并行启动，性能测量在它们结束后单独进行。

| 实际执行命令 | 通过数 | 约耗时 |
|---|---:|---:|
| `node --test tests/test_evaluate.mjs` | 66/66 | 21.500 秒 |
| `node --test tests/test_adapter_pi.mjs` | 39/39 | 18.511 秒 |
| `node --test tests/test_case_acceptance.mjs` | 42/42 | 0.583 秒 |

合计 **147/147**；各组失败、取消、跳过、TODO 均为 0。扫描未发现这三个文件中的 `test.only`、`test.skip` 或 `test.todo`。这是定向验证，不冒称仓库全套或双 Node 全套。

新增裁剪语义回归见 `tests/test_evaluate.mjs:262`；新增性能回归见 `tests/test_evaluate.mjs:289`。性能回归实际处理内部空白与尾部空白，不是空壳断言。

## 性能问题与修复

旧模式对 `a`、长空白、`b` 构成的输入使用非首锚定尾部正则 `SPACE+$`，会从不同位置反复尝试匹配。当前 `scripts/evaluate.mjs:22` 使用单字符判定，从尾部逆向扫描连续空白；末尾非空白时立即停止，随后仍使用原有首锚定裁剪。没有把任意内部空白当尾部删掉。

独立对照原正则算法与当前公开 `checkInvariants` 路径，每项运行三次取墙钟中位数；旧算法对照在内存中执行，不改回仓库代码。

| 内部空白数，末尾为非空白 `b` | 旧正则算法 | 当前评测器 |
|---:|---:|---:|
| 8,000 | 67.262 ms | 0.009 ms |
| 16,000 | 239.304 ms | 0.005 ms |
| 32,000 | 1,341.968 ms | 0.010 ms |

当前长尾部空白路径也实际验证：32,000 个空格约 1.343 ms；1 MiB 总长度约 41.435 ms；4 MiB 总长度约 130.380 ms。分别裁剪后与正文 `a` 正确相等。相应长度的内部空白后接非空白也保持原文不变。尾部扫描按尾部长度增长，未再观察到旧的重复正文扫描。微小耗时受测量精度影响，不将本机数值承诺为所有环境的时限。

## 原 SPACE、BOM 与摘要语义

- 独立枚举全部 65,536 个 BMP 码位，并按原 `SPACE` 正则比较首尾裁剪后的非空、`equals_input` 与 `not_equals` 判定；全部一致。
- 固定种子生成 5,000 个混合样本，包含控制空白、BOM、零宽字符、普通正文和 emoji，与原裁剪算法比较；全部一致。
- 原集合实际包含 **29 个字符**，不是 30 个；本次没有增删集合。BOM、U+180E、U+200B、U+2060 等仍不被当作原 SPACE 裁掉，内部空白保留。不能换成语义不同的原生 `String.trim()`。
- 用当前实现重构第四轮 41 条记录及其一次重试的 prompt，逐例比对 `case_sha256`、`skill_sha256`、完整 prompt、`prompt_sha256` 和自动检查数组，全部与冻结记录一致。未观察到裁剪修复改变提示、案例摘要或这些既有响应的约束语义。

## 资源门禁与真实集成

`scripts/evaluate.mjs:16` 的资源常量逐项独立断言未变：单文件 4 MiB、单提示 8 MiB／整批 32 MiB、stdout 与 stderr 各 1 MiB、整批捕获 16 MiB、收尾 100 ms。39 项适配器回归实际覆盖 8 MiB stdin 边界、各流 1 MiB 累计边界、32 MiB stderr 超限失败闭合、旧答案不泄漏、UTF-8 及诊断截断。66 项评测器回归同时验证输出捕获额度、超时和输入／报告保护。

新 harness 单例报告 `evals/results/real-model-2026-10-11-0.1.2-harness.json:7` 核实为 **1/1 成功、自动失败 0、操作错误 0**，案例为 `glossary-authority`，provenance 为 `command-adapter`，退出码为 0，prompt 与案例摘要重算一致。外层凭据退出码也为 0：`.omc/artifacts/2026-10-11-perfect-closeout/real-model-0.1.2-harness.json:21`。

独立比较 `.omc/artifacts/2026-10-11-perfect-closeout/harness-inputs-before.json:5` 与 `.omc/artifacts/2026-10-11-perfect-closeout/harness-inputs-after.json:4`，并重算当前磁盘文件：5 项 SHA256 前、后、当前三方一致，快照时间包围真实调用。相对冻结第四轮，5 项中仅 `scripts/evaluate.mjs` 摘要改变，记录性质为 **harness-only**；技能、中文参考、案例和 pi 适配器摘要不变。

第四轮记录继续保留 40 次成功与 1 次 `Connection error`；失败案例在独立真实重试中成功。这是历史 41 个案例均有成功输出、累计 42 次调用含一次失败的证据，不涂改为首批零错误，也不算当前 harness 的全量复跑。

## 本次工程对象摘要

| 文件 | SHA256 |
|---|---|
| `scripts/evaluate.mjs` | `6464f2e1b45b8f2007c9d4a1ae19bd2f0524530548639115d934692837537542` |
| `tests/test_evaluate.mjs` | `89bbe0212b2a8d05e900e02c884f6fe04c66fd9540aaee8220845b2c55e53990` |
| `evals/adapter-pi-example.mjs` | `6eb2682674f892628b2caa1636389d8a90ad14f6e5fe365b49f23e23b53acc40` |
| `tests/test_adapter_pi.mjs` | `e8bf1c23ead6d8e21541ec53c1d616c40894a8baec68ded05a8fbeb48bc17fc9` |
| `tests/test_case_acceptance.mjs` | `c5c28b905fbd9deaeba1fc8d00f5a062fe5872b6694dc94de5d19cc1a2747f5e` |

## 未执行与剩余风险

本次未重跑双 Node 全套或真实 full41，未验收正在修改的 linter；不声称整体满分。独立适配器仍依赖外层请求时限，直属进程终止不保证清理全部后代进程；这些既有边界未被本修复扩张。子串约束仍无法证明条件、顺序、指代及要求强度语义，接受度 90 分和人工待复核状态保持不变。
