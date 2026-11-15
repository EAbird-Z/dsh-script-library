# 脚本库 · dsh-script-library

**给 DeepSeek Harness 的一个「别再重写」面板。**

它解决一件很具体的事：你（或你的 agent）在不同工作区里反复写脚本，过两个月忘了写过什么，又从头写了一遍。这个插件维护一份**跨工作区的可调用清单**，并且提供一个按钮，让「登记」这件事不用靠记性。

> Script Library for DeepSeek Harness — a per-machine registry of reusable scripts. One click scans for what you wrote since last time, you add one sentence per script, and the agent can find and call it from any workspace. Chinese UI; English summary at the bottom.

---


## 安装

需要 DeepSeek Harness。

**方式一：从 GitHub 装**（在宿主环境里执行）

```
plugin_manager install_bundle  target=git+https://github.com/EAbird-Z/dsh-script-library.git
```

**方式二：本地面板**

Plugins → Add plugin → 选这个目录。改代码时用这种，链接安装、改了立刻生效。

**方式三：指定本地路径**

```
plugin_manager install_bundle  target=/absolute/path/to/dsh-script-library
```

装完刷新页面，侧边栏出现「脚本库」。

## 快速开始

1. 侧边栏点「脚本库」→ 「待登记」→ **扫一遍**。
2. 列表里会出现新写的脚本（默认只扫**已注册的工作区**）。
3. 勾选要留的，填「干什么的」（必填），参数可空。
4. 点「登记 N 条」。
5. 回到「清册」，能看到它，状态是「可用」。

登记过的条目会被外部工具（比如 `lib` 这一类命令行封装）按同一份 `registry.json` 读取，所以面板和命令行永远一致。

## 数据存在哪

默认 `~/.dsh/script-library/`：

```
~/.dsh/script-library/
├── registry.json   ← 唯一真相源：所有可调用条目
├── .seen.json      ← 扫描基线（「这些看过了」）
├── roots.json      ← 可选：额外的扫描根
└── INDEX.md        ← 可选：给人读的账本（插件不写它）
```

**采纳已有目录**：如果机器上已经有 `~/.dsh/skills/script-index/registry.json`，插件会自动用它当 store，不另起一份 —— 所以它能接管一套正在用的配置，而不是让你二选一。

## 配置

在 bundle 的插件行里可以覆盖 `storeDir`：

```yaml
- id: script-library
  name: 'dsh-script-library'
  config:
    storeDir: ~/my-scripts-registry
```

### 扫描根 `roots.json`

插件默认只扫**已注册的工作区**（来自 DSH 的 workspace 注册表）。想让某些不在工作区里的目录也被扫到，写 `roots.json`：

```json
{
  "roots": [
    { "path": "~/Downloads/素材", "depth": 2 },
    "~/.dsh/skills:4"
  ]
}
```

`depth` 是往下扫几层。默认 2（工程根 + 一级子目录）—— 再深就是别人项目的内部结构，候选会被噪音淹没。

## 它是怎么判断「新」的

两层记录，缺一不可：

- `.seen.json`（机器写的）：我看过这些文件了。扫描只报**基线里没有的**。
- `registry.json`（人写的）：这 16 个值得再调用。

只有 Markdown 清单，每次都得分清 183 个文件哪个是新的；只有基线，你不知道某个文件是干嘛的。所以两层分开。

## 扫描器也能单独用

`scripts/scan.py` 不依赖 DSH，只读，标准库：

```bash
python3 scripts/scan.py --store ~/.dsh/script-library            # 只报新增
python3 scripts/scan.py --store ~/.dsh/script-library --all      # 全列
python3 scripts/scan.py --store ~/.dsh/script-library --ack      # 建立/更新基线
python3 scripts/scan.py --store ~/.dsh/script-library --md       # 出可粘的表格行
python3 scripts/scan.py --store ~/.dsh/script-library --check    # 有新增则退出码 1
```

`--print-roots` 打印当前生效的扫描根，方便排查「为什么没扫到 X」。

## 设计取舍

几条刻意的选择，都不是偷懒：

- **「干什么的」必填，参数可空。** 这一句话是以后能不能搜到它的唯一依据。自动推断不出来，所以不假装能推断。
- **不自动登记。** 清单的价值是策展。跑过一次的 `test_x.py` 收进来，清单就废了。
- **不做代码搜索。** 它管「有哪些工具、怎么调」，不管「这段代码在哪」。后者用编辑器。
- **体检不执行。** 只检查路径和文件是否存在，绝不为了验证去跑一遍你的脚本。
- **空手也能用。** 全新机器上第一次打开，清册是空的，扫一遍就是这台机器的现状，不需要预置任何东西。

## 边界

- 只读扫描：不移动、不修改、不删除被扫的文件。唯一写入的是 store 里的两个 JSON。
- 依赖 `python3`（扫描器用；标准库，无第三方依赖）。
- 面板只在 Web 端（`dsh.client.platform = web`）。
- 不跨机器：清单里存的是本机绝对路径。
- 工作区扫不到的深层目录，要么加进 `roots.json`，要么把深度调大 —— 但那会让噪音变多。

## 目录结构

```
dsh-script-library/
├── package.json          # dsh.bundle.patch + dsh.client
├── cordis.patch.yml      # 插入一行 script-library
├── index.js              # Host：三条路由（registry / scan / register）
├── client.js             # Web：侧边栏图标 + 主栏两页
├── scripts/scan.py       # 只读扫描器（零依赖）
├── defaults/registry.json# 新 store 的种子（空清单）
├── locale/{en,zh}.json   # 插件标题/说明
├── docs/DETAIL.md        # 插件详情页
├── icon.svg
├── LICENSE
└── README.md
```

自检：

```bash
node --check index.js && node --check client.js
python3 scripts/scan.py --store /tmp/sl-test --add-root ~/some/dir:2 --json
```

## 已知限制

- 插件不写 `INDEX.md`。那是给人读的账本，靠手工维护，插件只碰 `registry.json` 和 `.seen.json`。
- 首次扫描在目录很多的机器上可能要几秒（每次 spawn 一个 python）。
- 渲染层没有自动化测试，靠人工看一眼。

## English summary

A DeepSeek Harness plugin that keeps a per-machine registry of reusable scripts. A sidebar panel lists every registered entry with a live health check (does its directory, entry file, and declared dependency still exist?), and a second tab scans for scripts written since the last sweep so you can register the useful ones with one sentence each. Registered entries are plain JSON, so command-line wrappers read the same file. The bundled read-only scanner has no third-party dependencies; scan roots default to your registered workspaces and can be extended with `roots.json`.

## License

MIT.
