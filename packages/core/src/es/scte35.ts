import type { DescriptorInfo } from '../model/types.js';
import { parseRawDescriptors } from '../descriptors/descriptor.js';
import { isSectionCrcValid } from '../section/crc32.js';
import { hex } from '../util/bytes.js';

/** SCTE-35 descriptor tags share numeric values with unrelated DVB SI tags. */
const SCTE35_DESCRIPTOR_NAMES: Record<number, string> = {
  0x00: 'avail_descriptor',
  0x01: 'DTMF_descriptor',
  0x02: 'segmentation_descriptor',
  0x03: 'time_descriptor',
  0x04: 'audio_descriptor',
};

function segmentationDescriptorFields(
  parsed: Scte35Segmentation,
): Record<string, string | number | boolean> {
  const fields: Record<string, string | number | boolean> = { eventId: parsed.eventId };
  const put = (key: string, value: string | number | boolean | undefined): void => {
    if (value !== undefined) fields[key] = value;
  };
  put('cancel', parsed.cancel);
  put('identifier', parsed.identifier);
  put('typeId', parsed.typeId);
  put('typeName', parsed.typeName);
  put('upidType', parsed.upidType);
  put('upid', parsed.upid);
  put('duration', parsed.duration);
  put('segmentNum', parsed.segmentNum);
  put('segmentsExpected', parsed.segmentsExpected);
  put('subSegmentNum', parsed.subSegmentNum);
  put('subSegmentsExpected', parsed.subSegmentsExpected);
  return fields;
}

export interface Scte35Segmentation {
  eventId: number;
  cancel: boolean;
  /** CUEI identifier present in SCTE-35 2019+ descriptors. */
  identifier?: string;
  compliance?: boolean;
  typeId?: number;
  typeName?: string;
  upidType?: number;
  upidLength?: number;
  upid?: string;
  duration?: number;
  durationFlag?: boolean;
  programSegmentation?: boolean;
  deliveryNotRestricted?: boolean;
  webDeliveryAllowed?: boolean;
  noRegionalBlackout?: boolean;
  archiveAllowed?: boolean;
  deviceRestrictions?: number;
  segmentNum?: number;
  segmentsExpected?: number;
  subSegmentNum?: number;
  subSegmentsExpected?: number;
}

export interface Scte35Section {
  protocolVersion: number;
  encrypted: boolean;
  encryptionAlgorithm: number;
  ptsAdjustment: number;
  cwIndex: number;
  tier: number;
  commandType: number;
  commandName: string;
  commandLength: number;
  eventId?: number;
  eventCancel?: boolean;
  outOfNetwork?: boolean;
  spliceImmediate?: boolean;
  spliceTime?: number;
  breakDuration?: number;
  autoReturn?: boolean;
  uniqueProgramId?: number;
  availNum?: number;
  availsExpected?: number;
  scheduleCount?: number;
  /** private_command() identifier, for command type 0xFF. */
  privateIdentifier?: string;
  /** private_command() payload as uppercase hex. */
  privateData?: string;
  segmentation?: Scte35Segmentation;
  descriptors: DescriptorInfo[];
  crcValid: boolean;
}

const COMMAND_NAMES: Record<number, string> = {
  0x00: 'splice_null',
  0x04: 'splice_schedule',
  0x05: 'splice_insert',
  0x06: 'time_signal',
  0x07: 'bandwidth_reservation',
  0xff: 'private_command',
};

export function scte35CommandName(type: number): string {
  return COMMAND_NAMES[type] ?? `reserved (0x${type.toString(16).padStart(2, '0').toUpperCase()})`;
}

class BitReader {
  private position = 0;
  constructor(private readonly data: Uint8Array) {}

  read(bits: number): number {
    let value = 0;
    for (let i = 0; i < bits; i += 1) {
      const byte = this.data[this.position >> 3] ?? 0;
      const bit = (byte >> (7 - (this.position & 7))) & 1;
      value = (value << 1) | bit;
      this.position += 1;
    }
    return value >>> 0;
  }

  get byteOffset(): number {
    return this.position >> 3;
  }

  skip(bits: number): void {
    this.position += bits;
  }

  get bitOffset(): number {
    return this.position;
  }
}

function readSpliceTime(reader: BitReader): number | undefined {
  const specified = reader.read(1) !== 0;
  if (specified === false) {
    reader.read(7);
    return undefined;
  }
  reader.read(6);
  return reader.read(33);
}

function readBreakDuration(reader: BitReader): { duration: number; autoReturn: boolean } {
  const autoReturn = reader.read(1) !== 0;
  reader.read(6);
  return { duration: reader.read(33), autoReturn };
}

/** segmentation_type_id names (SCTE-35 table 22). */
const SEGMENTATION_TYPES: Record<number, string> = {
  0x00: 'Not indicated',
  0x01: 'Content identification',
  0x10: 'Program start',
  0x11: 'Program end',
  0x12: 'Program early termination',
  0x13: 'Program breakaway',
  0x14: 'Program resumption',
  0x15: 'Program runover planned',
  0x16: 'Program runover unplanned',
  0x17: 'Program overlap start',
  0x18: 'Program blackout override',
  0x20: 'Chapter start',
  0x21: 'Chapter end',
  0x22: 'Break start',
  0x23: 'Break end',
  0x30: 'Provider advertisement start',
  0x31: 'Provider advertisement end',
  0x32: 'Distributor advertisement start',
  0x33: 'Distributor advertisement end',
  0x34: 'Provider placement opportunity start',
  0x35: 'Provider placement opportunity end',
  0x36: 'Distributor placement opportunity start',
  0x37: 'Distributor placement opportunity end',
  0x38: 'Provider overlay placement opportunity start',
  0x39: 'Provider overlay placement opportunity end',
  0x3a: 'Distributor overlay placement opportunity start',
  0x3b: 'Distributor overlay placement opportunity end',
  0x3c: 'Provider promo start',
  0x3d: 'Provider promo end',
  0x3e: 'Distributor promo start',
  0x3f: 'Distributor promo end',
  0x40: 'Unscheduled event start',
  0x41: 'Unscheduled event end',
  0x42: 'Alternate content opportunity start',
  0x43: 'Alternate content opportunity end',
  0x44: 'Provider ad block start',
  0x45: 'Provider ad block end',
  0x46: 'Distributor ad block start',
  0x47: 'Distributor ad block end',
  0x50: 'Network start',
  0x51: 'Network end',
};

export function scte35SegmentationTypeName(typeId: number): string {
  return SEGMENTATION_TYPES[typeId] ?? `Type 0x${typeId.toString(16).padStart(2, '0').toUpperCase()}`;
}

const SUB_SEGMENT_TYPES = new Set([0x30, 0x32, 0x34, 0x36, 0x38, 0x3a, 0x44, 0x46]);

function parseSegmentation(data: Uint8Array): Scte35Segmentation | undefined {
  if (data.length < 8) return undefined;
  const reader = new BitReader(data);

  // SCTE-35 2019+ prefixes the descriptor with the CUEI identifier.
  let identifier: string | undefined;
  if (data.length >= 8 && data[0] === 0x43 && data[1] === 0x55 && data[2] === 0x45 && data[3] === 0x49) {
    identifier = 'CUEI';
    reader.skip(32);
  }

  const eventId = reader.read(32);
  const cancel = reader.read(1) !== 0;
  const compliance = reader.read(1) !== 0;
  reader.read(6);
  if (cancel) return { eventId, cancel, ...(identifier ? { identifier } : {}) };

  const programSegmentation = reader.read(1) !== 0;
  const durationFlag = reader.read(1) !== 0;
  const deliveryNotRestricted = reader.read(1) !== 0;
  let webDeliveryAllowed: boolean | undefined;
  let noRegionalBlackout: boolean | undefined;
  let archiveAllowed: boolean | undefined;
  let deviceRestrictions: number | undefined;
  if (!deliveryNotRestricted) {
    webDeliveryAllowed = reader.read(1) !== 0;
    noRegionalBlackout = reader.read(1) !== 0;
    archiveAllowed = reader.read(1) !== 0;
    deviceRestrictions = reader.read(2);
  } else {
    reader.read(5);
  }

  let duration: number | undefined;
  if (durationFlag) duration = reader.read(40);

  const upidType = reader.read(8);
  const upidLength = reader.read(8);
  const upidStart = reader.byteOffset;
  const upid = hex(data.subarray(upidStart, Math.min(data.length, upidStart + upidLength)));
  reader.skip(upidLength * 8);

  const typeId = reader.read(8);
  const segmentNum = reader.read(8);
  const segmentsExpected = reader.read(8);
  let subSegmentNum: number | undefined;
  let subSegmentsExpected: number | undefined;
  if (SUB_SEGMENT_TYPES.has(typeId) && reader.bitOffset + 16 <= data.length * 8) {
    subSegmentNum = reader.read(8);
    subSegmentsExpected = reader.read(8);
  }

  return {
    eventId,
    cancel,
    ...(identifier ? { identifier } : {}),
    compliance,
    programSegmentation,
    durationFlag,
    deliveryNotRestricted,
    ...(webDeliveryAllowed !== undefined ? { webDeliveryAllowed } : {}),
    ...(noRegionalBlackout !== undefined ? { noRegionalBlackout } : {}),
    ...(archiveAllowed !== undefined ? { archiveAllowed } : {}),
    ...(deviceRestrictions !== undefined ? { deviceRestrictions } : {}),
    ...(duration !== undefined ? { duration } : {}),
    upidType,
    upidLength,
    ...(upid.length > 0 ? { upid } : {}),
    typeId,
    typeName: scte35SegmentationTypeName(typeId),
    segmentNum,
    segmentsExpected,
    ...(subSegmentNum !== undefined ? { subSegmentNum } : {}),
    ...(subSegmentsExpected !== undefined ? { subSegmentsExpected } : {}),
  };
}

export function parseScte35Section(data: Uint8Array): Scte35Section | null {
  if (data.length < 14 || data[0] !== 0xfc) return null;
  const sectionLength = (((data[1] as number) & 0x0f) << 8) | (data[2] as number);
  const totalLength = 3 + sectionLength;
  if (totalLength > data.length) return null;

  const reader = new BitReader(data);
  reader.read(8); // table_id
  reader.read(1); // section_syntax_indicator
  reader.read(1); // private_indicator
  reader.read(2); // sap_type
  const declaredLength = reader.read(12);
  if (declaredLength + 3 !== totalLength) return null;

  const protocolVersion = reader.read(8);
  const encrypted = reader.read(1) !== 0;
  const encryptionAlgorithm = reader.read(6);
  const ptsAdjustment = reader.read(33);
  const cwIndex = reader.read(8);
  const tier = reader.read(12);
  const commandLength = reader.read(12);
  const commandType = reader.read(8);
  const commandStart = reader.bitOffset;

  const section: Scte35Section = {
    protocolVersion,
    encrypted,
    encryptionAlgorithm,
    ptsAdjustment,
    cwIndex,
    tier,
    commandType,
    commandName: scte35CommandName(commandType),
    commandLength,
    descriptors: [],
    crcValid: isSectionCrcValid(data.subarray(0, totalLength)),
  };

  if (!encrypted) {
    if (commandType === 0x05) {
      section.eventId = reader.read(32);
      section.eventCancel = reader.read(1) !== 0;
      reader.read(7);
      if (!section.eventCancel) {
        section.outOfNetwork = reader.read(1) !== 0;
        const programSplice = reader.read(1) !== 0;
        const durationFlag = reader.read(1) !== 0;
        section.spliceImmediate = reader.read(1) !== 0;
        reader.read(4);
        if (programSplice && !section.spliceImmediate) {
          section.spliceTime = readSpliceTime(reader);
        } else if (!programSplice) {
          const count = reader.read(8);
          for (let i = 0; i < count; i += 1) {
            reader.read(8); // component_tag
            if (!section.spliceImmediate) readSpliceTime(reader);
          }
        }
        if (durationFlag) {
          const breakInfo = readBreakDuration(reader);
          section.breakDuration = breakInfo.duration;
          section.autoReturn = breakInfo.autoReturn;
        }
        section.uniqueProgramId = reader.read(16);
        section.availNum = reader.read(8);
        section.availsExpected = reader.read(8);
      }
    } else if (commandType === 0x06) {
      section.spliceTime = readSpliceTime(reader);
    } else if (commandType === 0x04) {
      const count = reader.read(8);
      const events: number[] = [];
      for (let i = 0; i < count; i += 1) {
        const eventId = reader.read(32);
        const cancel = reader.read(1) !== 0;
        reader.read(7);
        if (!cancel) {
          reader.read(1); // out_of_network
          const programSplice = reader.read(1) !== 0;
          const durationFlag = reader.read(1) !== 0;
          reader.read(5);
          if (programSplice) {
            reader.read(32); // utc_splice_time
          } else {
            const componentCount = reader.read(8);
            for (let j = 0; j < componentCount; j += 1) {
              reader.read(8); // component_tag
              reader.read(32); // utc_splice_time
            }
          }
          if (durationFlag) {
            reader.read(1); // auto_return
            reader.read(6);
            reader.read(33);
          }
          reader.read(16); // unique_program_id
          reader.read(8); // avail_num
          reader.read(8); // avails_expected
        }
        events.push(eventId);
      }
      // Keep the schedule count for display; individual events are not exposed.
      section.scheduleCount = events.length;
    } else if (commandType === 0xff) {
      section.privateIdentifier = hex(data.subarray(reader.byteOffset, reader.byteOffset + 4));
      reader.skip(32);
      const privateBytes =
        commandLength === 0xfff ? 0 : Math.max(0, commandLength - 4);
      const start = reader.byteOffset;
      section.privateData = hex(data.subarray(start, Math.min(data.length, start + privateBytes)));
    }

    // 0xFFF means the command length is unspecified; the real length is defined
    // by the command type. Only trust the declared value when it is explicit.
    if (commandLength !== 0xfff) {
      const commandEnd = commandStart + commandLength * 8;
      if (commandEnd > reader.bitOffset) reader.skip(commandEnd - reader.bitOffset);
    }
  }

  // Commands that neither have a fixed length nor were parsed leave the reader
  // at an unknown offset, so the descriptor loop cannot be trusted.
  const commandLengthUnknown =
    commandLength === 0xfff &&
    commandType !== 0x00 &&
    commandType !== 0x04 &&
    commandType !== 0x05 &&
    commandType !== 0x06 &&
    commandType !== 0x07;
  if (commandLengthUnknown) return section;

  const descriptorLoopLength = reader.read(16);
  const descriptorStart = reader.byteOffset;
  const descriptorLength = Math.min(descriptorLoopLength, Math.max(0, totalLength - 4 - descriptorStart));
  const rawDescriptors = parseRawDescriptors(data, descriptorStart, descriptorLength);
  section.descriptors = rawDescriptors.map((descriptor) => {
    const tagHex = `0x${descriptor.tag.toString(16).padStart(2, '0').toUpperCase()}`;
    let fields: Record<string, string | number | boolean> | undefined;
    if (descriptor.tag === 0x02) {
      const parsed = parseSegmentation(descriptor.data);
      if (parsed) {
        section.segmentation = parsed;
        fields = segmentationDescriptorFields(parsed);
      }
    }
    return {
      tag: descriptor.tag,
      tagHex,
      length: descriptor.length,
      name: SCTE35_DESCRIPTOR_NAMES[descriptor.tag] ?? `SCTE-35 descriptor ${tagHex}`,
      raw: hex(descriptor.data),
      ...(fields !== undefined ? { fields } : {}),
    } satisfies DescriptorInfo;
  });

  return section;
}
