# dsh-px0

[English](README.md) | **简体中文**

一个 DSH（DeepSeek Harness）插件：在右侧栏中用 [px0](https://github.com/px0-ai/px0) 预览工作区文件。

px0 是一个单二进制、启动极快的代码 IDE。本插件把它嵌入 Harness Web 界面的右栏，与内置的文件树和预览并存。

## 功能

- **自动下载 px0**：首次启动时按当前平台/架构从 GitHub Releases 拉取对应版本，用发布页的 `checksums.txt` 校验 sha256，缓存到 `bin/` 目录。也可通过 `px0Path` 配置指定自己的二进制。
- **托管 px0 进程**：以 `-base-path /px0/` 参数挂到本机回环端口上运行；工作区根目录变化时自动重启，插件卸载时结束进程。
- **同源反向代理**：把 px0 挂在 `/px0/*` 下，剥除其 `frame-ancestors 'none'` 的 CSP 与 `X-Frame-Options` 响应头，使右侧栏的 iframe 能够嵌入。px0 本身仍只监听 `127.0.0.1`，除经过带鉴权的 Harness 源外无法访问。
- **注册右栏标签页类型**：以 `extension` 优先级认领工作区文件地址（优先于内置文本预览），在同源 iframe 中渲染 px0。
- **默认全屏**：标签页挂载时自动占满整列——px0 本来就是完整的 IDE。
- **跟随会话工作目录**：切换会话目录时，px0 会在新的根目录重启；重启期间显示自带样式的加载页，恢复后自动刷新。
- **在 px0 内增加右键菜单项**，把文件引用插入 DSH 输入框：
  - 文件树右键 → `@file:<路径>`
  - 代码选区右键 → `@file:<路径> lines:<起始行>:<起始列>-<结束行>:<结束列>`
- **更新提示**：每次运行检查一次最新版本，有新版本时在工具栏给出更新按钮。

## 安装

把 `bundle/` 目录安装到 DSH profile：

```
plugin_manager: install_bundle  target: <路径>/bundle
```

或手动链接到某个 profile：

```json
{
  "dependencies": { "@dsh-xhl/dsh-px0-preview": "link:../path/to/dsh-px0/bundle" },
  "dsh": { "profile": { "bundles": ["...", "@dsh-xhl/dsh-px0-preview"] } }
}
```

然后用 `pnpm install` 建立链接并重启 dsh，在右侧栏的向导页中选择 **px0** 入口即可。

## 配置

| 配置项 | 类型 | 说明 |
| --- | --- | --- |
| `px0Path` | string | 自行管理的 px0 二进制绝对路径。设置后不再自动下载，也不做更新检查。 |

## 工具栏

px0 页面顶部从左到右依次是：

| 按钮 | 行为 |
| --- | --- |
| 目录输入框 | 显示 px0 当前根目录，可直接编辑后回车切换到任意目录 |
| 更新 | 有新版本时出现，点击下载并重启 px0 |
| 文件夹图标 | 在系统文件资源管理器中打开当前目录 |
| VS Code 图标 | 在 VS Code 中打开当前目录 |
| 外链图标 | 在浏览器新标签页中打开 px0 |

两个「打开」按钮复用 DSH 自带的 `open-in-app` 接口，因此哪些应用可用、如何启动都由该插件统一决定。

## 目录结构

```
bundle/
├── index.js          Host 侧：二进制管理、进程、/px0 代理、/px0-api 控制接口
├── client.js         Client 侧：标签页类型、iframe 宿主、加载/错误状态、输入框插入
├── px0-extras.js     注入 px0 文档的脚本：右键菜单扩展
├── cordis.patch.yml  插入插件行的 Loader 补丁
├── icon.svg
└── locale/           en / zh-CN 显示元数据
```

## 已知限制

- px0 的根目录在进程生命周期内固定，因此切换工作区会重启进程。大仓库首次打开需要几秒建索引。
- px0 界面使用自身主题，不跟随 Harness 的明暗切换。
- 代码选区的引用格式沿用 px0 原有的 `@file:path lines:a:b-c:d` 写法。

## 许可证

MIT
