# dsh-rtk-filter

> A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) plugin that pipes oversized command output through the [rtk](https://github.com/rtk-ai/rtk) CLI and hands the model RTK's condensed text instead of the raw output — a `tools/post-execute` result transformer that slashes token/context usage.

一个 DeepSeek Harness（DSH）插件：执行命令时自动调用系统命令 `rtk` 过滤输出。
当 `bash` / `job_output` 等工具返回超过阈值的纯文本结果时，插件把原始输出通过
stdin 管道交给 `rtk`，把 RTK 精简后的文本作为大模型最终看到的内容，从而显著减少
上下文占用。

## 安装 / Installation

仓库已包含编译产物（`lib/`），**clone 后无需构建即可挂载**。

### 方式一：GitHub 安装（推荐）

```sh
# 1) 用 dsh CLI 直接安装（需要本机装有 gh 或可访问 GitHub）
dsh plugin --profile web add github:Aeternus123/dsh-rtk-filter

# 2) 或在 profile 的 node_modules 放符号链接/拷贝 + patch 挂载（见下方示例）
```

### 方式二：npm 安装（发布后）

```sh
dsh plugin --profile web add dsh-rtk-filter
# 或
npm install dsh-rtk-filter
```

### 方式三：本地挂载（开发）

```sh
mkdir -p ~/.dsh/profiles/web/node_modules
ln -s /path/to/dsh-rtk-filter ~/.dsh/profiles/web/node_modules/dsh-rtk-filter
```

无论哪种方式，最后在 profile 的 `cordis.patch.yml` 里挂载插件（包内自带 `cordis.patch.yml`，用
`dsh plugin add` 安装时自动生效；手动挂载时追加）：

```yaml
- insert:
    - id: rtk-filter
      name: 'dsh-rtk-filter'
      config:
        command: /opt/homebrew/bin/rtk   # rtk 绝对路径（或裸名 rtk，插件自动探测候选目录）
        args: ['pipe']                    # stdin 进、stdout 出
        minBytes: 2048
```

**前置条件**：系统装有 [rtk](https://github.com/rtk-ai/rtk)（如 `brew install rtk`）；未安装时插件静默降级，不影响任何命令。

## 开发 / Development

```sh
npm install          # 安装 @deepseek-ai/* dev 依赖（node_modules 用于测试）
npm run build        # tsc → lib/
npm test             # 单元 + 集成测试（tests/bin/rtk 为 stub；装了真实 rtk 会额外跑 e2e）
npm run typecheck
```

## 核心思路：注入点在哪里（调研结论）

> 关键探索点：命令输出在返回大模型之前，如何拦截并修改？

在 DSH 的架构里，**命令执行的真正入口是 `ctx.shell` 服务（Service）**，模型侧的
`bash` 工具只是它的一个 Consumer。输出回传模型前，最贴近的、官方文档化的扩展点是：

- **`tools/post-execute` 瀑布事件**（`@deepseek-ai/dsh-tools` 注册表提供）——
  每个工具调用在 dispatch 完成后、**lossless 物化之前**经过这个 waterfall，
  监听者可以返回 `{ kind: 'accept', content: [...] }` 替换模型看到的内容。
  这正是「输出在返回给大模型之前」的拦截点。官方同款范例：
  - `@deepseek-ai/dsh-spill-policy`（spill 策略插件，把超大文本结果替换为预览+落盘定位）
  - `@deepseek-ai/dsh-hooks-*`（Claude Code / Codex 钩子桥）
  - `@deepseek-ai/dsh-repeat-tool-reminder`（重复工具提醒）

为什么不选其他方向：

- **`ctx.shell.run()` 服务包装**：能拿到原始 stdout/stderr，但属于服务层侵入，而且
  后台任务（`run_in_background`）的输出走的是另一条路径（`job_output` 工具），
  服务层包装覆盖不全。
- **会话投影（Projection，如 dsh-trail-plugin 的做法）**：投影单元监听的是**会话
  事件**（用于日志、回放、统计），事件在物化之后才发出，**改不了**模型已经拿到
  的内容——它是「记录者」，不是「拦截者」。

结论：**`tools/post-execute` 瀑布是唯一既能改内容、又覆盖前台/后台命令输出、且被
官方文档列为扩展点的位置。** 插件在该瀑布上以 `prepend: true` 注册，先
`await next()` 让下游监听者（如钩子桥）定型结果，再对最终内容做 RTK 精简。

## 工作原理

1. 工具结果（如 `bash` 的前台渲染文本）进入 `tools/post-execute` 瀑布；
2. 插件过滤条件：`accept` 决策、非失败结果、工具名在配置列表中、内容为纯文本、
   字节数 ≥ `minBytes`；
3. **拆出末尾的状态标记**（`[exit code: N]`、`[killed by signal: …]`、
   `[timed out after Nms]`、`[sandbox: …]`、`[status: …]`），只把正文喂给 rtk——
   大模型的退出码契约在精简后依然成立；
4. `spawn(command, args, { detached: true })` 把正文写入 rtk 的 stdin，捕获 stdout；
5. 用 RTK 输出替换内容：`精简正文 + [rtk: output condensed …] 提示 + 原状态标记`；
6. 任何失败（rtk 缺失、非零退出、超时、调用方取消、输出为空、输出无变化）都
   **保留原始输出**，绝不把成功调用变成 `isError`。

## 安装与挂载（以 web 界面 profile 为例）

DSH 的插件挂在 profile 目录：包放进 `~/.dsh/profiles/<profile>/node_modules`，
并在 `cordis.patch.yml` 里 `insert` 一行。

```sh
# 1) 让 profile 的解析器能看到本包（本地开发用符号链接即可）
mkdir -p ~/.dsh/profiles/web/node_modules
ln -s /Users/mac/work/dsh-rtk-filter ~/.dsh/profiles/web/node_modules/dsh-rtk-filter

# 2) 在 ~/.dsh/profiles/web/cordis.patch.yml 中追加：
#    - insert:
#        - id: rtk-filter
#          name: 'dsh-rtk-filter'
#          config:
#            command: /opt/homebrew/bin/rtk   # rtk 绝对路径（推荐，见下节）
#            args: ['pipe']                    # stdin 进、stdout 出
#            minBytes: 2048

# 3) 重启应用（或等待 HMR 对 patch 的热重载生效）
```

> 安装包自带 `cordis.patch.yml`（dsh.bundle.patch），若通过
> `dsh plugin --profile web add` 或 pnpm 安装发布版，insert 会自动生效。

## 为什么终端有 rtk，插件却找不到？

DSH 的 bash 工具是 `bash -c` 非登录 shell，**不读取 `~/.zshrc` / `~/.bashrc`**；
GUI 应用从 Finder 启动时继承的是 launchd 的最小 PATH（通常只有
`/usr/bin:/bin:/usr/sbin:/sbin` 外加应用自带 node）。所以 Homebrew 装的
`/opt/homebrew/bin/rtk`、Rustup 装的 `~/.cargo/bin/rtk` 在你的终端里能用，
但在 DSH 进程里 `which rtk` 找不到。

对策（插件已内置三重保障）：
1. **绝对路径**：挂载配置里 `command: /opt/homebrew/bin/rtk`（推荐，最直接）；
2. **候选目录自动探测**：`command` 写裸名（如 `rtk`）时，插件会依次探测
   `~/.cargo/bin`、`/opt/homebrew/bin`、`/usr/local/bin`、`/opt/local/bin`、
   `~/.local/bin`，命中即用（`resolveRtkPath`，成功结果会缓存）；
3. **静默降级**：都找不到则保留原始输出，命令照常执行。

## 配置项

| 配置 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `enabled` | boolean | `true` | 总开关；`false` 时插件完全空转（不注册任何监听器） |
| `command` | string | `'rtk'` | rtk 可执行文件；裸名先走 PATH，再自动探测候选目录（Homebrew/Rustup 等），或直接写绝对路径 |
| `args` | string[] | `[]` | 透传给 rtk 的附加参数；通用推荐 `['pipe']`（见下节） |
| `tools` | string[] | `['bash', 'job_output']` | 需要过滤的工具名；可加 `run_code`、`pwsh` 等 |
| `minBytes` | number | `2048` | 低于此字节数的输出直接放行（避免每条命令都付 RTK 延迟） |
| `timeoutMs` | number | `15000` | rtk 超时；超时则 SIGKILL 整个进程组并保留原始输出 |
| `notice` | boolean | `true` | 替换文本中追加 `[rtk: output condensed N → M bytes]` 提示行 |

## RTK 契约与 `pipe` 模式

插件与 rtk 的约定只有一条：**stdin 进原始文本，stdout 出精简文本**（退出码为 0）。
rtk 需要子命令，对应本插件的子命令是 **`pipe`**（Unix pipe 模式）：

```yaml
config:
  command: /opt/homebrew/bin/rtk
  args: ['pipe']           # 通用：stdin → stdout
```

**重要：`rtk pipe` 只有输入匹配 `-f` 指定的 filter 时才会真正压缩**，不匹配的
输入原样透传（插件检测到输出无变化时不会追加任何 notice）。常见的 filter 见
`rtk pipe --help`（如 `cargo-test`、`pytest`、`grep`、`find`、`git-log`）。
例如以 cargo 测试输出为主的工作流：

```yaml
config:
  command: /opt/homebrew/bin/rtk
  args: ['pipe', '-f', 'cargo-test']
```

测试套件里的 `tests/e2e-real-rtk.mjs` 用真实 rtk 验证了 `-f cargo-test`
场景：30 行重复通过用例被压成失败摘要，`[exit code: N]` 标记原样保留。

## 测试

```sh
# 使用应用自带 node 运行（stub rtk 位于 tests/bin/rtk）
/Applications/DeepSeek\ Harness.app/Contents/Resources/dsh/node/bin/node --test tests/rtk-filter.test.mjs
# 或
npm test
```

测试用真实 `@deepseek-ai/cordis` + `@deepseek-ai/dsh-tools` 注册表驱动
`ctx.tools.execute`，覆盖：禁用空转、正文精简+标记保留、job_output 状态行保留、
minBytes 放行、非列表工具放行、rtk 缺失/非零退出/超时/无变化/调用取消的全部降级路径、
value 替换决策透传，以及纯函数的单元用例。

## 设计取舍

- **只改模型看到的投影（content），绝不动工具的 canonical value**——程序的完整
  结果（如后台 job 的原始输出）不受影响，会话日志里仍可通过 spill 等机制追溯；
- **失败必须静默降级**：RTK 是外部依赖，任何故障都不允许把一条本应成功的命令
  变成报错；每个不同的失败原因只 warn 一次；
- **进程组击杀**：rtk 若又拉起子进程，超时/取消时必须 `process.kill(-pid)`
  整组击杀，否则孙进程会握住管道让 `close` 事件迟迟不触发（测试曾因此从 61s 降到 0.6s）；
- 标记拆分是保守的：只有**紧贴末尾的连续标记行**才算状态块，正文里恰好形似
  `[exit code: 1]` 的普通输出不会被误拆。
