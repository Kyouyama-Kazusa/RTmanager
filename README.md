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

## 文件

| 文件 | 作用 |
|---|---|
| `index.html` | 应用本体，含全部界面与逻辑 |
| `manifest.webmanifest` | PWA 清单：名称、图标、启动方式 |
| `sw.js` | Service Worker，负责离线缓存 |
| `icon.svg`、`icon-192.png`、`icon-512.png` | 应用图标 |
| `apple-touch-icon.png`、`icon-180.png` | iOS 桌面图标（iOS 不认 SVG） |
| `.nojekyll` | 让 GitHub Pages 跳过 Jekyll 处理，空文件 |
| `README.md` | 本说明 |

## 维护

改动推送前，递增 `sw.js` 里的 `CACHE` 版本号（当前 `radiotherapy-v8`），
否则已安装到桌面的用户会停留在旧版本。
