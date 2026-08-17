# dsh-QoL

DSH Web 生活质量插件：

## 功能 1：Enter 换行，Ctrl/Cmd+Enter 发送

- **Enter**：换行（不再直接发送）
- **Shift+Enter**：换行（保持原生行为）
- **Ctrl+Enter / Cmd+Enter**：发送（保留 DSH 原有发送/插话逻辑）

不拦截：输入法组合期间的 Enter、忙碌/锁定/只读状态、workspace 选择模式、命令/候选菜单打开时的 Enter。

## 功能 2：编辑历史消息并重新回答

- 历史用户消息悬停时，左侧出现「编辑」按钮（仅纯文本消息）。
- 点击后消息气泡替换为可编辑文本框。
- 「保存并重新回答」后：
  1. 服务端以该消息所在 turn 之前的历史为种子，创建新子会话；
  2. 新会话沿用原 cwd、模型路由、agent preset；
  3. 编辑后的文本作为新用户消息发送，原会话当前工作被取消（保留排队消息）；
  4. 页面自动切换到新会话。

- 「保存并分支」后：
  1. 若原会话正在运行，插件会先等待当前回复完成，再创建分支（原会话完全保留）；
  2. 同样创建新子会话并发送编辑后的文本；
  3. 页面自动切换到新分支会话。

> 由于 DSH 会话是 append-only，编辑通过 fork 新会话实现，原会话保留在会话列表中。

## 功能 3：Web 文件编辑器（VS Code Remote 式）

- 页面右下角出现「文件编辑器」浮动按钮，点击打开全屏编辑器。
- 左侧工作区行的「…」菜单里追加「在编辑界面打开」：打开编辑器并把该工作区目录
  设为 tree view 的 root。
- 顶部路径栏可输入任意文件或目录路径，回车或点「打开」。
- 左侧为当前目录文件树：单击目录展开/收起，**双击目录把整棵树的 root 切换到该目录**
  （表头与「上一级」随之同步）；点击文件打开。
- 编辑区为暗色代码编辑器，支持 JS/TS/JSON/Python/HTML/CSS/Bash/Markdown/YAML 等常见语言的语法高亮。
- 「保存」把当前内容写回文件。
- **聊天历史里带下划线的文件名**，点击后直接在编辑器中打开该文件，无需手动输入路径：
  - 工具行（`Read · 路径` / `Edit · 路径`）里的下划线路径文本；
  - 正文行内 code 里提到的 `` `文件名` ``（file mention，路径取自按钮 `title`，
    仅文件名时按当前会话工作目录解析）；
  - 回合底部「产物」一行的文件 chip。
- 后端通过 DSH `fs` 服务读写文件，与 Agent 使用同一套文件系统与沙箱语义。
- **选中一段代码**后，编辑器右上角出现选择工具栏：
  - 「新会话提问」：新建会话并挂起选中内容的上下文；
  - 「回复当前会话」：把同样的上下文挂起到当前会话。
  - 采用 Claude-Code 式「延迟填塞」：**不再把文件/行号/代码直接打进输入框**，
    而是在输入栏底部、permission 右侧显示 `N lines selected` 徽标；当你真正提交
    （点「发送」或 Ctrl/Cmd+Enter）时，上下文才自动填充到你所输文本之前。
    提交后徽标消失；点徽标可先取消挂起。

- **编辑器里选中文字后按 Ctrl/Cmd+M**：弹出「新会话提问」小窗，窗内是**直接从
  主页挪过来的真实对话输入框**（模型选择、permission、附件等全部原生可用，主页
  输入框样式/行为被其他插件或 DSH 版本修改时小窗自动保持一致）。发送即在所选
  工作区/会话基础上新建会话并发送（带 `N lines selected` 上下文前缀）；新会话
  **自动归属当前工作区**（按会话-工作区绑定或其 cwd 落在哪个工作区目录判定，
  均查不到时才退化为仅按 cwd 建会话）。
  Esc、点窗外或关闭编辑器可取消；发送后小窗自动收起、输入框归位。

## 限制

- 编辑仅支持纯文本消息（含图片的消息不显示编辑按钮）。
- 需要编辑的会话必须处于打开/运行状态（live agent）。
- 暂不支持 subagent 会话。

## 安装（推荐：dsh plugin add）

```bash
dsh plugin --profile web add github:shifan3/dsh-QoL
```

然后重启 `dsh web`（或 `dsh --profile web`）并刷新页面。

`dsh plugin` 会把本包加入 web profile 的 `dsh.profile.bundles`，启动时自动应用本仓库的 `cordis.patch.yml` 激活插件。

更新到新版本：

```bash
dsh plugin --profile web update dsh-qol
```

然后重启 `dsh web`。

## 卸载

```bash
dsh plugin --profile web remove dsh-qol
```

## 手动安装（静态插件，备选）

1. 把本目录软链到 `$DSH_HOME/node_modules`：

   ```bash
   mkdir -p ~/.dsh/node_modules
   ln -sfn /path/to/dsh-QoL ~/.dsh/node_modules/dsh-qol
   ```

2. 在 `~/.dsh/cordis.patch.yml` 顶层数组追加：

   ```yaml
   - insert:
       - id: dsh-qol
         name: dsh-qol
         config:
           enabled: true
   ```

3. 刷新 Web 页面即可。

## 禁用

把 patch 里 `enabled` 改为 `false` 后刷新页面；或删除该 insert 行。

## 文件结构

```
dsh-QoL/
├── package.json      # dsh.bundle.patch + dsh.client 声明
├── cordis.patch.yml  # bundle 激活补丁
├── lib/
│   ├── index.js      # 宿主侧：rewrite/fork 路由 + fs read/list/write 路由
│   └── client.js     # 浏览器端：Enter 拦截 + 历史编辑 + 文件编辑器
└── README.md
```
