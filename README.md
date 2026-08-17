# dsh-QoL

DSH Web 生活质量插件，合并了原先两个独立插件的能力：

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
├── package.json      # dsh.client 声明（web 平台，立即加载）
├── lib/
│   ├── index.js      # 宿主侧：/dsh-qol/rewrite 路由 + fork 重写逻辑
│   └── client.js     # 浏览器端：Enter 拦截 + 编辑按钮 + 行内编辑器
└── README.md
```
