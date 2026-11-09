/**
 * DVB subtitles in PES (ETSI EN 300 743).
 *
 * The payload starts with data_identifier 0x20 and a subtitle_stream_id,
 * followed by display sets. This module indexes display sets, pages and
 * segment types; text is rendered from bitmaps so no text is extracted.
 */

export type DvbSubtitleSegmentType =
  | 'page-composition'
  | 'region-composition'
  | 'clut-definition'
  | 'object-data'
  | 'display-definition'
  | 'end-of-display-set'
  | 'stuffing'
  | 'unknown';

export interface DvbSubtitleSegment {
  type: number;
  typeName: DvbSubtitleSegmentType;
  pageId: number;
  length: number;
  /** Raw segment body, used by the bitmap renderer (CLUT, objects, geometry). */
  body?: Uint8Array;
  /** Parsed fields of the segment body, when the type is known. */
  fields?: Record<string, string | number | boolean>;
}

export interface DvbSubtitleIndex {
  dataIdentifier: number;
  subtitleStreamId: number;
  segments: DvbSubtitleSegment[];
}

function readU8(data: Uint8Array, offset: number): number {
  return data[offset] ?? 0;
}

function readU16(data: Uint8Array, offset: number): number {
  return (readU8(data, offset) << 8) | readU8(data, offset + 1);
}

function parseSegmentFields(
  type: number,
  body: Uint8Array,
): Record<string, string | number | boolean> | undefined {
  const fields: Record<string, string | number | boolean> = {};
  switch (type) {
    case 0x10: {
      if (body.length < 2) return undefined;
      fields.pageTimeOut = readU8(body, 0);
      fields.version = (readU8(body, 1) >> 4) & 0x0f;
      fields.state = (readU8(body, 1) >> 2) & 0x03;
      const regionIds: number[] = [];
      for (let i = 2; i + 1 < body.length; i += 2) regionIds.push(readU8(body, i));
      if (regionIds.length > 0) fields.regionIds = regionIds.join(', ');
      break;
    }
    case 0x11: {
      if (body.length < 8) return undefined;
      fields.regionId = readU8(body, 0);
      fields.version = (readU8(body, 1) >> 4) & 0x0f;
      fields.fill = (readU8(body, 1) & 0x08) !== 0;
      fields.width = readU16(body, 2);
      fields.height = readU16(body, 4);
      fields.levelOfCompatibility = (readU8(body, 6) >> 5) & 0x07;
      fields.depth = (readU8(body, 6) >> 2) & 0x07;
      fields.clutId = readU8(body, 7);
      if (body.length >= 10) {
        fields.pixel8 = readU8(body, 8);
        fields.pixel4 = (readU8(body, 9) >> 4) & 0x0f;
        fields.pixel2 = (readU8(body, 9) >> 2) & 0x03;
      }
      break;
    }
    case 0x12: {
      if (body.length < 2) return undefined;
      fields.clutId = readU8(body, 0);
      fields.version = (readU8(body, 1) >> 4) & 0x0f;
      fields.entryBytes = Math.max(0, body.length - 2);
      break;
    }
    case 0x13: {
      if (body.length < 3) return undefined;
      fields.objectId = readU16(body, 0);
      fields.codingMethod = (readU8(body, 2) >> 2) & 0x03;
      fields.nonModifyingColor = (readU8(body, 2) & 0x02) !== 0;
      if (fields.codingMethod === 0 && body.length >= 7) {
        fields.topFieldLength = readU16(body, 3);
        fields.bottomFieldLength = readU16(body, 5);
      }
      break;
    }
    case 0x14: {
      if (body.length < 5) return undefined;
      fields.version = (readU8(body, 0) >> 4) & 0x0f;
      fields.displayWindowFlag = (readU8(body, 0) & 0x08) !== 0;
      fields.displayWidth = readU16(body, 1);
      fields.displayHeight = readU16(body, 3);
      if (fields.displayWindowFlag && body.length >= 13) {
        fields.windowX = readU16(body, 5);
        fields.windowY = readU16(body, 7);
        fields.windowWidth = readU16(body, 9);
        fields.windowHeight = readU16(body, 11);
      }
      break;
    }
    default:
      return undefined;
  }
  return Object.keys(fields).length > 0 ? fields : undefined;
}

function segmentTypeName(type: number): DvbSubtitleSegmentType {
  switch (type) {
    case 0x10:
      return 'page-composition';
    case 0x11:
      return 'region-composition';
    case 0x12:
      return 'clut-definition';
    case 0x13:
      return 'object-data';
    case 0x14:
      return 'display-definition';
    case 0x80:
      return 'end-of-display-set';
    case 0xff:
      return 'stuffing';
    default:
      return 'unknown';
  }
}

export function indexDvbSubtitlePes(payload: Uint8Array): DvbSubtitleIndex | null {
  if (payload.length < 2 || payload[0] !== 0x20) return null;
  const subtitleStreamId = payload[1] as number;
  const segments: DvbSubtitleSegment[] = [];
  let cursor = 2;

  while (cursor + 6 <= payload.length) {
    if (payload[cursor] !== 0x0f) {
      cursor += 1;
      continue;
    }

    const type = payload[cursor + 1] as number;
    const pageId = ((payload[cursor + 2] as number) << 8) | (payload[cursor + 3] as number);
    const length = ((payload[cursor + 4] as number) << 8) | (payload[cursor + 5] as number);
    const start = cursor + 6;
    const end = Math.min(payload.length, start + length);
    const body = payload.subarray(start, end);
    const fields = parseSegmentFields(type, body);
    segments.push({
      type,
      typeName: segmentTypeName(type),
      pageId,
      length,
      body: body.slice(),
      ...(fields !== undefined ? { fields } : {}),
    });
    cursor = end;
    // Stuffing between segments is not prefixed by the 0x0F sync byte.
    while (cursor < payload.length && payload[cursor] !== 0x0f) cursor += 1;
  }

  return { dataIdentifier: payload[0] as number, subtitleStreamId, segments };
}
