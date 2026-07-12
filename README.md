# CloudMusic CLI

CloudMusic CLI 是一个面向终端和 AI 工具的网易云音乐播放器。它直接使用
`@neteasecloudmusicapienhanced/api` 获取歌曲信息、歌词与播放地址，通过 FFmpeg 解码一次 PCM，
再把同一份 PCM 交给 mpv 播放和 FFT 频谱分析。

## 特性

- 常驻 daemon 保存播放队列、登录和播放状态
- 搜索、播放、暂停、Seek、音量、队列、歌词和频谱命令
- 终端实时播放页与同步歌词
- 基于真实 PCM 的 64 频带频谱
- 二维码/Cookie 登录、完整歌单播放、每日推荐、私人 FM 和喜欢歌曲
- 自动网易云听歌上报，默认启用 NCBL，可切换 legacy
- 独立终端设置页，配置音质、解灰、试听、SMTC 与听歌上报
- 官方音源优先，支持 `song_url_match` 解灰回退
- 稳定 JSON 输出和 stdio MCP Server
- Windows Named Pipe 与 Linux/macOS Unix Socket
- Windows SMTC 系统媒体卡片、进度和媒体按键控制

## 环境要求

- Node.js 20+
- pnpm 10+
- FFmpeg
- mpv

```bash
pnpm install
pnpm build
pnpm link --global
ncm doctor
```

Windows、macOS 和 Linux 都必须确保 `ffmpeg` 与 `mpv` 位于 `PATH`。也可以通过配置文件指定完整路径。

手动 Cookie 登录至少需要包含 `MUSIC_U`。程序会在保存前调用网易云登录状态接口验证账号，
只有返回有效用户资料时才会覆盖本地凭据。Cookie 保存在当前用户的应用配置目录，默认不会出现在
命令输出、日志或 JSON 响应中。为了避免 Shell 历史记录，优先使用不带参数的 `ncm login cookie`
并在隐藏输入提示中粘贴。

## 使用

```bash
# 无参数进入实时播放页
ncm

ncm search "晴天"
ncm play 186016
ncm pause
ncm resume
ncm seek +10
ncm volume 70
ncm status --json
ncm spectrum --json
ncm login qr
ncm login cookie
ncm login verify
ncm library playlists
ncm library playlist 9265368428
ncm library playlist 9265368428 --play --index 0
ncm library daily --play
ncm library fm --play
ncm library fm-trash
ncm mode shuffle
ncm scrobble status
ncm scrobble mode ncbl
ncm smtc status
```

播放页快捷键：

- `/`：在当前页面输入关键词、搜索并选择歌曲
- `l`：打开音乐库，可浏览歌单、每日推荐并进入私人 FM
- `o` 或 `,`：打开独立设置页
- `c`：在当前页面隐藏输入 Cookie，验证后保存账号
- `g`：在当前页面显示二维码并自动等待登录
- `v`：验证当前保存的账号
- `u`：退出当前账号
- `Tab`：打开播放队列并选择歌曲
- `Space`：暂停或恢复
- `←` / `→`：后退或前进 5 秒
- `↑` / `↓`：调整音量
- `p` / `n`：上一首或下一首
- `f`：喜欢或取消喜欢当前歌曲
- `m`：循环切换顺序、单曲循环和随机模式
- `d`：在私人 FM 中丢弃当前歌曲并播放下一首
- `q`：退出播放页，后台播放不会停止

歌单和每日推荐页面中，`Enter` 会从当前选中歌曲开始整队播放，`a` 从第一首播放全部。
听歌上报默认开启，按真实播放时长累计；歌曲大于 30 秒且播放达到一半或 240 秒中的较小值时，
每个播放周期最多上报一次。可在设置页选择 NCBL（PLV/PLD）或 legacy 方式。

## AI 与 JSON

所有非交互命令支持 `--json`：

```bash
ncm --json search "晴天"
ncm --json play 186016
ncm --json status
```

stdout 只包含 JSON，诊断信息写入 stderr。默认输出不会包含 Cookie、登录凭据或签名播放 URL。

启动 MCP Server：

```bash
ncm mcp
```

MCP 客户端配置示例：

```json
{
  "mcpServers": {
    "cloudmusic": {
      "command": "ncm",
      "args": ["mcp"]
    }
  }
}
```

提供的工具包括歌曲搜索、播放控制、队列、歌词、频谱快照、完整歌单、每日推荐、私人 FM、
喜欢歌曲、播放模式和播放器设置。

## 播放架构

```text
Netease API → signed URL → FFmpeg → PCM tap → mpv → speaker
                                      └────→ FFT Worker → TUI/MCP
```

FFmpeg 输出固定为 48 kHz、双声道、16 位 PCM。FFT 使用 2048 点 Hann 窗和 50% 重叠。
Seek 会从目标位置重建解码管线；频谱帧通过 mpv 实际播放时间对齐，不使用随机动画。

Windows 构建会同时编译一个轻量 Rust SMTC 桥接器。它负责系统媒体卡片、封面、播放状态、
时间线以及播放/暂停/上一首/下一首/Seek 按键，不需要 Electron。

## 开发

```bash
# 开发阶段无需每次构建，直接运行 TypeScript 版本
pnpm dev

# 或传入普通命令
pnpm dev -- library playlists

pnpm format
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

## 许可证

本项目采用 GNU Affero General Public License v3.0 only。AGPL 允许商业使用，但修改版本及通过网络提供的服务必须按许可证提供对应源码。

本项目参考 SPlayer 的产品流程与播放状态设计；相关归属见 [NOTICE](NOTICE)。
