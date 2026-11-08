/**
 * DVB data broadcast parsing: MPE / MPE-FEC datagrams, DSM-CC object
 * carousels and MHP/HbbTV application signalling (AIT).
 *
 * Section formats follow ETSI EN 301 192 and ISO/IEC 13818-6. The parser is
 * deliberately tolerant: unknown extensions are counted and summarised rather
 * than rejected, because private data PIDs often mix several data flavours.
 */

import type {
  ProbeBroadcastApplication,
  ProbeDataBroadcast,
  ProbeDsmccCarousel,
  ProbeMpeFec,
  ProbeMpeSession,
} from '../model/types.js';
import type { AitSection } from '../tables/dvb-extra.js';
import { readU16, readU32 } from '../util/bytes.js';

export const MPE_DATAGRAM_TABLE = 0x3e;
export const MPE_FEC_TABLE = 0x78;
export const DSMCC_DOWNLOAD_TABLE = 0x3b;
export const DSMCC_DDB_TABLE = 0x3c;

const APPLICATION_TYPE_NAMES: Record<number, string> = {
  0x0001: 'DVB-J',
  0x0002: 'DVB-HTML',
  0x0003: 'DVB-J (MHP 1.1)',
  0x0010: 'HbbTV',
  0x0011: 'HbbTV (1.5+)',
};

function applicationTypeName(type: number): string {
  return APPLICATION_TYPE_NAMES[type] ?? `0x${type.toString(16).padStart(4, '0')}`;
}

function macText(data: Uint8Array, offset: number): string {
  const parts: string[] = [];
  for (let index = 0; index < 6; index += 1) {
    parts.push((data[offset + index] ?? 0).toString(16).padStart(2, '0'));
  }
  return parts.join(':');
}

function ipv4Text(data: Uint8Array, offset: number): string {
  return `${data[offset] ?? 0}.${data[offset + 1] ?? 0}.${data[offset + 2] ?? 0}.${
    data[offset + 3] ?? 0
  }`;
}

function isMulticast(address: string): boolean {
  const first = Number(address.split('.')[0]);
  return Number.isFinite(first) && first >= 224 && first <= 239;
}

function readDescriptorBytes(raw: string): Uint8Array {
  const hex = raw.replace(/\s+/g, '');
  const bytes = new Uint8Array(Math.floor(hex.length / 2));
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function descriptorText(raw: string): string {
  const bytes = readDescriptorBytes(raw);
  let text = '';
  for (const value of bytes) {
    if (value >= 0x20 && value <= 0x7e) text += String.fromCharCode(value);
    else if (value === 0) break;
    else text += ' ';
  }
  return text.trim();
}

function applicationUrls(ait: AitSection): string[] {
  const urls = new Set<string>();
  for (const application of ait.applications) {
    for (const descriptor of application.descriptors) {
      if (descriptor.tag !== 0x02 && descriptor.tag !== 0x04 && descriptor.tag !== 0x05) {
        continue;
      }
      const text = descriptorText(descriptor.raw);
      const match = text.match(/https?:\/\/[^\s"'<>]+/i);
      if (match) urls.add(match[0]);
    }
  }
  return [...urls];
}

function applicationName(ait: AitSection, index: number): string | undefined {
  const application = ait.applications[index];
  if (!application) return undefined;
  const nameDescriptor = application.descriptors.find((descriptor) => descriptor.tag === 0x01);
  if (!nameDescriptor) return undefined;
  const text = descriptorText(nameDescriptor.raw);
  return text.length > 0 ? text : undefined;
}

function biopKind(kind: string): 'file' | 'directory' | 'service-gateway' | 'unknown' {
  if (kind === 'fil') return 'file';
  if (kind === 'dir') return 'directory';
  if (kind === 'srg') return 'service-gateway';
  return 'unknown';
}

interface BiopMessage {
  kind: 'file' | 'directory' | 'service-gateway' | 'unknown';
  name?: string;
  size?: number;
}

/** Parse the BIOP messages carried inside a DSM-CC DownloadDataBlock. */
function parseBiopMessages(payload: Uint8Array): BiopMessage[] {
  const messages: BiopMessage[] = [];
  let cursor = 0;
  while (cursor + 11 <= payload.length && messages.length < 64) {
    if (
      payload[cursor] !== 0x42 ||
      payload[cursor + 1] !== 0x49 ||
      payload[cursor + 2] !== 0x4f ||
      payload[cursor + 3] !== 0x50
    ) {
      cursor += 1;
      continue;
    }
    const messageSize = readU32(payload, cursor + 6);
    const kindLength = payload[cursor + 10] as number;
    if (kindLength === 0 || cursor + 11 + kindLength > payload.length) break;
    const kind = String.fromCharCode(
      ...payload.subarray(cursor + 11, cursor + 11 + kindLength),
    );
    let position = cursor + 11 + kindLength;
    if (position >= payload.length) break;
    const keyLength = payload[position] as number;
    position += 1;
    const objectKey =
      keyLength > 0 && position + keyLength <= payload.length
        ? payload.subarray(position, position + keyLength)
        : undefined;
    position += keyLength;
    const entry: BiopMessage = { kind: biopKind(kind) };
    if (position + 4 <= payload.length) {
      const infoLength = readU32(payload, position);
      const infoStart = position + 4;
      const infoEnd = Math.min(payload.length, infoStart + infoLength);
      if (entry.kind === 'file' && infoEnd >= infoStart + 8) {
        // FileInfo: contentLength is the first 32-bit field in the body.
        entry.size = readU32(payload, infoStart);
      }
      const keyText =
        objectKey && objectKey.every((value) => value >= 0x20 && value <= 0x7e)
          ? String.fromCharCode(...objectKey)
          : undefined;
      const infoText = descriptorText(
        Array.from(payload.subarray(infoStart, infoEnd))
          .map((value) => value.toString(16).padStart(2, '0'))
          .join(''),
      );
      const candidate = keyText ?? (infoText.length > 1 ? infoText : undefined);
      if (candidate) entry.name = candidate;
    }
    messages.push(entry);
    cursor += messageSize > 0 ? Math.max(messageSize, 11) : 11;
  }
  return messages;
}

interface CarouselState {
  pid: number;
  dsi: number;
  dii: number;
  ddb: number;
  transactions: Set<number>;
  modules: ProbeDsmccCarousel['modules'];
  objects: ProbeDsmccCarousel['objects'];
  gateways: Set<string>;
}

export interface DataSectionSummary {
  fields: Record<string, string | number | boolean>;
}

export class DataBroadcastAccumulator {
  private readonly mpe = new Map<string, ProbeMpeSession>();
  private readonly fec = new Map<number, ProbeMpeFec>();
  private readonly carousels = new Map<number, CarouselState>();
  private readonly applications: ProbeBroadcastApplication[] = [];
  private readonly applicationKeys = new Set<string>();
  private readonly applicationTypes = new Set<number>();
  private sawMhp = false;
  private sawHbbtv = false;

  /** Parse one section from a data PID; returns table field summaries. */
  pushSection(pid: number, data: Uint8Array): DataSectionSummary | null {
    const tableId = data[0] as number;
    if (tableId === MPE_DATAGRAM_TABLE) return this.pushMpe(pid, data);
    if (tableId === MPE_FEC_TABLE) return this.pushMpeFec(pid, data);
    if (tableId === DSMCC_DOWNLOAD_TABLE || tableId === DSMCC_DDB_TABLE) {
      return this.pushDsmcc(pid, data);
    }
    return null;
  }

  addAit(pid: number, ait: AitSection): void {
    const typeName = applicationTypeName(ait.applicationType);
    if (ait.applicationType === 0x0001 || ait.applicationType === 0x0002 || ait.applicationType === 0x0003) {
      this.sawMhp = true;
    }
    if (ait.applicationType === 0x0010 || ait.applicationType === 0x0011) {
      this.sawHbbtv = true;
    }
    this.applicationTypes.add(ait.applicationType);
    const urls = applicationUrls(ait);
    for (const [index, application] of ait.applications.entries()) {
      const key = `${pid}:${ait.applicationType}:${application.organizationId}:${application.applicationId}`;
      if (this.applicationKeys.has(key)) continue;
      this.applicationKeys.add(key);
      const name = applicationName(ait, index);
      this.applications.push({
        pid,
        applicationType: ait.applicationType,
        applicationTypeName: typeName,
        organizationId: application.organizationId,
        applicationId: application.applicationId,
        controlCode: application.controlCode,
        ...(name !== undefined ? { name } : {}),
        ...(urls.length > 0 ? { urls } : {}),
        ...(ait.version !== undefined ? { version: ait.version } : {}),
      });
    }
  }

  /** True when at least one supported data-broadcast element was seen. */
  get active(): boolean {
    return (
      this.mpe.size > 0 ||
      this.fec.size > 0 ||
      this.carousels.size > 0 ||
      this.applications.length > 0 ||
      this.applicationTypes.size > 0
    );
  }

  finish(): ProbeDataBroadcast | undefined {
    if (!this.active) return undefined;
    const fec = [...this.fec.values()].map((entry) => ({
      pid: entry.pid,
      frames: entry.frames,
      sections: entry.sections,
      paddingColumns: entry.paddingColumns,
      payloadBytes: entry.payloadBytes,
    }));
    const carousels = [...this.carousels.values()].map((state) => ({
      pid: state.pid,
      serverInitiates: state.dsi,
      downloadInfos: state.dii,
      dataBlocks: state.ddb,
      transactions: [...state.transactions].sort((a, b) => a - b),
      modules: state.modules,
      objects: state.objects,
      gateways: [...state.gateways],
    }));
    return {
      mpe: [...this.mpe.values()],
      mpeFec: fec,
      carousels,
      applications: this.applications,
      mhp: this.sawMhp,
      hbbtv: this.sawHbbtv,
    };
  }

  private pushMpe(pid: number, data: Uint8Array): DataSectionSummary | null {
    if (data.length < 16) return null;
    // section_syntax_indicator and current_next_indicator must be set; random
    // private sections on data PIDs frequently reuse table id 0x3E.
    if (((data[1] as number) & 0x80) === 0) return null;
    if (((data[9] as number) & 0x01) === 0) return null;
    const sectionLength = (((data[1] as number) & 0x0f) << 8) | (data[2] as number);
    if (3 + sectionLength > data.length) return null;
    const totalEnd = 3 + sectionLength;
    const macAddress = macText(data, 3);
    const flags = data[9] as number;
    const sectionNumber = data[10] as number;
    const lastSectionNumber = data[11] as number;
    const llcSnap = (flags & 0x02) !== 0;
    let payloadStart = 12;
    let snapStart = -1;
    if (llcSnap) {
      snapStart = payloadStart;
      payloadStart += 8;
    } else if (sectionNumber === 0) {
      payloadStart += 8;
    }
    const payloadEnd = Math.max(payloadStart, totalEnd - 4);
    const key = `${pid}:${macAddress}`;
    let session = this.mpe.get(key);
    if (!session) {
      session = {
        pid,
        macAddress,
        firstSection: sectionNumber,
        lastSection: lastSectionNumber,
        llcSnap,
        payloadScrambling: (flags >> 4) & 0x03,
        addressScrambling: (flags >> 2) & 0x03,
        datagrams: 0,
        payloadBytes: 0,
      };
      this.mpe.set(key, session);
    }
    session.firstSection = Math.min(session.firstSection, sectionNumber);
    session.lastSection = Math.max(session.lastSection, lastSectionNumber);
    session.llcSnap = session.llcSnap || llcSnap;
    session.datagrams += 1;
    session.payloadBytes += Math.max(0, payloadEnd - payloadStart);
    if (
      snapStart >= 0 &&
      snapStart + 8 <= payloadEnd &&
      data[snapStart] === 0xaa &&
      data[snapStart + 1] === 0xaa
    ) {
      const etherType = readU16(data, snapStart + 6);
      if (etherType === 0x0800 && payloadStart + 20 <= payloadEnd) {
        const ip = payloadStart;
        const source = ipv4Text(data, ip + 12);
        const destination = ipv4Text(data, ip + 16);
        session.ipv4 = {
          source,
          destination,
          protocol: data[ip + 9] as number,
          multicast: isMulticast(destination),
        };
      }
    }
    return {
      fields: {
        macAddress,
        section: sectionNumber,
        lastSection: lastSectionNumber,
        llcSnap,
        ...(session.ipv4
          ? {
              source: session.ipv4.source,
              destination: session.ipv4.destination,
              multicast: session.ipv4.multicast,
            }
          : {}),
      },
    };
  }

  private pushMpeFec(pid: number, data: Uint8Array): DataSectionSummary | null {
    if (data.length < 8) return null;
    const sectionLength = (((data[1] as number) & 0x0f) << 8) | (data[2] as number);
    // MPE-FEC sections are full 191-byte payloads; shorter sections carrying
    // table id 0x78 are unrelated private data.
    if (((data[1] as number) & 0x40) === 0) return null;
    if (sectionLength < 191 || sectionLength > 4093) return null;
    if (3 + sectionLength !== data.length) return null;
    const paddingColumns = data[3] as number;
    if (paddingColumns > 191) return null;
    let entry = this.fec.get(pid);
    if (!entry) {
      entry = {
        pid,
        frames: 0,
        sections: 0,
        paddingColumns,
        payloadBytes: 0,
      };
      this.fec.set(pid, entry);
    }
    entry.frames += 1;
    if (sectionLength >= 191) entry.sections += 1;
    entry.paddingColumns = Math.max(entry.paddingColumns, paddingColumns);
    entry.payloadBytes += Math.max(0, sectionLength - 4);
    return {
      fields: {
        paddingColumns,
        sectionLength,
        payloadBytes: entry.payloadBytes,
      },
    };
  }

  private carousel(pid: number): CarouselState {
    let state = this.carousels.get(pid);
    if (!state) {
      state = {
        pid,
        dsi: 0,
        dii: 0,
        ddb: 0,
        transactions: new Set<number>(),
        modules: [],
        objects: [],
        gateways: new Set<string>(),
      };
      this.carousels.set(pid, state);
    }
    return state;
  }

  private pushDsmcc(pid: number, data: Uint8Array): DataSectionSummary | null {
    if (data.length < 20) return null;
    // DSM-CC DownloadDataMessage / DownloadDataBlock share the long section
    // header followed by the dsmccMessageHeader (ISO/IEC 13818-6, 7.2).
    if (((data[1] as number) & 0x80) === 0) return null;
    if (((data[5] as number) & 0x01) === 0) return null;
    if (data[8] !== 0x11 || data[9] !== 0x03) return null;
    const tableId = data[0] as number;
    const messageId = readU16(data, 10);
    const transactionId = readU32(data, 12);
    const adaptationLength = data[17] as number;
    const messageLength = readU16(data, 18);
    const bodyStart = 20 + adaptationLength;
    const bodyEnd = Math.min(data.length - 4, bodyStart + messageLength);
    const state = this.carousel(pid);
    state.transactions.add(transactionId);

    if (tableId === DSMCC_DOWNLOAD_TABLE) {
      if (messageId === 0x1001) {
        state.dsi += 1;
        // DSI: serverId then a BIOP service gateway object.
        if (bodyStart + 4 < bodyEnd) {
          for (const message of parseBiopMessages(data.subarray(bodyStart + 4, bodyEnd))) {
            if (message.kind === 'service-gateway' && message.name) {
              state.gateways.add(message.name);
            }
          }
        }
      } else if (messageId === 0x1002) {
        state.dii += 1;
        if (bodyStart + 18 <= bodyEnd) {
          const downloadId = readU32(data, bodyStart);
          state.transactions.add(downloadId);
          const moduleCount = readU16(data, bodyStart + 16);
          let cursor = bodyStart + 18;
          for (let index = 0; index < moduleCount && cursor + 8 <= bodyEnd; index += 1) {
            const moduleId = readU16(data, cursor);
            const moduleSize = readU32(data, cursor + 2);
            const version = data[cursor + 6] as number;
            const infoLength = data[cursor + 7] as number;
            state.modules.push({ id: moduleId, size: moduleSize, version });
            cursor += 8 + infoLength;
          }
        }
      }
      return {
        fields: {
          messageId: `0x${messageId.toString(16).toUpperCase()}`,
          transactionId,
          modules: state.modules.length,
        },
      };
    }

    // DownloadDataBlock: moduleId, moduleVersion, reserved, blockNumber, data.
    const moduleId = readU16(data, bodyStart);
    const blockNumber = readU16(data, bodyStart + 4);
    state.ddb += 1;
    const blockDataStart = bodyStart + 6;
    if (bodyEnd > blockDataStart) {
      for (const message of parseBiopMessages(data.subarray(blockDataStart, bodyEnd))) {
        if (message.kind === 'service-gateway') {
          if (message.name) state.gateways.add(message.name);
          continue;
        }
        const entry = {
          name: message.name ?? `block ${blockNumber}`,
          kind: message.kind,
          ...(message.size !== undefined ? { size: message.size } : {}),
        };
        if (!state.objects.some((object) => object.name === entry.name && object.kind === entry.kind)) {
          if (state.objects.length < 200) state.objects.push(entry);
        }
      }
    }
    return {
      fields: {
        transactionId,
        moduleId,
        blockNumber,
        objects: state.objects.length,
      },
    };
  }
}
