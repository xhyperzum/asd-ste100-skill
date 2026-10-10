# 安装与验证

检查器、模型评测器、安装校验器和全部测试统一要求 Node.js 22.0.0 或更高版本，源码仅使用内置模块，不需要 Python、第三方 npm 依赖或 package.json。完整自动回归和安装验证中的 FIFO 夹具还需要 POSIX `mkfifo` 命令；CI 使用 Ubuntu。生产工具不调用该命令，缺少它的验证环境会失败，不静默跳过边界测试。

## 安装内容与入口迁移

保留技能目录中的完整运行资源，包括 `SKILL.md`、`scripts/`、`evals/`、`references/`、`examples/` 和 `tests/`。`references/` 包含英文与中文两套写作规范；安装校验器要求 `references/chinese-writing-rules.md` 存在。当前工具入口为：

| 工具 | 当前入口 | 迁移前入口 |
|---|---|---|
| 结构检查器（en/zh） | `scripts/ste-lint.mjs` | `scripts/ste-lint.py` |
| 模型行为评测器 | `scripts/evaluate.mjs` | `scripts/evaluate.py` |
| 安装校验器 | `scripts/check-install.mjs` | `scripts/check-install.py` |

对应回归测试为 `tests/test_ste_lint.mjs`、`tests/test_evaluate.mjs` 和 `tests/test_install.mjs`，替代同名 `.py` 测试；`tests/test_run_tests.mjs` 验证共享 runner，`tests/test_consistency.mjs` 验证跨文件一致性（规则表、版本号、覆盖表、必需资源清单）。`scripts/run-tests.mjs` 自动排序发现 `tests/test_*.mjs`，新增测试不需要另改 CI 或安装脚本中的文件清单；但 `tests/` 下只允许顶层 `test_*.mjs`，子目录、其他 `.js` 或命名不符的 `.mjs` 会被拒绝，而不是静默忽略。历史模型评测文件保留原始调用记录和哈希，不将它们改写为新入口或新版技能的运行结果。

安装校验器会验证必需资源的文件或目录类型、相对 Markdown 链接，以及文本的 UTF-8、无 BOM 和 LF 格式。编码检查涵盖 `.mjs`、Markdown、JSON 与 YAML，包括 `.github/workflows/` 下的 CI 配置；运行缓存和 Git 元数据不参与检查。内部 symlink 的实际内容也检查；外部、断开或循环链接会被拒绝。

Markdown 资源检查支持行内链接和图片、平衡括号与反斜杠转义目的地、`<含空格目标>`，以及同一物理行的 reference definitions。代码区域、外部 URL 和页内 anchor 跳过。它仍是有限子集：不解析 HTML 块、复杂引用块或列表内围栏、跨行 reference definitions；未定义的 reference 按 Markdown 正文处理，不能据此宣称验证了完整 Markdown。

## 验证

在技能目录中运行：

```bash
node scripts/check-install.mjs --check-text-files
node scripts/ste-lint.mjs --list-rules --json
node scripts/ste-lint.mjs --selftest
node scripts/run-tests.mjs
node scripts/check-install.mjs
```

`--selftest` 只运行检查器回归。全部工具回归使用共享 `run-tests.mjs` 入口，不调用模型。runner 只接受普通 `test_*.mjs` 文件，逐文件对账「已排队」与「已完成」的真实测试事件；空文件、子目录、命名不符或扩展名不符的文件（包括 `.js`、`.cjs`、`.mts`、`.cts` 与大小写变体）、skip、todo、取消、提前 `process.exit` 和失败均不能视为通过。完成数少于排队数会直接报错，防止提前退出隐藏未完成的失败测试。

已知边界：该对账只能发现已经进入队列的测试。如果测试在 `process.exit` 之后才通过 `setTimeout` 或顶层 await 注册，它从未进入队列，也就不会被计入。这一残余风险由 `tests/test_run_tests.mjs` 的对应用例固定记录；测试写在仓库内时不构成实际威胁，但审阅外部贡献的测试时需人工留意。

安装时若省略检查器测试文件，文本检查仍可运行，但 `--selftest` 无法运行；完整安装验证会把必要测试资源缺失视为错误。

CLI 与 selftest 每个宿主进程只调用一次 `node:test.run`。Node.js 22.0 的原生 runner 在同一宿主内反复调用时可能累积 process 监听器；嵌入 `runTests` API 时也应每进程执行一次，需要重复运行时使用独立 CLI 子进程。对抗测试中的多种门禁夹具已按进程隔离，不通过提高监听器上限或删除宿主监听器掩盖警告。

安装校验器使用当前 Node.js 可执行文件，并检查版本要求。随后将技能运行资源复制到临时位置，从技能目录之外依次运行以下四个入口：

1. 规则目录 JSON。
2. 标准输入检查。
3. 评测器帮助。
4. 共享 runner 动态发现的全部工具回归。

安装校验器回归使用模拟命令检查复制和工作目录契约，不会递归执行安装检查。真实安装检查从外部目录执行临时副本中的四个入口。子进程超时会终止直属进程；直属进程退出后至多等待 1 s 收尾 pipes，stdout 与 stderr 合计缓冲上限为 32 MiB，不负责管理后代进程树。临时安装验证不访问 GitHub、不调用外部模型、不修改原目录。

GitHub Actions 在 Node.js 22.0.0 和 22 系列版本上执行编码检查、全部工具回归和临时安装验证。最低版本也参与矩阵，避免遗漏只在较新版本可用的 API。
