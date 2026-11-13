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
import { SectionAssembler } from '../section/assembler.js';
import type { AitSection } from '../tables/dvb-extra.js';
import { detectPacketLayout, scanPackets } from '../ts/reader.js';
import { readU16 } from '../util/bytes.js';
import {
  type CarouselOptions,
  type DataSectionSummary,
  ObjectCarouselState,
} from './object-carousel.js';

export type { DataSectionSummary } from './object-carousel.js';

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

export class DataBroadcastAccumulator {
  private readonly mpe = new Map<string, ProbeMpeSession>();
  private readonly fec = new Map<number, ProbeMpeFec>();
  private readonly carousels = new Map<number, ObjectCarouselState>();
  private readonly applications: ProbeBroadcastApplication[] = [];
  private readonly applicationKeys = new Set<string>();
  private readonly applicationTypes = new Set<number>();
  private sawMhp = false;
  private sawHbbtv = false;

  constructor(private readonly carouselOptions: CarouselOptions = {}) {}

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
    if (
      ait.applicationType === 0x0001 ||
      ait.applicationType === 0x0002 ||
      ait.applicationType === 0x0003
    ) {
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
    const carousels = [...this.carousels.values()].map((state) => state.report);
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

  private pushDsmcc(pid: number, data: Uint8Array): DataSectionSummary | null {
    if (data.length < 20) return null;
    // DSM-CC DownloadDataMessage / DownloadDataBlock share the long section
    // header followed by the dsmccMessageHeader (ISO/IEC 13818-6, 7.2).
    if (((data[1] as number) & 0x80) === 0) return null;
    if (((data[5] as number) & 0x01) === 0) return null;
    if (data[8] !== 0x11 || data[9] !== 0x03) return null;
    if (readU16(data, 10) < 0x1001) return null;

    let state = this.carousels.get(pid);
    const created = state === undefined;
    if (!state) state = new ObjectCarouselState(pid, this.carouselOptions);
    const summary = state.pushSection(data);
    if (summary && created) this.carousels.set(pid, state);
    return summary;
  }
}

export interface CarouselScanOptions extends CarouselOptions {
  /** Restrict the scan to these PIDs. */
  pids?: Set<number>;
}

export interface ScannedCarouselFile {
  pid: number;
  path: string;
  size?: number;
  contentType?: string;
  complete: boolean;
  data?: Uint8Array;
}

export interface CarouselScanResult {
  carousels: ProbeDsmccCarousel[];
  files: ScannedCarouselFile[];
}

/**
 * Rebuild every DSM-CC object carousel in a buffer and return the file
 * contents as well. `probe` only reports metadata; extraction commands and the
 * session API use this to export objects.
 */
export function scanCarousels(
  data: Uint8Array,
  options: CarouselScanOptions = {},
): CarouselScanResult {
  const layout = detectPacketLayout(data);
  if (!layout) return { carousels: [], files: [] };

  const assemblers = new Map<number, SectionAssembler>();
  const states = new Map<number, ObjectCarouselState>();

  for (const packet of scanPackets(data, layout)) {
    if (!packet.hasPayload || packet.payload === undefined) continue;
    if (options.pids && !options.pids.has(packet.pid)) continue;
    if (packet.scrambling !== 0) {
      assemblers.delete(packet.pid);
      continue;
    }
    let assembler = assemblers.get(packet.pid);
    if (!assembler) {
      assembler = new SectionAssembler(packet.pid);
      assemblers.set(packet.pid, assembler);
    }
    for (const section of assembler.push(
      packet.payload,
      packet.pusi,
      packet.index,
      packet.offset,
    )) {
      const tableId = section.data[0] as number;
      if (tableId !== DSMCC_DOWNLOAD_TABLE && tableId !== DSMCC_DDB_TABLE) continue;
      let state = states.get(packet.pid);
      if (!state) {
        state = new ObjectCarouselState(packet.pid, options);
      }
      if (state.pushSection(section.data) === null) continue;
      states.set(packet.pid, state);
    }
  }

  const carousels: ProbeDsmccCarousel[] = [];
  const files: ScannedCarouselFile[] = [];
  for (const [pid, state] of states) {
    carousels.push(state.report);
    for (const file of state.collectFiles()) {
      files.push({
        pid,
        path: file.path,
        ...(file.size !== undefined ? { size: file.size } : {}),
        ...(file.contentType !== undefined ? { contentType: file.contentType } : {}),
        complete: file.complete,
        ...(file.data !== undefined ? { data: file.data } : {}),
      });
    }
  }
  return { carousels, files };
}
