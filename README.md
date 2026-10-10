# ASD-STE100 技能：简明技术英语改写

将英文工具说明、错误消息、智能体间指令和说明性文字改写得更清楚，保留原文事实、条件、要求强度和英文技术术语。规则受 ASD-STE100 启发；本项目不包含官方批准词典，也不提供 STE 合规认证。

中文文档用于解释使用方法。技能处理英文文本，默认只返回英文改写稿；无需改动时原样返回原文。英文执行规则见 [SKILL.md](SKILL.md)，中文技术文本见[中文简明技术写作规范](references/chinese-writing-rules.md)。

## 安装

使用 skills CLI 在项目根目录安装：

```bash
npx skills add xhyperzum/asd-ste100-skill
```

若需关闭 skills CLI 的匿名安装统计，可在安装命令前设置 `DISABLE_TELEMETRY=1`。

更新技能：

```bash
npx skills update
```

也可以克隆到 Claude Code 的技能目录：

```bash
git clone https://github.com/xhyperzum/asd-ste100-skill ~/.claude/skills/asd-ste100
```

## 快速用法

粘贴英文文本，并提出以下请求：

```text
使用 ASD-STE100 改写这段英文工具说明，保留技术术语。
使用 Strict 模式澄清这段英文操作步骤。
使用 STE-flavored 模式改写这段英文说明，并解释改动。
```

中文技术文本改用《中文简明技术写作规范》，改写稿输出中文：

```text
按中文简明技术写作规范改写这段中文说明，保留技术术语。
```

默认输出便于直接复制。需要中文分析、模式说明或规则对照时，请明确要求“解释改动”或“显示差异”。

工具与测试统一使用 Node.js 22.0.0 或更高版本，源码仅使用内置模块，无需 Python、第三方 npm 依赖或 package.json。完整回归和安装验证中的 FIFO 夹具还需要 POSIX `mkfifo` 命令，CI 使用 Ubuntu；生产工具不调用该命令。运行文本检查：

```bash
node scripts/ste-lint.mjs --text-type instruction instructions.md
node scripts/ste-lint.mjs --text-type description --json description.md
node scripts/ste-lint.mjs --language zh --text-type instruction zh-instructions.md
node scripts/ste-lint.mjs --list-rules
```

检查器只覆盖部分结构规则和启发式提示。检查结果为零不能证明改写保留原意，也不能证明符合官方词典。CLI 和解析边界以 [检查器说明](references/linter.md) 为准。

## 开发与验证

验证入口、必需资源和 CI 说明见 [安装验证说明](references/installation.md)。本地主检查：

```bash
node scripts/ste-lint.mjs --selftest
node scripts/run-tests.mjs
node scripts/check-install.mjs
```

第二条动态发现 `tests/test_*.mjs` 并运行全部工具回归，拒绝空测试文件、子目录、命名不合规文件、skip、todo 和排队后未完成的测试；第三条将技能运行资源复制到临时安装目录。跨文件一致性（规则表、版本号、覆盖表、资源清单）由 `tests/test_consistency.mjs` 守护，随回归一起运行。GitHub Actions 在 Node.js 22.0.0 和 22 系列版本上执行编码检查、共享 runner 和临时安装验证。

仓库自身文档不适用中文 30 字句长上限，它是解释性长文而不是操作指令。这一点在中文规范里未写入，因此本项目不对自己的文档跑 `--language zh` 硬性门禁。

技能的改写行为另用 [模型行为评测](references/evaluation.md) 检查。评测保存实际模型输出，自动约束检查后仍需复核语义保真；CI 不调用模型。示例语料中的预写改写稿只用于回归，不计为模型行为评测结果。

[2026-10-02 的实际运行与独立代理复核](evals/results/review-2026-10-02.md)记录了 `gpt-6.1-sol` 的历史 10 个案例结果；结论只覆盖当时的技能和案例。当前技能为 0.1.0，正式案例集扩展为 38 例，覆盖两种模式、分析输出、原文边界澄清、列表、段落、中文分支和保真例外；规则与案例的对应关系见 [评测覆盖表](references/evaluation.md)。0.1.0 是中文分支并入后的重新编号，新于历史快照中的 0.6.0，两者不能按 semver 比较；原因与历史记录索引见[评测记录说明](references/evaluation.md#版本线说明)。

当前 38 例已有三轮全量真实模型调用记录（第三轮用最终约束集），并对 5 个边界与歧义类案例重复跑过 5 轮（`wokey/claude-opus-5-5`，见[评测记录说明](references/evaluation.md#真实评测结论2026-10-10)）。结果不能算作通过：`source-boundary-clarification` 5 轮中 3 轮未按要求先澄清原文范围；`steps-as-list` 曾以裸换行代替列表；`simple-tense-conversion` 5 轮中 1 轮未改简单时态。这些案例在不同轮次间结论不同，属不稳定。单轮评测不能证明技能行为已通过，历史记录也不能代替当前版本的实际运行。

## 资源导航

- [SKILL.md](SKILL.md)：模式、保真优先级、执行规则和输出契约。
- [写作规则背景](references/writing-rules.md)：标准背景、词典与来源。
- [中文简明技术写作规范](references/chinese-writing-rules.md)：中文计数口径、核心结构规则和检查器对应。
- [改写示例](examples/before-after.md)和[英文语料](examples/fixtures.json)：对应的解释与可检查输入、输出。
- [检查器说明](references/linter.md)和[边界样例](examples/linter-edge-cases.md)：能力与已知边界。
- [安装验证](references/installation.md)：Node.js 版本、入口迁移、必需资源和 CI。
- [模型行为评测](references/evaluation.md)：真实调用、数据边界和人工复核口径。

## 许可证

采用 MIT 许可证，见 [英文原文](LICENSE)及[中文译文](LICENSE.zh-CN)。授权条款以英文原文为准。
