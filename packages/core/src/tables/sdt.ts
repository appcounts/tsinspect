import type { DescriptorInfo } from '../model/types.js';
import {
  describeDescriptors,
  parseRawDescriptors,
  type TextEncoding,
} from '../descriptors/descriptor.js';
import { readU16, readU8 } from '../util/bytes.js';
import { parseLongSectionHeader } from './common.js';

export interface SdtService {
  serviceId: number;
  originalNetworkId: number;
  eitSchedule: boolean;
  eitPresentFollowing: boolean;
  runningStatus: number;
  freeCaMode: boolean;
  descriptors: DescriptorInfo[];
  serviceType?: number;
  providerName?: string;
  serviceName?: string;
}

export interface SdtSection {
  tableId: number;
  transportStreamId: number;
  originalNetworkId: number;
  version: number;
  currentNext: boolean;
  sectionNumber: number;
  lastSectionNumber: number;
  services: SdtService[];
  crcValid: boolean;
}

export function parseSdt(
  data: Uint8Array,
  textEncoding: TextEncoding = 'dvb',
): SdtSection | null {
  const header = parseLongSectionHeader(data);
  if (!header || (header.tableId !== 0x42 && header.tableId !== 0x46)) return null;

  const end = header.totalLength - 4;
  if (end < 11) return null;
  const originalNetworkId = readU16(data, 8);
  const services: SdtService[] = [];
  let cursor = 11;

  while (cursor + 5 <= end) {
    const serviceId = readU16(data, cursor);
    const flags = readU8(data, cursor + 2);
    const b3 = readU8(data, cursor + 3);
    const runningStatus = (b3 >> 5) & 0x07;
    const freeCaMode = (b3 & 0x10) !== 0;
    const descriptorLength = ((b3 & 0x0f) << 8) | readU8(data, cursor + 4);
    const descriptorStart = cursor + 5;
    const descriptorEnd = Math.min(end, descriptorStart + descriptorLength);

    const descriptors = describeDescriptors(
      parseRawDescriptors(data, descriptorStart, descriptorEnd - descriptorStart),
      textEncoding,
    );
    const serviceDescriptor = descriptors.find((descriptor) => descriptor.tag === 0x48);

    services.push({
      serviceId,
      originalNetworkId,
      eitSchedule: (flags & 0x02) !== 0,
      eitPresentFollowing: (flags & 0x01) !== 0,
      runningStatus,
      freeCaMode,
      descriptors,
      ...(serviceDescriptor?.fields?.serviceType !== undefined
        ? { serviceType: Number(serviceDescriptor.fields.serviceType) }
        : {}),
      ...(serviceDescriptor?.fields?.providerName !== undefined
        ? { providerName: String(serviceDescriptor.fields.providerName) }
        : {}),
      ...(serviceDescriptor?.fields?.serviceName !== undefined
        ? { serviceName: String(serviceDescriptor.fields.serviceName) }
        : {}),
    });

    cursor = descriptorEnd;
  }

  return {
    tableId: header.tableId,
    transportStreamId: header.tableIdExtension,
    originalNetworkId,
    version: header.version,
    currentNext: header.currentNext,
    sectionNumber: header.sectionNumber,
    lastSectionNumber: header.lastSectionNumber,
    services,
    crcValid: header.crcValid,
  };
}
