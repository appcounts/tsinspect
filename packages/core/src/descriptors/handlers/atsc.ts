import { hex, readU8, readU16 } from '../../util/bytes.js';
import { parseAtscMultipleString } from '../atsc-string.js';
import { applyAtscStrings, ascii } from '../dvb-string.js';
import type { DescriptorFields, DescriptorHandler } from '../registry.js';

const atscStrings: DescriptorHandler = (_raw, d) => {
  const fields: DescriptorFields = {};
  applyAtscStrings(fields, d);
  return fields;
};

const contentAdvisory: DescriptorHandler = (_raw, d) => {
  // A/65 6.4.3: reserved(2) + rating_region_count(6), then per region
  // rating_region, rated_dimensions, dimension/value pairs and a multiple
  // string rating description. The leading 0xC1 of common streams is
  // "1 region", not a region number.
  const fields: DescriptorFields = {};
  const regionCount = readU8(d, 0) & 0x3f;
  const regions: number[] = [];
  const ratings: string[] = [];
  const descriptions: string[] = [];
  let cursor = 1;
  for (let i = 0; i < regionCount && cursor < d.length; i += 1) {
    const region = readU8(d, cursor);
    const dimensions = readU8(d, cursor + 1);
    cursor += 2;
    regions.push(region);
    for (let j = 0; j < dimensions && cursor + 1 < d.length; j += 1) {
      const dimension = readU8(d, cursor);
      const value = readU8(d, cursor + 1) & 0x0f;
      ratings.push(`${region}/${dimension}/${value}`);
      cursor += 2;
    }
    const descriptionLength = readU8(d, cursor);
    cursor += 1;
    const end = Math.min(d.length, cursor + descriptionLength);
    if (descriptionLength > 0) {
      const text = parseAtscMultipleString(d.subarray(cursor, end))
        .map((entry) => entry.text)
        .filter((entry) => entry.length > 0)
        .join(' ');
      if (text.length > 0) descriptions.push(text);
    }
    cursor = end;
  }
  const firstRegion = regions[0];
  if (firstRegion !== undefined) {
    fields.ratingRegion = firstRegion;
    fields.regionCount = regions.length;
  }
  if (ratings.length > 0) {
    fields.dimensions = ratings.length;
    fields.ratings = ratings.join(', ');
  }
  if (descriptions.length > 0) fields.ratingDescription = descriptions.join('; ');
  return fields;
};

const privateData: DescriptorHandler = (_raw, d) => ({
  // ATSC private information descriptors: expose the payload verbatim.
  privateData: hex(d, 0),
});

const serviceLocation: DescriptorHandler = (_raw, d) => {
  const fields: DescriptorFields = {};
  // ATSC service_location_descriptor (A/65): PCR PID and stream loop.
  fields.pcrPid = readU16(d, 0) & 0x1fff;
  const count = readU8(d, 2);
  fields.elementCount = count;
  const elements: string[] = [];
  let cursor = 3;
  for (let i = 0; i < count && cursor + 6 <= d.length; i += 1) {
    const streamType = readU8(d, cursor);
    const pid = readU16(d, cursor + 1) & 0x1fff;
    const language = ascii(d.subarray(cursor + 3, cursor + 6));
    elements.push(`${streamType}:${pid}:${language}`);
    cursor += 6;
  }
  if (elements.length > 0) fields.elements = elements.join(', ');
  return fields;
};

const timeShiftedService: DescriptorHandler = (_raw, d) => {
  const fields: DescriptorFields = {};
  // ATSC time_shifted_service_descriptor: event id list.
  const count = readU8(d, 0) & 0x03;
  const events: number[] = [];
  for (let i = 1; i < count * 2 + 1 && i + 2 <= d.length; i += 2) {
    events.push(readU16(d, i) & 0x3fff);
  }
  fields.eventCount = count;
  if (events.length > 0) fields.eventIds = events.join(', ');
  return fields;
};

export const atscHandlers: Record<number, DescriptorHandler> = {
  0x87: contentAdvisory,
  0xa0: atscStrings,
  0xa1: serviceLocation,
  0xa2: timeShiftedService,
  0xa3: atscStrings,
  0x85: atscStrings,
  0x88: privateData,
  0xa4: privateData,
  0xa5: privateData,
};
