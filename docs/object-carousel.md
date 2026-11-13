# DSM-CC 对象轮播目录树

`packages/core/src/data/` 下的 `biop.ts` 与 `object-carousel.ts` 实现 DVB 对象轮播（ISO/IEC 13818-6，ETSI TS 102 812 MHP Annex B.2.3）的模块装配与目录树重建；`databroadcast.ts` 负责把 DSM-CC section 接到状态机上，并提供独立的 `scanCarousels()` 扫描入口。

## 解析范围

| 结构 | 说明 |
| --- | --- |
| `DownloadServerInitiate`（0x3B，message id 0x1001/0x1006） | 20 字节 `serverId` + 32 位 `privateDataLength` + `ServiceGatewayInfo`，其中 IOR 指向服务网关对象。 |
| `DownloadInfoIndication`（0x3B，0x1002） | `downloadId`、`blockSize`、`compatibilityDescriptorLength`（对象轮播为 0）、模块表（id、大小、版本、`moduleInfo`）。 |
| `DownloadDataBlock`（0x3C，0x1003） | `moduleId`、`moduleVersion`、`blockNumber` 与块数据。 |
| BIOP 消息 | 12 字节头（`BIOP`、major/minor、byte order、message type、`message_size`）、`objectKey`、32 位长度的 `objectKind`、16 位 `objectInfo`、服务上下文列表、消息体。 |
| 对象类型 | `srg` 服务网关、`dir` 目录、`fil` 文件、`str` 流、`ste` 流事件。 |
| IOR | `type_id`（对象 kind 别名）、tagged profile；`TAG_BIOP`（0x49534F06）内是 `ObjectLocation`（carouselId、moduleId、对象 key）与 `ConnBinder` taps，`TAG_LITE_OPTIONS`（0x49534F05）解析跨轮播 ServiceLocation。 |
| 目录绑定 | `BIOP::Name`（id + kind）、binding type（1 = nobject，2 = ncontext）、对象 IOR、绑定 `objectInfo`（`ContentSize` 与 0x72 content type 描述符）。 |
| 文件消息 | `objectInfo` 的 `ContentSize`、`messageBodyLength`、`contentLength` 与文件内容。 |

模块的 `moduleInfo` 还会解析 `compressed_module_descriptor`（tag 0x09）：这是 zlib 压缩模块，模块大小按传输大小计算，解压后再解析。CLI、服务端 probe 与 `carousel` 命令通过 `CarouselOptions.inflate` / `ProbeOptions.inflate` 注入 `node:zlib`；纯核心调用未注入时只统计这类模块。

## 重建流程

1. 按 DII 的 `blockSize` 把 DDB 块放到 `blockNumber × blockSize` 偏移；累计字节数达到模块大小后拼装模块。
2. 依次解析模块内的 BIOP 消息（按 `message_size` 前进，支持一个模块多个对象），按 `carouselId:moduleId:objectKey` 登记对象。
3. 从 DSI 的 IOR 找到服务网关，再沿其唯一绑定找到根目录；找不到时退化为“未被任何绑定引用的第一个目录”。
4. 从根目录递归遍历绑定：目录追加 `entry`，文件记录大小/MIME/内容是否恢复，流对象记录引用节目号。
5. 无法解析的绑定计为 `danglingBindings`，目录可达但没有被引用的对象计为 `unreachableObjects`；循环引用按对象 id 去重，深度上限 32。

路径按组件清洗：去掉控制字符、把 `/`、`\` 替换为 `_`，`..`、`.` 与空名回退为 `_object`。CLI 导出时还会替换 Windows 非法字符，并允许多 PID 时按 `pid-xxxx/` 分目录。

## 资源上限

- 每个 carousel 的模块缓冲上限 32 MiB（`CarouselOptions.maxModuleBytes`），超出后停止缓冲并标记 `truncated`。
- 恢复的文件内容上限 32 MiB（`maxContentBytes`），超出后对应文件标记为不完整。
- 报告条目上限 4096（`maxEntries`）。
- 单个模块上限 32 MiB、BIOP 消息上限 32 MiB、绑定数量上限 4096。

## 对外接口

```ts
import { scanCarousels, ObjectCarouselState, parseBiopMessage } from '@tsinspect/core';

// 独立扫描：返回每个 PID 的报告和可导出的文件内容
const { carousels, files } = scanCarousels(buffer, {
  pids: new Set([0x1e9e]),
  inflate: (data) => new Uint8Array(inflateSync(data)), // 可选
});

// probe 内部使用同一个状态机，只保留元数据（不含文件内容）
```

CLI：`tsinspect carousel <source> [--pid ...] [--export dir] [-f text|json] [-o file]`。服务端：`GET /api/sessions/:id/carousel`（树与文件元数据）、`GET /api/sessions/:id/carousel/file?path=...&pid=...`（文件内容）。

## 已验证样本

Hot Bird 13E TS 6000（`.cache/streams/hotbird-mhp.head.ts`，TSDuck streams 仓库）的 PID 0x1E9E 上重建出根目录、`/poll` 子目录与 `a.class`…`g.class`、`configuration.txt` 的声明大小；捕获窗口内未收齐的模块会以 `incomplete` 呈现，扩大 `--bytes` 后即可导出完整文件。测试用合成轮播覆盖多块模块、跨目录绑定、缺失模块与内容导出（`tests/databroadcast.test.ts`、`tests/carousel-fixture.ts`）。
