# 番茄钟 · Pomodoro Timer

简约、护眼、清晰的本地桌面番茄钟。基于 Electron 构建，无边框小窗，**所有数据只存在本机，不联网、不登录、不上传**。

支持番茄钟倒计时与无限计时两种模式，能记录每天的学习时长并导出到 Excel，还会在你离开电脑时自动暂停计时。

## 下载使用

到 [Releases](https://github.com/Mangran-mang/Pomodoro-Timer/releases) 下载 `TomatoClock-Portable-x.y.z.exe`：

- **免安装**，单文件，双击即用（Windows 10 / 11，64 位）；
- 首次运行若提示「Windows 已保护你的电脑」，点 **更多信息 → 仍要运行** 即可（程序未做代码签名，属正常提示）；
- 请放在**有写权限的目录**（桌面、文档、其他数据盘），学习记录会生成在 exe 同目录；
- 卸载＝删除 exe 和同目录的 `学习记录.xlsx`（设置数据在 `%APPDATA%\tomato-clock\`，可一并删除）。

## 功能特性

| 功能 | 说明 |
| --- | --- |
| 北京时间 | 固定使用 Asia/Shanghai 时区，显示 时:分:秒 |
| 两种计时模式 | **番茄钟**：倒计时，结束自动切换休息；**无限计时**：没有倒计时，正计时一直累计直到手动结束。模式在设置里选择并记住 |
| 学习 / 休息时长 | 可手动输入或点按 −/＋ 调节，分钟上限 60；仅番茄钟模式可用 |
| 空闲暂停 | 5 分钟无键鼠操作或锁屏时自动暂停计时，回来一动键鼠自动继续（可关闭） |
| 程序监控（白名单） | 添加你用来学习的程序（如 PyCharm、VS Code），**列表里任一程序在运行时才计时**；程序启动自动开始计时。白名单为空则不启用 |
| 学习记录 | 「本次学习」实时累计，点「记录」写入本地 Excel 并计入今日累计 |
| 每日时长 | 今日累计 = 当天所有记录之和；Excel 里每天一行，含「今日学习程度」评级 |
| 历史记录 | 日历视图按月查看每天学了多久，可翻页，含本月合计 |
| 今日待办 | 最多 4 项，勾选完成；每天 6:00 自动清除 |
| 提示音 | 学习结束播放 A 音频，休息结束播放 B 音频，可自选本地文件 |
| 无边框小窗 | 可置顶、可锁定位置、可调字号；窗口位置与大小自动记住 |
| 开机自启动 | 设置里一个开关，写入当前用户注册表，无需管理员权限 |

### 关于监控的隐私说明

- **空闲暂停**只读取系统级「键鼠空闲时长」和锁屏状态，用的是 Electron 内置 `powerMonitor`；
- **程序监控**只比对进程名（`tasklist`），**不读取窗口标题、不记录你看了什么内容**，也不上报任何数据；
- 程序监控每 10 秒检测一次；白名单为空时完全不检测。

## 学习记录的 Excel 格式

记录文件：与 exe 同目录的 `学习记录.xlsx`（开发版在项目目录），三列：

| 日期 | 学习时间(分钟) | 今日学习程度 |
| --- | --- | --- |
| 2026-08-26 | 150 | 适宜 |

- **每天只有一行**：同一天多次记录会自动累加到同一行；
- 「今日学习程度」按当天总时长自动评级：`<2 小时 = 不足`，`2~4 小时 = 适宜`，`4~6 小时 = 努力`，`≥6 小时 = 过度`；
- 可以直接用 Excel 打开查看或编辑，应用下次记录时会把改动合并回去。

## 数据存放位置

| 内容 | 位置 |
| --- | --- |
| 学习记录 | 便携版：exe 同目录 `学习记录.xlsx`；开发版：项目根目录 |
| 设置 / 待办 / 窗口状态 | `%APPDATA%\tomato-clock\`（`window-state.json`、Local Storage） |

## 从源码运行

```bash
npm install          # 已配置 npmmirror 镜像，国内可直接装
npm start            # 或双击 启动番茄钟.bat
```

要求：Node.js 18+、Windows 10/11。

## 打包与发布

```bash
npm run build        # 生成便携版 exe → dist/TomatoClock-Portable-<version>.exe
npm run release      # 推送代码 + 创建 GitHub Release 并上传 exe（需 gh 已登录）
```

打包使用 [electron-builder](https://www.electron.build/)，国内可设镜像避免访问 GitHub：

```bash
export ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/
export ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
```

## 项目结构

```
番茄钟/
├── main.js          # 主进程：窗口、托盘、Excel 读写、空闲检测与进程白名单、开机自启动
├── preload.js       # contextBridge 暴露的安全 IPC 接口
├── renderer.js      # 渲染进程：计时逻辑、记录与日历、设置
├── index.html       # 界面结构
├── styles.css       # 样式（护眼米白 + 墨绿）
├── build/           # 应用图标（番茄 + 闹钟指针）
└── release.js       # 一键发布脚本
```

技术栈：Electron 33 + 原生 JavaScript（无框架）+ [SheetJS/xlsx](https://sheetjs.com/)（Excel 读写），渲染进程开启 `contextIsolation`，通过 `preload` 暴露最小 IPC 面。

## 许可

个人学习自用项目，未指定开源许可。如需转载或商用请先联系作者。
