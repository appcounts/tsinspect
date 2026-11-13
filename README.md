# tsinspect

一款面向 **DVB（T/T2/S/S2/C）**、**ATSC 1.0** 和 **ISDB-T / ISDB-Tb** 的 MPEG-TS 传输流快速分析工具。

`tsinspect` 可读取本地文件或 HTTP(S) 传输流，重组 PSI/SI section，并输出包布局、传输元数据、服务、基本流、PID、表、EPG 数据和诊断信息。同一套 TypeScript 核心驱动 CLI 与服务端分析流程，也可直接在 Node、浏览器或 Web Worker 中运行。

> 状态：**本地可用**。CLI 可探测文件和静态 HTTP(S) 流，解析 PAT、PMT、SDT、NIT、BAT、EIT、RST、ST、SIT、TDT/TOT、AIT、ATSC PSIP（MGT/TVCT/STT/EIT/ETT/RRT）以及 ISDB BIT/LDT/SDTT/CDT；解码日文 ARIB 与巴西 SBTVD（ABNT NBR 15606-1）文本及 ARIB 追加符号；读取 ISDB-Tb 204 字节尾部和 IIP PID；建立 PES 流索引；提取 Teletext 页面、带样式/DRCS 图层的 ARIB 字幕文本、带独立样式图层的 ATSC CEA-608/708 字幕以及 DVB 字幕段；索引 VBI 单元、SCTE-35 splice 信息、SCTE-18 EAS、ISDB EWBS 与印尼 EWS（TRDW/TCDW/TMDW 私有表）应急信息（按 PCR 码流时间切分为时间段），以及 MPE/MPE-FEC 数据报和 DSM-CC 对象轮播（解析 DSI/DII/DDB、装配模块、按服务网关重建目录树并导出文件）；解析 MPEG-2/H.264/H.265 视频和 AAC/AC-3/E-AC-3 音频参数；推断载荷能力（Teletext、字幕、captions、VBI、SCTE-35、CA）；跟踪 PID、PCR/时序、连续计数器（含重复包）和 section CRC；并可导出文本、JSON、表索引、校验结果、SRT 或独立 HTML 报告。本地 Fastify 控制台以浏览器 UI 呈现同样数据。PAT/PMT/SDT/VCT 结构会在 CI 式检查中与 TSDuck 比对。

## 环境要求

- Node.js 20.12 或更高版本（构建 Windows 可执行文件需要 Node.js 24+）
- pnpm（`corepack` 会自动使用仓库锁定的 pnpm 12 版本）

在 Windows PowerShell 中，`npm.ps1` 可能被执行策略拦截。请改用 `cmd /c` 或 `corepack pnpm`。

```bash
corepack pnpm install
```

## 快速开始

```bash
# 人类可读报告
corepack pnpm dev probe path/to/stream.ts

# 只分析远程流的前 16 MiB
corepack pnpm dev probe https://example.com/stream.ts --bytes 16mb

# 供脚本使用的稳定 JSON
corepack pnpm dev probe stream.ts --format json --out report.json

# 独立 HTML 报告
corepack pnpm dev probe stream.ts --format html --out report.html

# 仅表索引（PAT/PMT/SDT/EIT/TOT、ATSC PSIP、ISDB BIT/LDT/…）
corepack pnpm dev tables stream.ts --table pat,pmt,eit
corepack pnpm dev tables stream.ts --pid 0x11,0x12 --format json -o tables.json
corepack pnpm dev tables stream.ts --detail

# 仅校验（退出码 0 无问题，1 警告，4 错误）
corepack pnpm dev validate stream.ts
corepack pnpm dev validate stream.ts --strict --format json

# ISDB-Tb 文本配置覆盖（204 字节流自动选择 SBTVD）
corepack pnpm dev probe brazil-188.ts --profile brazil

# PES 流索引（PID、stream id、PES 数量、首/末 PTS）
corepack pnpm dev pes stream.ts

# 提取字幕 / Teletext / VBI
corepack pnpm dev extract stream.ts --kind arib-caption -o out/
corepack pnpm dev extract stream.ts --kind dvb-subtitle -o out/
corepack pnpm dev extract stream.ts --kind teletext -o out/
corepack pnpm dev extract stream.ts --kind atsc-caption -o out/
corepack pnpm dev extract stream.ts --kind vbi -o out/

# SCTE-35 splice 信息
corepack pnpm dev scte35 stream.ts
corepack pnpm dev scte35 stream.ts --timeline --format json -o scte35.json

# DSM-CC 对象轮播：列出目录树或导出文件
corepack pnpm dev carousel stream.ts
corepack pnpm dev carousel stream.ts --pid 0x1e9e --export carousel-out/
corepack pnpm dev carousel stream.ts --format json -o carousel.json
```

`tsinspect <source>` 是 `tsinspect probe <source>` 的简写。

### 选项

| 选项 | 说明 |
| --- | --- |
| `-b, --bytes <size>` | 最多读取指定字节数（`16mb`、`1gib` 等）。默认 64 MiB；`0` 读取整个源。 |
| `-a, --all` | 显示所有 PID、描述符原始字节以及全部标准判定依据。 |
| `--profile <profile>` | 文本配置：`auto`（默认）、`japan` 或 `brazil`（SBTVD）。 |
| `-f, --format <format>` | `text`（默认）、`json` 或 `html`。 |
| `-o, --out <file>` | 将报告写入文件而不是标准输出。 |

对于较大的源，`tsinspect` 默认只采样前 64 MiB。此时会打印提示，并在 JSON 中将 `source.full` 标记为 `false`；传 `--bytes 0` 可读取全部内容，或指定更大的值，例如 `--bytes 512mb`。

`tsinspect tables` 同样支持 `--bytes`、`--all`、`--profile`、`--format` 和 `--out`，另外增加：

| 选项 | 说明 |
| --- | --- |
| `-t, --table <names>` | 只显示名称/id 匹配的表，例如 `pat,pmt,eit` 或 `0x42`。 |
| `-p, --pid <pids>` | 只显示指定 PID 上的表（十进制或 `0x` 十六进制）。 |
| `-d, --detail` | 显示紧凑的解析摘要（网络、服务、PMT 流、PSIP 计数等）。 |
| `-a, --all` | 包含私有/未知 table id。 |

`tsinspect validate` 支持 `--bytes`、`--format` 和 `--out`，另外增加：

| 选项 | 说明 |
| --- | --- |
| `--strict` | 将警告视为校验失败（退出码 4）。 |

校验退出码：`0` 无问题，`1` 警告，`4` 错误，`2` 输入不可读。

`tsinspect pes` 支持 `--bytes`、`--profile`、`--format` 和 `--out`，并增加 `--pid`，输出支持 `text`/`json`。

`tsinspect extract` 支持 `--bytes`、`--profile` 和 `--pid`，另外增加：

| 选项 | 说明 |
| --- | --- |
| `-k, --kind <kind>` | `teletext`、`dvb-subtitle`、`arib-caption`、`atsc-caption`、`vbi` 或 `all`（默认）。 |
| `-o, --out <dir>` | 输出目录（默认 `extract`）。 |

提取功能会写出 JSON 索引、Teletext 文本、ARIB/ATSC SRT、彩色 Teletext HTML 和 VBI 单元索引；Teletext 页面会跨 PES 包重组（包括 VBI PES 内的 Teletext 单元），页头中的拉丁国家选项子集用于还原带重音的字符，重复滚动的页面和同一次传输的快照会被去重，马赛克图形不会进入文本输出，第 24-31 行的控制数据会被忽略。DVB 字幕基于位图，因此按 display set、page、region、object、CLUT、显示窗口和 PTS 建立索引，而不是转录为文本。长录像默认采样 64 MiB；完整提取字幕/Teletext 请使用 `--bytes 0`。

`tsinspect scte35` 列出流类型 0x86 PID（或流类型 0x06 且带 `CUEI` 注册描述符的 PID，也可用 `--pid` 指定）上的 splice 信息 section，包括 `splice_insert`、`time_signal`、`splice_schedule` 和 `private_command`；支持文本/JSON 输出，`-t, --timeline` 会附带按码率估算的事件时间和 break 区间，并可用 `--out` 写入文件。

`tsinspect carousel` 扫描 DSM-CC 对象轮播（表 id 0x3B/0x3C，DSI/DII/DDB），按 DII 的 `blockSize` 装配每个模块，解析模块内的 BIOP 消息（`srg` 服务网关、`dir` 目录、`fil` 文件、`str` 流对象），再从服务网关的绑定递归重建目录树：

```bash
corepack pnpm dev carousel stream.ts --export carousel-out/   # 导出可恢复的文件
corepack pnpm dev carousel stream.ts --pid 0x1e9e -f json -o carousel.json
```

| 选项 | 说明 |
| --- | --- |
| `-b, --bytes <size>` | 最多读取指定字节数。长录像默认只采样 64 MiB，完整模块需要 `--bytes 0` 或更大值。 |
| `-p, --pid <pids>` | 只分析这些 PID。 |
| `--export <dir>` | 将内容完整的文件写到目录；多 PID 时按 `pid-xxxx/` 分目录。 |
| `-f, --format <format>` | `text`（默认）或 `json`（不含文件内容）。 |
| `-o, --out <file>` | 将目录树/JSON 写入文件而不是标准输出。 |

文本输出会标出每个对象的路径、声明大小、MIME 类型和是否完整；`incomplete` 表示样本里缺少该对象所在模块的数据块（增加采样范围可补齐）。CLI、服务端分析流程和 `carousel` 命令都会解压 `compressed_module_descriptor` 描述的 zlib 模块；不经 Node 的纯核心调用（例如浏览器内联使用）可通过 `ProbeOptions.inflate` 自行注入解压函数，未注入时只统计这类模块。解析范围、重建流程与资源上限见 [`docs/object-carousel.md`](docs/object-carousel.md)。

退出码：`0` 成功，`1` 用法或 I/O 失败，`2` 分析完成但存在 error 级诊断（例如缺少 PAT）。

## Web 控制台

控制台是由 Fastify 会话 API 提供服务的 React 19 + Vite 应用：

```bash
corepack pnpm build:web    # 构建 apps/web/dist
corepack pnpm serve        # http://127.0.0.1:5173

# 带 API 代理的前端开发服务器（http://127.0.0.1:5174）
corepack pnpm dev:server
corepack pnpm dev:web
```

控制台可输入本地路径或 HTTP(S) URL，也可通过系统文件选择对话框选取文件，随后打开一个工作台：顶部是应用栏与页签栏（概览、PID、表、数据广播、EPG、字幕/图文/CC、时间线、校验、Hex），中间是全宽数据画布，右侧是可收起的会话抽屉。概览页包含摘要卡片、带流详情面板的服务列表、PID 计数器、PSI/SI 表和应急预警行——SCTE-18 EAS、ISDB EWBS 和印尼 EWS 告警按码流时间（PCR）切成时间段，按节目分组展示级别、灾害与区域，并附类型/等级/进行中图例；应急横幅只在概览页显示；数据广播页展示 MPE 数据报、MPE-FEC、DSM-CC 对象轮播以及 MHP/HbbTV 应用信令，对象轮播会从服务网关重建目录树，逐项列出路径、大小、MIME 与完整性，并可下载内容完整的文件（`/api/sessions/:id/carousel`、`/api/sessions/:id/carousel/file`）；EPG 页按节目分组事件，字幕页按节目划分页签，时间线页提供可点击 PID 序列的码率和每 PID 活动、字幕 cue 轨道和 SCTE-35 标记，校验页支持严重级别筛选和严格模式，Hex 页提供十六进制查看器。表格支持按列显隐、点击表头排序以及长列表吸顶表头；流描述符会在紧凑的详情对话框中展示已解码字段（例如 ISO 639 语言显示为 `French (fra)`，并附数值 stream identifier），原始十六进制则藏在二级开关之后。十六进制查看器会标出 TS 同步字节、按包交替底色，并可从 PID 表或 PID 选择器跳转到任意 PID 的首个包。音频轨道会为音频描述、口述字幕和听障服务显示无障碍徽标；音频/字幕行显示可读的语言徽标、易读（easy-reader）和宽画幅标记，并提供“仅无障碍”开关过滤流表。字幕页签将 Teletext、DVB/ARIB 字幕、ATSC CEA-608/708 闭路字幕和 VBI 分为不同分组，带按类型筛选和计数，并把 Teletext、ARIB 和 ATSC 字幕文本提取为带时间轴的 cue，同时按 display set 和 page 索引 DVB 位图字幕。Teletext 字幕图层会以原始 720x576 单元几何在时间轴预览中绘制，包含前景/背景色、双高、马赛克、conceal 和 box 属性。DVB 位图字幕由 CLUT、region 组合和 object 像素数据解码，并按需在原始显示几何上合成（`/api/sessions/:id/subtitles/frame`）；ARIB cue 会在广播几何上解码为带样式的文本段（前景色、字号、下划线、装饰、粗体/斜体、conceal、闪烁、背景、CSI/APS 位置、DRCS 位图字形以及来自 ARIB STD-B24 的 A/C-profile 字体度量）。ATSC 流会生成独立的 CEA-608（CC1–CC4 检测、15×32 屏幕、pop-on/roll-up/paint-on、PAC 行列、颜色、斜体、下划线）和 CEA-708（DTVCC 包、服务块、窗口、锚点、笔属性/颜色、窗口样式和显示区间）样式预览。Teletext 滚动页面会按更新时间拆分，DVB 位图帧带有显示窗口偏移并裁剪到该窗口。页签、筛选条件和当前会话都会反映到 URL hash 中，便于深链接；界面支持中英文切换，会话抽屉可导出 JSON/HTML。`POST /api/sessions` 接受 `{ "source": "...", "bytes": 67108864 }`；会话相关端点提供 services、PIDs、tables、EPG、data broadcast、carousel、carousel files、subtitles、subtitle frames、timeline、SCTE-35、validation、hex 和 export。

Playwright 针对构建后的控制台执行浏览器流程：

```bash
corepack pnpm build:web
corepack pnpm test:e2e
```

### Windows 可执行文件

`build:exe` 会生成单个 `dist\tsinspect.exe`，内嵌 CLI、Fastify 服务器和构建后的 Web 控制台。运行时不需要 Node.js 或 `apps/web/dist`。

```powershell
corepack pnpm build:exe
.\dist\tsinspect.exe                # 启动 Web UI 并打开浏览器
.\dist\tsinspect.exe probe stream.ts
.\dist\tsinspect.exe serve --port 8080 --host 127.0.0.1 --open
```

不带参数运行时，可执行文件会在 `127.0.0.1` 上启动 Web 控制台（5173 被占用时使用下一个空闲端口）并打开默认浏览器。所有 CLI 子命令照常可用。构建使用 Node 的单可执行应用（SEA）和 `postject`，因此请在 64 位 Windows 上使用 Node.js 24 或更高版本构建；可执行文件内嵌该 Node 运行时且未签名，首次启动时 Windows SmartScreen 可能给出警告。

## 测试流

来自公开 [TSDuck streams 仓库](https://tsduck.io/streams/) 的样本会下载到 `.cache/streams/`，且不会提交到版本库。下载器还会在 TSDuck 发布时一并抓取配套的 `.psi.txt` 和 `.analyze.json` 参考文件：

```bash
# ATSC、ISDB、DVB 和 ISDB-Tb 样本的前 8-16 MiB + TSDuck 参考输出
cmd /c "node tools/fetch-streams/fetch.mjs --head 16 atsc-473 isdb-nhk isdb-aab dvb-france-uhf33 italy-mux1rai"
cmd /c "node tools/fetch-streams/fetch.mjs --head 8 isdb-tb-204"

# DVB-MHP 对象轮播样本（Hot Bird 13E，TS 6000）
cmd /c "node tools/fetch-streams/fetch.mjs --head 24 hotbird-mhp"

corepack pnpm probe:atsc
corepack pnpm probe:isdb
corepack pnpm probe:dvb
corepack pnpm probe:brazil
corepack pnpm carousel:mhp

# 与 TSDuck 的 tspsi 输出比对 PAT/PMT/SDT/VCT 结构
corepack pnpm build
corepack pnpm compare:tsduck
```

使用 `--list` 查看目录，`--all` 下载全部样本，`--full` 进行完整下载。188、192（M2TS）、204（ISDB-Tb）和 208（RS）包布局会自动识别。

完整下载较慢时，常需要抓取文件中段的区间数据。以下命令通过 HTTP Range 抓取指定偏移附近 2 MiB：

```bash
# 含真实 Teletext 的荷兰 DVB-T2 复用流（偏移 30,000,000）
cmd /c "curl.exe -L --http1.1 --max-time 120 -r 30000000-32097151 -o .cache/streams/nl-mid.ts https://tsduck.io/streams/netherlands-dttv/digitenne-482-2020-06-21.ts"
corepack pnpm dev extract .cache/streams/nl-mid.ts --kind teletext -o .cache/extract-nl
```

该区间可产出可读的荷兰语 Teletext 页面，例如 `[1:01] Aanhouding na ongeluk in Fochteloo`、`[1:03] Op het Zuideinde in Fochteloo zijn in de nacht van zaterdag op zondag twee auto's tegen elkaar gebotst na een inhaalactie.` 和 `[5:02] RTV Drenthe is gestopt met teletext.`。解码器会反转传输的位序、对地址和页字节做 Hamming 8/4 解码，并将第 1-23 行保留为显示文本。

真实 SCTE-35 section 已使用 [scte35-injector](https://github.com/CMThF/scte35-injector) 项目的 CUEI 测试流验证：

```bash
cmd /c "curl.exe -L --http1.1 --max-time 900 -o .cache/streams/scte35-sample.ts https://raw.githubusercontent.com/CMThF/scte35-injector/main/test-assets/scte35_splice_inserts_with_auto_return.ts"
corepack pnpm dev scte35 .cache/streams/scte35-sample.ts
```

```text
PID 0x01C4 packet 20964: time_signal pts=4.400s seg=Break start segdur=20.000s
PID 0x01C4 packet 171922: splice_insert event=123 program=1 pts=35.933s duration=10.000s avail=0/0
PID 0x01C4 packet 327347: splice_insert event=123 program=1 pts=68.400s duration=10.000s avail=0/0
PID 0x01C4 packet 380645: time_signal pts=79.533s seg=Break start segdur=20.000s
```

这些结果与相同 section 的参考解码（threefive 3.x）一致，包括 SCTE-35 2019+ segmentation 描述符内的 `CUEI` 标识、自动返回的 break 时长以及 segmentation 类型/时长。此前采样的法国 DVB-T 复用流和英国 Freeview 区间不含有效的 `0xFC` section，因此以 CUEI 流作为真实样本参考。

## 输出

文本报告包含：

- 输入与包布局摘要、标准判定及置信度
- 传输流 ID、网络 ID/名称、NIT PID、PCR PID、时长和码率
- 服务及其 provider、服务类型、PMT/PCR PID 和基本流
- 基本流元数据：视频分辨率/帧率/profile/level，音频采样率/声道/码率
- 音频无障碍：DVB 补充音频、音频预选和 ISO 639 音频类型，以及 ATSC AC-3 `bsmod`，映射为音频描述、口述字幕和听障服务；DVB 字幕和 Teletext 描述符会标记听障字幕
- 字幕无障碍：DVB 字幕/Teletext 类型、ATSC CEA-608/708 字幕服务条目、易读和宽画幅标记
- 服务统计：包数、码率和 bitrate-204、PID 列表、明文/加扰分量计数、TSID/ONID、隐藏/SSU/T2-MI 标记
- 时间范围：来自 TDT/TOT/STT 的 UTC 和本地首/末时间戳、TOT 本地偏移和国家
- ISDB-Tb 扩展：国家、按服务的隐藏标记和按 PID 的 IIP 标记
- TSAnalyze 风格的详细流描述，例如 `MPEG-2 Video (1280x720p, @59.94 Hz, 16:9)` 和 `AC-3 audio (eng, AC-3, stereo, @48,000 Hz, complete main, bsid 8)`
- EPG 事件及其标题/文本、语言、DVB 内容类型和分级
- EPG 内容描述符解码为可读类型（例如 `movie/drama (general)`、`unclassified`），分级显示为国家代码 + 分级值
- ATSC 分级区域表（RRT，table_id `0xCA`），包含区域名称、各分级维度、缩写/完整分级值及描述符循环；RRT5 事件通过 ATSC content advisory 描述符解析
- 描述符摘要（语言、Teletext、字幕、ATSC 字幕服务、ISDB 标记等）
- 推断能力：Teletext、DVB/ATSC/ARIB 字幕、VBI、SCTE-35、加扰及 CA system ID
- 数据广播：MPE 数据报与 MPE-FEC、DSM-CC 对象轮播的数据块/模块、模块内 BIOP 对象与服务网关目录树，以及 MHP/HbbTV 应用信令；`carousel` 命令和会话 API 可导出内容完整的文件
- 应急信息：SCTE-18 EAS 告警（事件码、优先级、剩余时间、区域）、ISDB EWBS 服务状态以及印尼 EWS 的 TRDW/TCDW/TMDW 表（等级、灾种、区域与文字信息）；三类告警都按 PCR 码流时间生成时间段（开始/结束或进行中）
- ISDB-Tb 204 字节尾部与 IIP PID，以及日文 ARIB 或巴西 SBTVD 文本
- PES 流索引（stream id 与 PTS 范围）；Teletext 页面、ARIB/ATSC 字幕文本/SRT、DVB 字幕段、VBI 单元和带 segmentation 描述符的 SCTE-35 事件
- 视频/音频参数：MPEG-2/H.264/H.265 分辨率、帧率、profile/level；AAC/MPEG audio/AC-3/E-AC-3 采样率、声道和码率；LATM StreamMuxConfig（含 HE-AAC 显式 SBR）
- 表清单，含版本、section、CRC 状态、出现次数和首包位置
- 使用 `tables --detail` 输出 BAT/RST/AIT/SIT 以及 NIT/SDT/PMT/EIT 和 ATSC MGT/VCT/STT/RRT 的解析摘要
- 按严重级别分组的校验输出，使用稳定代码，例如 `TS_SYNC_LOSS`、`PSI_CRC_MISMATCH`、`TS_CC_DISCONTINUITY`、`PMT_MISSING`；重复包会以 info 级 `TS_DUPLICATE_PACKET` 单独统计

JSON 输出具有稳定结构（`schemaVersion: "1.0"`），面向自动化和 Web UI。HTML 输出是单个自包含文件，内嵌同样的 JSON。

## 开发

```bash
corepack pnpm test          # Vitest：CRC、布局、section、表、ARIB/SBTVD、Teletext、模糊测试与资源上限
corepack pnpm test:e2e      # Playwright：加载流、页签、筛选、校验、语言切换、hash 恢复
corepack pnpm typecheck     # 全仓库严格 TypeScript 检查
corepack pnpm build         # core 声明文件 + Web 打包 + 打包版 CLI
corepack pnpm build:exe     # Windows 单文件 dist/tsinspect.exe（Node SEA）
corepack pnpm bench <file>  # 探测耗时、包速率和峰值 RSS；--repeat N 用于压测内存
```

### 目录结构

```
apps/cli/                 Commander CLI、源加载、文本/JSON/HTML 格式化
apps/server/              Fastify 会话 API 与静态 Web 控制台托管
apps/web/                 React 19 + Vite 浏览器控制台
packages/core/            纯 TypeScript 解析与分析核心
  src/ts/                 包解析、布局检测、重同步扫描
  src/section/            Section 重组与 CRC-32/MPEG-2
  src/tables/             PAT、PMT、SDT、NIT、EIT、TDT/TOT、DVB 扩展表、ATSC PSIP、ISDB
  src/pes/                PES 重组、头/PTS 解析、流索引
  src/es/                 视频/音频参数、Teletext、字幕、VBI 和 SCTE-35
  src/data/               MPE/MPE-FEC、DSM-CC 模块装配、BIOP 解析与对象轮播目录树
  src/descriptors/        描述符解析、DVB/ATSC/ARIB 字符串解码
  src/analyze/            探测编排、能力与标准判定
  src/model/              稳定 JSON 模型类型
tests/                    合成传输流与测试样本
tests/e2e/                Playwright 浏览器流程测试
tools/fetch-streams/      TSDuck 样本与参考输出下载器
tools/compare-tsduck.mjs  与 TSDuck tspsi 比对 PAT/PMT/SDT/VCT
tools/benchmark.ts        大流耗时/RSS 基准测试
tools/build-cli.mjs       打包 ESM CLI 构建
tools/build-exe.mjs       Windows 单文件可执行文件构建（Node SEA + postject）
```

核心不依赖 Node.js，直接操作 `Uint8Array`，因此可在 Node、浏览器或 Web Worker 中运行。为防止恶意或异常大的流导致资源失控，探测过程将表索引限制为 8192 条、EPG 事件限制为 20,000 条、ATSC ETT 文本限制为 20,000 条、基本流元数据缓冲限制为 64 MiB、每个对象轮播的模块缓冲与导出内容各限制为 32 MiB；达到上限时会添加警告诊断，而不是无限增长。

## 范围与非目标

**范围内：** DVB、ATSC 1.0 和 ISDB-T/Tb；188/192/204/208 字节包；PSI/SI 与 PSIP 表；服务与 PID 清单；EPG；Teletext/字幕检测与提取；数据广播（含 DSM-CC 对象轮播目录树与文件导出）与应急信息索引；本地文件和静态 HTTP(S)。

**暂缓：** 实时 UDP/RTP 和长连接 HTTP 源、ATSC 3.0、MHP/HbbTV 应用执行、DSM-CC object carousel 的应用级对象持久化与多轮播自动挂载（跨轮播 LiteOptions 引用只做标记，不自动跟随）、DRM/CA 解密、Docker/桌面打包。

## 参考资料

- [DVB Inspector](https://sourceforge.net/projects/dvbinspector/) — 仅用于行为与 UI 参考；其为 GPL 授权，因此未复制任何代码。
- [TSDuck](https://tsduck.io/) — 测试流与参考 `analyze` 输出。
- ISO/IEC 13818-1、ISO/IEC 13818-6（DSM-CC）、ETSI TS 102 812（MHP 对象轮播）、ETSI EN 300 468、ATSC A/65、ARIB STD-B24/B10。
