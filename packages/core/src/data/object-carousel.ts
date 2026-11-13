/**
 * DVB object carousel reconstruction (DSM-CC / BIOP).
 *
 * A carousel is spread over three DSM-CC messages: the DownloadServerInitiate
 * (DSI) references the service gateway object, the DownloadInfoIndication
 * (DII) announces modules and block sizes, and DownloadDataBlocks (DDB) carry
 * the module payload. This module assembles the modules, parses the BIOP
 * messages they contain and rebuilds the directory tree that starts at the
 * service gateway.
 */

import type { ProbeCarouselEntry, ProbeDsmccCarousel } from '../model/types.js';
import { readU16, readU32 } from '../util/bytes.js';
import {
  type BiopBinding,
  type BiopIor,
  type BiopKind,
  type BiopMessage,
  type BiopTap,
  parseBiopMessage,
  parseIor,
} from './biop.js';

export interface DataSectionSummary {
  fields: Record<string, string | number | boolean>;
}

export interface CarouselOptions {
  /** Decompress a module transmitted with the compressed_module_descriptor. */
  inflate?: (data: Uint8Array) => Uint8Array;
  /** Maximum bytes buffered for the modules of one carousel. */
  maxModuleBytes?: number;
  /** Maximum bytes kept for reconstructed file content of one carousel. */
  maxContentBytes?: number;
  /** Maximum directory entries reported per carousel. */
  maxEntries?: number;
}

const DEFAULT_MAX_MODULE_BYTES = 32 * 1024 * 1024;
const DEFAULT_MAX_CONTENT_BYTES = 32 * 1024 * 1024;
const DEFAULT_MAX_ENTRIES = 4096;
const MAX_DEPTH = 32;

interface ModuleState {
  id: number;
  version: number;
  /** Size of the transmitted module payload (DII module_size). */
  size: number;
  /** Decompressed size for compressed modules. */
  originalSize?: number;
  blockSize: number;
  compressed: boolean;
  blocks: Map<number, Uint8Array>;
  bytes: number;
  parsed: boolean;
  truncated: boolean;
}

interface CarouselObject {
  id: string;
  kind: BiopKind;
  key: string;
  keyHex: string;
  moduleId: number;
  carouselId: number;
  size?: number;
  contentType?: string;
  bindings?: BiopBinding[];
  taps?: BiopTap[];
  content?: Uint8Array;
}

interface CarouselFile {
  path: string;
  size?: number;
  contentType?: string;
  complete: boolean;
  data?: Uint8Array;
}

function moduleInfoFlags(
  data: Uint8Array,
  start: number,
  end: number,
): { compressed: boolean; originalSize?: number } {
  let cursor = start;
  // moduleTimeOut, blockTimeOut, minBlockTime (three 32-bit microsecond values).
  if (cursor + 12 > end) return { compressed: false };
  cursor += 12;
  if (cursor >= end) return { compressed: false };
  const tapCount = data[cursor] as number;
  cursor += 1;
  for (let index = 0; index < tapCount && cursor + 7 <= end; index += 1) {
    const selectorLength = data[cursor + 6] as number;
    cursor += 7 + selectorLength;
  }
  if (cursor >= end) return { compressed: false };
  const userInfoLength = data[cursor] as number;
  cursor += 1;
  const infoEnd = Math.min(end, cursor + userInfoLength);
  while (cursor + 2 <= infoEnd) {
    const tag = data[cursor] as number;
    const length = data[cursor + 1] as number;
    const payload = cursor + 2;
    if (payload + length > infoEnd) break;
    if (tag === 0x09 && length >= 4) {
      return { compressed: true, originalSize: readU32(data, payload) };
    }
    cursor = payload + length;
  }
  return { compressed: false };
}

export class ObjectCarouselState {
  readonly pid: number;
  private readonly options: Required<Omit<CarouselOptions, 'inflate'>> &
    Pick<CarouselOptions, 'inflate'>;
  private readonly modules = new Map<string, ModuleState>();
  private readonly announced = new Map<number, { id: number; size: number; version: number }>();
  private readonly objects = new Map<string, CarouselObject>();
  private readonly transactions = new Set<number>();
  private readonly downloadIds = new Set<number>();
  private gatewayKeys = new Set<string>();
  private rootIor: BiopIor | undefined;
  private lastDownloadId: number | undefined;
  private dsiCount = 0;
  private diiCount = 0;
  private ddbCount = 0;
  private bufferedBytes = 0;
  private contentBytes = 0;
  private cache: { report: ProbeDsmccCarousel; files: CarouselFile[] } | undefined;
  private limitHit = false;

  constructor(pid: number, options: CarouselOptions = {}) {
    this.pid = pid;
    this.options = {
      inflate: options.inflate,
      maxModuleBytes: options.maxModuleBytes ?? DEFAULT_MAX_MODULE_BYTES,
      maxContentBytes: options.maxContentBytes ?? DEFAULT_MAX_CONTENT_BYTES,
      maxEntries: options.maxEntries ?? DEFAULT_MAX_ENTRIES,
    };
  }

  /** Feed one complete section (0x3B or 0x3C). */
  pushSection(section: Uint8Array): DataSectionSummary | null {
    if (section.length < 20) return null;
    if (((section[1] as number) & 0x80) === 0) return null;
    if (((section[5] as number) & 0x01) === 0) return null;
    if (section[8] !== 0x11 || section[9] !== 0x03) return null;

    const tableId = section[0] as number;
    const sectionLength = (((section[1] as number) & 0x0f) << 8) | (section[2] as number);
    if (3 + sectionLength > section.length) return null;

    const messageId = readU16(section, 10);
    const transactionId = readU32(section, 12);
    const adaptationLength = section[17] as number;
    const messageLength = readU16(section, 18);
    const bodyStart = 20 + adaptationLength;
    const bodyEnd = Math.min(3 + sectionLength - 4, bodyStart + messageLength);
    if (bodyStart >= bodyEnd) return null;
    this.transactions.add(transactionId);
    this.cache = undefined;

    if (tableId === 0x3c) {
      this.ddbCount += 1;
      return this.pushDataBlock(section, bodyStart, bodyEnd, transactionId);
    }

    if (messageId === 0x1002) {
      this.diiCount += 1;
      return this.pushDownloadInfo(section, bodyStart, bodyEnd, transactionId);
    }
    if (messageId !== 0x1001 && messageId !== 0x1006) return null;

    // DownloadServerInitiate. ISO/IEC 13818-6 assigns 0x1001; some
    // broadcasters use 0x1006 for the same message body.
    this.dsiCount += 1;
    this.pushServerInitiate(section, bodyStart, bodyEnd);
    return {
      fields: {
        messageId: `0x${messageId.toString(16).toUpperCase()}`,
        transactionId,
        gateways: this.gatewayKeys.size,
      },
    };
  }

  private pushServerInitiate(data: Uint8Array, bodyStart: number, bodyEnd: number): void {
    // ServiceGatewayInfo is the IOR to the gateway; it is preceded by the
    // 20-byte serverId and a 32-bit privateDataLength in practice. Try the
    // common offsets and accept the first plausible IOR.
    const candidates = [bodyStart, bodyStart + 20, bodyStart + 24, bodyStart + 22];
    for (const offset of candidates) {
      if (offset + 8 > bodyEnd) continue;
      const ior = parseIor(data, offset, bodyEnd);
      if (!ior) continue;
      if (this.rootIor === undefined || ior.typeId === 'srg') {
        this.rootIor = ior;
        if (ior.typeId === 'srg') return;
      }
    }
  }

  private pushDownloadInfo(
    data: Uint8Array,
    bodyStart: number,
    bodyEnd: number,
    transactionId: number,
  ): DataSectionSummary | null {
    if (bodyStart + 20 > bodyEnd) return null;
    const downloadId = readU32(data, bodyStart);
    const blockSize = readU16(data, bodyStart + 4);
    // compatibilityDescriptorLength (0 for object carousels) precedes the count.
    const moduleCount = readU16(data, bodyStart + 18);
    this.downloadIds.add(downloadId);
    this.lastDownloadId = downloadId;

    let cursor = bodyStart + 20;
    for (let index = 0; index < moduleCount && cursor + 8 <= bodyEnd; index += 1) {
      const id = readU16(data, cursor);
      const size = readU32(data, cursor + 2);
      const version = data[cursor + 6] as number;
      const infoLength = data[cursor + 7] as number;
      const infoStart = cursor + 8;
      const infoEnd = Math.min(bodyEnd, infoStart + infoLength);
      const flags = moduleInfoFlags(data, infoStart, infoEnd);
      this.announced.set(id, { id, size, version });

      const key = `${id}:${version}`;
      let module = this.modules.get(key);
      if (!module) {
        module = {
          id,
          version,
          size,
          ...(flags.originalSize !== undefined ? { originalSize: flags.originalSize } : {}),
          blockSize,
          compressed: flags.compressed,
          blocks: new Map(),
          bytes: 0,
          parsed: false,
          truncated: false,
        };
        this.modules.set(key, module);
      } else {
        module.size = size > 0 ? size : module.size;
        module.blockSize = blockSize;
        module.compressed = module.compressed || flags.compressed;
        if (flags.originalSize !== undefined) module.originalSize = flags.originalSize;
      }
      cursor = infoStart + infoLength;
      if (!module.parsed && module.size > 0) this.tryAssemble(module);
    }

    return {
      fields: {
        messageId: '0x1002',
        transactionId,
        downloadId,
        modules: this.announced.size,
        blockSize,
      },
    };
  }

  private pushDataBlock(
    data: Uint8Array,
    bodyStart: number,
    bodyEnd: number,
    transactionId: number,
  ): DataSectionSummary | null {
    if (bodyStart + 6 > bodyEnd) return null;
    const moduleId = readU16(data, bodyStart);
    const version = data[bodyStart + 2] as number;
    const blockNumber = readU16(data, bodyStart + 4);
    const payload = data.subarray(bodyStart + 6, bodyEnd);

    const key = `${moduleId}:${version}`;
    let module = this.modules.get(key);
    if (!module) {
      const announced = this.announced.get(moduleId);
      module = {
        id: moduleId,
        version,
        size: announced && announced.version === version ? announced.size : 0,
        blockSize: 0,
        compressed: false,
        blocks: new Map(),
        bytes: 0,
        parsed: false,
        truncated: false,
      };
      this.modules.set(key, module);
    }

    const summary: DataSectionSummary = {
      fields: {
        transactionId,
        moduleId,
        blockNumber,
        objects: this.objects.size,
      },
    };

    if (module.parsed || module.blocks.has(blockNumber)) return summary;
    if (module.truncated) return summary;
    if (module.size > 0 && module.bytes + payload.length > module.size) {
      // A block longer than the announced module means the announcement is
      // stale; keep what fits and stop buffering this module.
      module.truncated = true;
      return summary;
    }
    if (
      module.bytes + payload.length > this.options.maxModuleBytes ||
      this.bufferedBytes + payload.length > this.options.maxModuleBytes
    ) {
      module.truncated = true;
      this.limitHit = true;
      return summary;
    }

    const copy = new Uint8Array(payload.length);
    copy.set(payload);
    module.blocks.set(blockNumber, copy);
    module.bytes += copy.length;
    this.bufferedBytes += copy.length;
    this.tryAssemble(module);
    summary.fields.objects = this.objects.size;
    return summary;
  }

  private tryAssemble(module: ModuleState): void {
    if (module.parsed || module.size <= 0 || module.bytes < module.size) return;
    const assembled = new Uint8Array(module.size);
    let copied = 0;
    const blockSize = module.blockSize > 0 ? module.blockSize : undefined;
    const numbers = [...module.blocks.keys()].sort((a, b) => a - b);
    for (const number of numbers) {
      const block = module.blocks.get(number) as Uint8Array;
      const offset = blockSize !== undefined ? number * blockSize : copied;
      if (offset >= assembled.length) continue;
      const take = Math.min(block.length, assembled.length - offset);
      assembled.set(block.subarray(0, take), offset);
      copied += take;
    }
    this.releaseModule(module);

    let payload: Uint8Array = assembled;
    if (module.compressed) {
      if (!this.options.inflate) {
        module.truncated = true;
        return;
      }
      try {
        payload = this.options.inflate(assembled);
      } catch {
        module.truncated = true;
        return;
      }
    }

    module.parsed = true;
    this.parseModule(module, payload);
  }

  private releaseModule(module: ModuleState): void {
    for (const block of module.blocks.values()) this.bufferedBytes -= block.length;
    module.blocks.clear();
  }

  private parseModule(module: ModuleState, payload: Uint8Array): void {
    let cursor = 0;
    while (cursor + 12 <= payload.length) {
      const message = parseBiopMessage(payload, cursor, payload.length);
      if (!message) break;
      cursor += message.length;
      this.registerObject(module, message);
      if (message.length <= 0) break;
    }
  }

  private registerObject(module: ModuleState, message: BiopMessage): void {
    if (message.kind === 'unknown') return;
    const carouselId = this.currentCarouselId();
    const id = `${carouselId}:${module.id}:${message.objectKeyHex}`;
    if (this.objects.has(id)) return;

    const entry: CarouselObject = {
      id,
      kind: message.kind,
      key: message.objectKey,
      keyHex: message.objectKeyHex,
      moduleId: module.id,
      carouselId,
      ...(message.contentSize !== undefined ? { size: message.contentSize } : {}),
      ...(message.contentType !== undefined ? { contentType: message.contentType } : {}),
      ...(message.bindings !== undefined ? { bindings: message.bindings } : {}),
      ...(message.taps !== undefined ? { taps: message.taps } : {}),
    };

    if (message.kind === 'file' && message.content !== undefined) {
      if (this.contentBytes + message.content.length <= this.options.maxContentBytes) {
        entry.content = message.content;
        this.contentBytes += message.content.length;
      } else {
        this.limitHit = true;
      }
    }
    if (message.kind === 'service-gateway') {
      this.gatewayKeys.add(message.objectKey || message.objectKeyHex || 'gateway');
    }
    if (entry.size === undefined && message.content !== undefined) {
      entry.size = message.content.length;
    }
    this.objects.set(id, entry);
  }

  private currentCarouselId(): number {
    return this.lastDownloadId ?? 0;
  }

  private resolve(ior: BiopIor | undefined): CarouselObject | undefined {
    if (!ior) return undefined;
    for (const profile of ior.profiles) {
      const location = profile.location;
      if (!location) continue;
      const ids = [...this.downloadIds];
      for (const carouselId of ids) {
        const hit = this.objects.get(`${carouselId}:${location.moduleId}:${location.objectKeyHex}`);
        if (hit) return hit;
      }
      const hit = this.objects.get(`0:${location.moduleId}:${location.objectKeyHex}`);
      if (hit) return hit;
      // Fall back to a unique module/key match when the carousel id was not
      // announced (or differs between the DSI and DII).
      const matches = [...this.objects.values()].filter(
        (object) =>
          object.moduleId === location.moduleId && object.keyHex === location.objectKeyHex,
      );
      if (matches.length === 1) return matches[0];
    }
    return undefined;
  }

  private rootObject(): CarouselObject | undefined {
    const gateway = this.resolve(this.rootIor);
    if (gateway?.kind === 'service-gateway') {
      const binding = gateway.bindings?.[0];
      const root = this.resolve(binding?.ior);
      if (root) return root;
    } else if (gateway?.kind === 'directory') {
      return gateway;
    }

    for (const object of this.objects.values()) {
      if (object.kind !== 'service-gateway') continue;
      const root = this.resolve(object.bindings?.[0]?.ior);
      if (root) return root;
    }

    const referenced = new Set<string>();
    for (const object of this.objects.values()) {
      for (const binding of object.bindings ?? []) {
        const target = this.resolve(binding.ior);
        if (target) referenced.add(target.id);
      }
    }
    for (const object of this.objects.values()) {
      if (object.kind === 'directory' && !referenced.has(object.id)) return object;
    }
    for (const object of this.objects.values()) {
      if (object.kind === 'directory') return object;
    }
    return undefined;
  }

  /** Build the report, caching it until more sections arrive. */
  private build(): { report: ProbeDsmccCarousel; files: CarouselFile[] } {
    if (this.cache) return this.cache;

    const files: CarouselFile[] = [];
    const entries: ProbeCarouselEntry[] = [];
    const visited = new Set<string>();
    let dangling = 0;
    let depthCut = 0;
    let entryLimitHit = false;

    const addEntry = (entry: ProbeCarouselEntry): void => {
      if (entries.length >= this.options.maxEntries) {
        entryLimitHit = true;
        return;
      }
      entries.push(entry);
    };

    const childPath = (parent: string, name: string): string => {
      const clean = name.replace(/[\u0000-\u001f/\\]/g, '_').trim();
      const safe = clean.length > 0 && clean !== '.' && clean !== '..' ? clean : '_object';
      return parent === '/' ? `/${safe}` : `${parent}/${safe}`;
    };

    const walk = (object: CarouselObject, path: string, depth: number): void => {
      if (visited.has(object.id)) return;
      if (depth > MAX_DEPTH) {
        depthCut += 1;
        return;
      }
      visited.add(object.id);

      if (object.kind === 'directory' || object.kind === 'service-gateway') {
        addEntry({ path, kind: 'directory', complete: true });
        for (const binding of object.bindings ?? []) {
          const name = binding.name || binding.ior?.typeId || object.key;
          const targetPath = childPath(path, name);
          const target = this.resolve(binding.ior);
          if (!target) {
            dangling += 1;
            addEntry({
              path: targetPath,
              kind: binding.type === 1 ? 'file' : 'directory',
              complete: false,
              ...(binding.contentSize !== undefined ? { size: binding.contentSize } : {}),
              ...(binding.contentType !== undefined ? { contentType: binding.contentType } : {}),
            });
            continue;
          }
          walk(target, targetPath, depth + 1);
        }
        return;
      }

      if (object.kind === 'file') {
        addEntry({
          path,
          kind: 'file',
          complete: object.content !== undefined,
          ...(object.size !== undefined ? { size: object.size } : {}),
          ...(object.contentType !== undefined ? { contentType: object.contentType } : {}),
          moduleId: object.moduleId,
          ...(object.key.length > 0 ? { objectKey: object.key } : {}),
        });
        files.push({
          path,
          complete: object.content !== undefined,
          ...(object.size !== undefined ? { size: object.size } : {}),
          ...(object.contentType !== undefined ? { contentType: object.contentType } : {}),
          ...(object.content !== undefined ? { data: object.content } : {}),
        });
        return;
      }

      if (object.kind === 'stream') {
        const programs = (object.taps ?? [])
          .filter((tap) => tap.use === 0x0017 || tap.use === 0x0000)
          .map((tap) => tap.assocTag)
          .filter((value) => value > 0);
        addEntry({
          path,
          kind: 'stream',
          complete: true,
          ...(programs.length > 0 ? { programs } : {}),
        });
      }
    };

    const root = this.rootObject();
    let unreachable = 0;
    if (root) {
      walk(root, '/', 0);
      for (const object of this.objects.values()) {
        if (object.kind === 'service-gateway') continue;
        if (visited.has(object.id)) continue;
        if (object.kind === 'file' || object.kind === 'directory' || object.kind === 'stream') {
          unreachable += 1;
        }
      }
    } else {
      for (const object of this.objects.values()) {
        if (object.kind === 'unknown' || object.kind === 'service-gateway') continue;
        const suffix = object.key.length > 0 ? object.key : object.keyHex;
        const path = `/${object.moduleId}:${suffix}`;
        if (object.kind === 'directory') {
          addEntry({ path, kind: 'directory', complete: true });
        } else if (object.kind === 'file') {
          addEntry({
            path,
            kind: 'file',
            complete: object.content !== undefined,
            ...(object.size !== undefined ? { size: object.size } : {}),
            ...(object.contentType !== undefined ? { contentType: object.contentType } : {}),
            moduleId: object.moduleId,
            objectKey: object.key,
          });
          files.push({
            path,
            complete: object.content !== undefined,
            ...(object.size !== undefined ? { size: object.size } : {}),
            ...(object.content !== undefined ? { data: object.content } : {}),
          });
        } else if (object.kind === 'stream') {
          addEntry({ path, kind: 'stream', complete: true });
        }
      }
    }

    const modules = [...this.announced.values()]
      .sort((a, b) => a.id - b.id)
      .map((module) => ({ id: module.id, size: module.size, version: module.version }));

    let completeModules = 0;
    let pendingModules = 0;
    let compressedModules = 0;
    for (const announced of this.announced.values()) {
      const module = this.modules.get(`${announced.id}:${announced.version}`);
      if (!module) {
        if (announced.size > 0) pendingModules += 1;
        continue;
      }
      if (module.compressed) compressedModules += 1;
      if (module.parsed) completeModules += 1;
      else if (module.size > 0) pendingModules += 1;
    }

    // Keep the legacy flat object list for the existing UI and JSON consumers.
    const objects = entries
      .filter((entry) => entry.path !== '/')
      .slice(0, 200)
      .map((entry) => ({
        name: entry.path.replace(/^\//, ''),
        kind:
          entry.kind === 'file'
            ? ('file' as const)
            : entry.kind === 'directory'
              ? ('directory' as const)
              : ('unknown' as const),
        ...(entry.size !== undefined ? { size: entry.size } : {}),
      }));

    const report: ProbeDsmccCarousel = {
      pid: this.pid,
      serverInitiates: this.dsiCount,
      downloadInfos: this.diiCount,
      dataBlocks: this.ddbCount,
      transactions: [...this.transactions].sort((a, b) => a - b),
      modules,
      objects,
      gateways: [...this.gatewayKeys],
      ...(root !== undefined ? { root: '/' } : {}),
      entries,
      completeModules,
      pendingModules,
      compressedModules,
      danglingBindings: dangling,
      unreachableObjects: unreachable,
      ...(depthCut > 0 || this.limitHit || entryLimitHit ? { truncated: true } : {}),
    };

    this.cache = { report, files };
    return this.cache;
  }

  get report(): ProbeDsmccCarousel {
    return this.build().report;
  }

  /** Files with recovered content, for extraction commands and downloads. */
  collectFiles(): CarouselFile[] {
    return this.build().files;
  }
}
