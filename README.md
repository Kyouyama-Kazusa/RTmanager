# 放疗患者管理

放疗科患者管理工具。离线优先的单文件 PWA，**数据只存在本机**，不上传任何服务器。

## 访问

<https://kyouyama-kazusa.github.io/RTmanager/>

## 安装到手机

- **Android**：Chrome 打开 → 菜单 → 安装应用
- **iOS**：Safari 打开 → 分享 → 添加到主屏幕

> iOS 必须用 Safari。从桌面图标打开 与 用 Safari 打开是两个独立的存储空间，
> 数据互不相通，请固定用桌面图标进入。

## 数据安全（重要）

数据只存在当前设备，请**定期「⋯ → 导出完整备份」**：

- 长期不打开应用时，iOS 可能清理站点存储
- 清理浏览器数据、卸载浏览器都会清除数据
- 换设备用「导出 → 导入」，**选「合并导入」不会丢数据**
- 不要更换域名 —— 数据按域名隔离存储；同一域名下换路径不受影响

## 云同步（可选，加密存到 GitHub）

`⋯ → 云同步（加密存到 GitHub）`，用你自己的 GitHub 账号做跨设备同步，**不需要服务器**。

- 云端只存**加密后的数据**，密钥和 Token 只在本机。GitHub 的 Secret Gist 并非真正私有
  （知道链接就能访问），所以加密是前提，不是可选项
- 换设备只需「同一个 Token + 同一个密码」，或粘贴云端地址
- 拉取默认走**合并导入**，两台设备各改各的都不会互相覆盖
- 需要 https 打开才能加密（线上地址或本机 localhost，`file://` 不可用）

配置步骤见设置页内的引导。Token 只需 `gist` 权限：
Classic token 勾选 `gist`；Fine-grained token 把 `Gists` 设为 Read and write。

## 文件

| 文件 | 作用 |
|---|---|
| `index.html` | 应用本体，含全部界面与逻辑 |
| `manifest.webmanifest` | PWA 清单：名称、图标、启动方式 |
| `sw.js` | Service Worker：离线缓存 + 新版本提示 |
| `icon.svg`、`icon-192.png`、`icon-512.png` | 应用图标 |
| `apple-touch-icon.png`、`icon-180.png` | iOS 桌面图标（iOS 不认 SVG） |
| `.nojekyll` | 让 GitHub Pages 跳过 Jekyll 处理，空文件 |
| `README.md` | 本说明 |

数据都放在浏览器 `localStorage`（键名前缀 `radiotherapy.`），共五类：

| 键 | 内容 |
|---|---|
| `radiotherapy.v1` | 患者主数据 |
| `radiotherapy.snap.*` | 每日自动快照（保留最近 7 天，可在设置里按日期回退） |
| `radiotherapy.backup.*` | 更新前自动备份（保留最近 3 份，可回退） |
| `radiotherapy.holidays`／`.makeups`／`.tpls` | 用户自定义的节假日、调休上班日、随访模板（升级不丢） |
| `radiotherapy.sync` | 云同步配置（GitHub Token、密码、云端地址） |

> 云同步的密码默认保存在本机（可在设置里取消勾选）。**忘记密码将无法解密云端数据**，
> 且没有任何找回方式 —— 请单独记好。本机数据不受影响。

## 维护

**发布用 `dev-tools/release.sh`，它会自动递增 `sw.js` 里的 `CACHE` 版本号（当前 `radiotherapy-v13`）、
跑完测试再推送，并轮询确认 Pages 已生效** —— 不递增版本号的话，已安装到桌面的用户会停留在旧版本。

```bash
bash dev-tools/release.sh "这次改了什么"
```

发布前会自动跑两道门禁：

- 回归测试（`dev-tools/`，共 **1,031 项断言**，15 个套件，全部只读取 `index.html`，不修改源码）
- 兼容性门禁 `test-compat.js`（58 项）—— 拦截会让老用户丢数据或导致 PWA 装不上的改动

```bash
node test-compat.js                 # 兼容性门禁：键名 / 迁移 / 只补不丢 / PWA 资源完整
node qa-audit.js                    # 缺陷修复验收（108 项，覆盖 12 项已知缺陷）
node test-sync.js                   # 云同步全链路（模拟 GitHub API，81 项）
node test-*.js                      # 排程 / 迁移 / 合并 / 随访 / 模板 / AI / SW ...
node qa-perf.js                     # 渲染耗时与存储占用探针

bash scan-dates.sh                  # 跨日期扫描（必须用 bash 跑），防「只在今天绿」
```

