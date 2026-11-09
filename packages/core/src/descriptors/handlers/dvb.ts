import { hex, readU8, readU16 } from '../../util/bytes.js';
import { parseDvbDateTime } from '../../util/time.js';
import { ascii } from '../dvb-string.js';
import { LINKAGE_TYPE_NAMES, contentGenreName } from '../names.js';
import {
  BANDWIDTH_NAMES,
  CABLE_MODULATION_NAMES,
  CODE_RATE_NAMES,
  FEC_OUTER_NAMES,
  GUARD_INTERVAL_NAMES,
  POLARIZATION_NAMES,
  ROLL_OFF_NAMES,
  SATELLITE_MODULATION_NAMES,
  TERRESTRIAL_CONSTELLATION_NAMES,
  TRANSMISSION_MODE_NAMES,
  nameOr,
} from '../delivery.js';
import type { DescriptorFields, DescriptorHandler } from '../registry.js';

function readU32(data: Uint8Array, offset: number): number {
  return (
    readU8(data, offset) * 0x1000000 +
    (readU8(data, offset + 1) << 16) +
    (readU8(data, offset + 2) << 8) +
    readU8(data, offset + 3)
  );
}

function decodeBcdByte(value: number): number | undefined {
  const high = (value >> 4) & 0x0f;
  const low = value & 0x0f;
  if (high > 9 || low > 9) return undefined;
  return high * 10 + low;
}

function bcdTimeOffset(value: number, polarity: number): string | undefined {
  const hours = decodeBcdByte((value >> 8) & 0xff);
  const minutes = decodeBcdByte(value & 0xff);
  if (hours === undefined || minutes === undefined) return undefined;
  const sign = polarity === 1 ? '-' : '+';
  return `${sign}${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

const formatIdentifier: DescriptorHandler = (_raw, d) => ({ formatIdentifier: ascii(d.subarray(0, 4)) });

const ca: DescriptorHandler = (_raw, d) => ({
  caSystemId: readU16(d, 0),
  caPid: readU16(d, 2) & 0x1fff,
});

const carouselIdentifier: DescriptorHandler = (_raw, d) => {
  const fields: DescriptorFields = {};
  // carousel_identifier_descriptor (EN 300 468, 6.2.9).
  if (d.length >= 5) {
    const carouselId = readU32(d, 0);
    fields.carouselId = carouselId;
    fields.carouselIdHex = `0x${carouselId.toString(16).padStart(8, '0').toUpperCase()}`;
    fields.formatId = readU8(d, 4);
    if (d.length > 5) fields.formatSpecifier = hex(d, 5);
  }
  return fields;
};

const associationTag: DescriptorHandler = (_raw, d) => {
  const fields: DescriptorFields = {};
  // association_tag_descriptor (EN 300 468, 6.2.7).
  if (d.length >= 2) {
    fields.associationTag = readU16(d, 0);
    fields.associationTagHex = `0x${readU16(d, 0).toString(16).padStart(4, '0').toUpperCase()}`;
    if (d.length > 2) fields.additionalData = hex(d, 2);
  }
  return fields;
};

const nameText: DescriptorHandler = (_raw, d, context) => ({ name: context.decodeText(d) });

const serviceList: DescriptorHandler = (_raw, d) => {
  const services: string[] = [];
  for (let i = 0; i + 3 <= d.length; i += 3) {
    services.push(`${readU16(d, i)}:${readU8(d, i + 2)}`);
  }
  return { services: services.join(', ') };
};

const satelliteDelivery: DescriptorHandler = (_raw, d) => {
  // satellite_delivery_system_descriptor (EN 300 468, 6.2.13.1).
  const fields: DescriptorFields = {};
  const frequency = readU32(d, 0);
  const orbitalPosition = readU16(d, 5);
  const flags = readU8(d, 6);
  const polarization = (flags >> 5) & 0x03;
  const modulation = flags & 0x1f;
  const symbolRate = readU32(d, 7) >>> 4;
  const fecInner = readU8(d, 10) & 0x0f;
  fields.frequency = frequency * 10;
  fields.orbitalPosition = (orbitalPosition % 3600) / 10;
  fields.westEast = (flags & 0x80) !== 0 ? 'west' : 'east';
  fields.polarization = polarization;
  fields.polarizationName = nameOr(polarization, POLARIZATION_NAMES);
  fields.modulation = modulation;
  fields.modulationName = nameOr(modulation, SATELLITE_MODULATION_NAMES);
  fields.symbolRate = symbolRate * 100;
  fields.fecInner = fecInner;
  fields.fecInnerName = nameOr(fecInner, CODE_RATE_NAMES);
  if (d.length >= 12) {
    const rollOff = (readU8(d, 11) >> 4) & 0x03;
    fields.rollOff = rollOff;
    fields.rollOffName = nameOr(rollOff, ROLL_OFF_NAMES);
  }
  return fields;
};

const cableDelivery: DescriptorHandler = (_raw, d) => {
  // cable_delivery_system_descriptor (EN 300 468, 6.2.13.2).
  const fields: DescriptorFields = {};
  const frequency = readU32(d, 0);
  const fecOuter = readU8(d, 4) & 0x0f;
  const modulation = readU8(d, 5);
  const symbolRate = readU32(d, 6) >>> 4;
  const fecInner = readU8(d, 9) & 0x0f;
  fields.frequency = frequency * 100;
  fields.fecOuter = fecOuter;
  fields.fecOuterName = nameOr(fecOuter, FEC_OUTER_NAMES);
  fields.modulation = modulation;
  fields.modulationName = nameOr(modulation, CABLE_MODULATION_NAMES);
  fields.symbolRate = symbolRate * 100;
  fields.fecInner = fecInner;
  fields.fecInnerName = nameOr(fecInner, CODE_RATE_NAMES);
  return fields;
};

const service: DescriptorHandler = (_raw, d, context) => {
  const fields: DescriptorFields = {};
  fields.serviceType = readU8(d, 0);
  const providerLength = readU8(d, 1);
  fields.providerName = context.decodeText(d.subarray(2, 2 + providerLength));
  const nameLength = readU8(d, 2 + providerLength);
  fields.serviceName = context.decodeText(
    d.subarray(3 + providerLength, 3 + providerLength + nameLength),
  );
  return fields;
};

const linkage: DescriptorHandler = (_raw, d) => {
  const fields: DescriptorFields = {};
  // linkage_descriptor (EN 300 468, 6.2.19).
  if (d.length >= 7) {
    const transportStreamId = readU16(d, 0);
    const originalNetworkId = readU16(d, 2);
    const serviceId = readU16(d, 4);
    const linkageType = readU8(d, 6);
    fields.transportStreamId = transportStreamId;
    fields.originalNetworkId = originalNetworkId;
    fields.serviceId = serviceId;
    fields.linkageType = linkageType;
    fields.linkageTypeName = LINKAGE_TYPE_NAMES[linkageType] ?? `reserved (${linkageType})`;
    if (linkageType === 0x08 && d.length >= 9) {
      const handOver = readU8(d, 7);
      fields.handOverType = handOver >> 4;
      fields.originatorNetworkId = readU16(d, 8);
    } else if (linkageType === 0x0d && d.length >= 8) {
      fields.targetEventId = readU16(d, 7);
    }
  }
  return fields;
};

const nvodReference: DescriptorHandler = (_raw, d) => {
  const fields: DescriptorFields = {};
  // nvod_reference_descriptor (EN 300 468, 6.2.28).
  const references: string[] = [];
  for (let i = 0; i + 12 <= d.length; i += 12) {
    const tsid = readU16(d, i);
    const onid = readU16(d, i + 2);
    const serviceId = readU16(d, i + 4);
    const eventId = readU16(d, i + 10) & 0x0fff;
    references.push(`${tsid}/${onid}/${serviceId}/${eventId}`);
  }
  fields.nvodReferences = references.length;
  if (references.length > 0) fields.references = references.join(', ');
  return fields;
};

const referenceServiceId: DescriptorHandler = (_raw, d) => ({
  referenceServiceId: readU16(d, 0),
});

const shortEvent: DescriptorHandler = (_raw, d, context) => {
  const fields: DescriptorFields = {};
  fields.language = ascii(d.subarray(0, 3));
  const nameLength = readU8(d, 3);
  fields.eventName = context.decodeText(d.subarray(4, 4 + nameLength));
  const textLength = readU8(d, 4 + nameLength);
  fields.text = context.decodeText(d.subarray(5 + nameLength, 5 + nameLength + textLength));
  return fields;
};

const extendedEvent: DescriptorHandler = (_raw, d, context) => {
  const fields: DescriptorFields = {};
  fields.descriptorNumber = readU8(d, 0) >> 4;
  fields.lastDescriptorNumber = readU8(d, 0) & 0x0f;
  fields.language = ascii(d.subarray(1, 4));
  const itemsLength = readU8(d, 4);
  const items: string[] = [];
  let itemCursor = 5;
  const itemsEnd = Math.min(d.length, itemCursor + itemsLength);
  while (itemCursor + 2 <= itemsEnd) {
    const descriptionLength = readU8(d, itemCursor);
    const description = context.decodeText(
      d.subarray(itemCursor + 1, itemCursor + 1 + descriptionLength),
    );
    itemCursor += 1 + descriptionLength;
    if (itemCursor >= itemsEnd) break;
    const valueLength = readU8(d, itemCursor);
    const value = context.decodeText(d.subarray(itemCursor + 1, itemCursor + 1 + valueLength));
    itemCursor += 1 + valueLength;
    items.push(`${description}=${value}`);
  }
  if (items.length > 0) fields.items = items.join('; ');
  if (itemCursor < d.length) {
    const textLength = readU8(d, itemCursor);
    fields.text = context.decodeText(d.subarray(itemCursor + 1, itemCursor + 1 + textLength));
  }
  return fields;
};

const timeShiftedEvent: DescriptorHandler = (_raw, d) => ({
  referenceServiceId: readU16(d, 0),
  referenceEventId: readU16(d, 2),
});

const component: DescriptorHandler = (_raw, d, context) => {
  const fields: DescriptorFields = {};
  const first = readU8(d, 0);
  fields.streamContent = first >> 4;
  fields.componentType = first & 0x0f;
  fields.componentTag = readU8(d, 1);
  fields.language = ascii(d.subarray(2, 5));
  fields.text = context.decodeText(d.subarray(5));
  return fields;
};

const streamIdentifier: DescriptorHandler = (_raw, d) => ({
  componentTag: readU8(d, 0),
});

const caIdentifier: DescriptorHandler = (_raw, d) => {
  // CA_identifier_descriptor: ca_system_id list.
  const systems: number[] = [];
  for (let i = 0; i + 2 <= d.length; i += 2) systems.push(readU16(d, i));
  const fields: DescriptorFields = {};
  if (systems.length > 0) fields.caSystemIds = systems.join(', ');
  return fields;
};

const content: DescriptorHandler = (_raw, d) => {
  const fields: DescriptorFields = {};
  const contents: string[] = [];
  const names: string[] = [];
  for (let i = 0; i + 2 <= d.length; i += 2) {
    const b0 = readU8(d, i);
    const b1 = readU8(d, i + 1);
    const level1 = b0 >> 4;
    const level2 = b0 & 0x0f;
    const user1 = b1 >> 4;
    const user2 = b1 & 0x0f;
    contents.push(`${level1}/${level2}/${user1}/${user2}`);
    const name = contentGenreName(level1, level2);
    names.push(user1 !== 0 || user2 !== 0 ? `${name} (user ${user1}/${user2})` : name);
  }
  fields.content = contents.join(', ');
  if (names.length > 0) fields.contentName = names.join('; ');
  return fields;
};

const parentalRating: DescriptorHandler = (_raw, d) => {
  const fields: DescriptorFields = {};
  // parental_rating_descriptor: country_code(24) + rating(8), repeated.
  const ratings: string[] = [];
  const summary: string[] = [];
  for (let i = 0; i + 4 <= d.length; i += 4) {
    const country = ascii(d.subarray(i, i + 3));
    const rating = readU8(d, i + 3);
    ratings.push(`${country}: ${rating}`);
    summary.push(`${country}: rating ${rating}`);
  }
  fields.ratings = ratings.join(', ');
  if (summary.length > 0) fields.ratingSummary = summary.join(', ');
  if (d.length >= 4) {
    fields.countryCode = ascii(d.subarray(0, 3));
    fields.rating = readU8(d, 3);
    const rating = readU8(d, 3);
    if (rating >= 0x01 && rating <= 0x0f) fields.minimumAge = rating + 3;
  }
  return fields;
};

const localTimeOffset: DescriptorHandler = (_raw, d) => {
  const fields: DescriptorFields = {};
  fields.countryCode = ascii(d.subarray(0, 3));
  const flags = readU8(d, 3);
  fields.countryRegionId = (flags >> 2) & 0x3f;
  const polarity = flags & 0x01;
  const offset = bcdTimeOffset(readU16(d, 4), polarity);
  if (offset !== undefined) fields.localTimeOffset = offset;
  const change = parseDvbDateTime(d, 6);
  if (change) fields.timeOfChange = change.iso;
  if (d.length >= 13) {
    const next = bcdTimeOffset(readU16(d, 11), polarity);
    if (next !== undefined) fields.nextTimeOffset = next;
  }
  return fields;
};

const terrestrialDelivery: DescriptorHandler = (_raw, d) => {
  // terrestrial_delivery_system_descriptor (EN 300 468, 6.2.13.3).
  const fields: DescriptorFields = {};
  const bandwidth = readU8(d, 4) >> 5;
  const priority = (readU8(d, 4) >> 4) & 0x01;
  const timeSlicing = (readU8(d, 4) >> 3) & 0x01;
  const mpeFec = (readU8(d, 4) >> 2) & 0x01;
  const constellation = (readU8(d, 5) >> 6) & 0x03;
  const hierarchy = (readU8(d, 5) >> 3) & 0x07;
  const codeRateHp = (readU8(d, 6) >> 5) & 0x07;
  const codeRateLp = (readU8(d, 6) >> 2) & 0x07;
  const guardInterval = (readU8(d, 7) >> 6) & 0x03;
  const transmissionMode = (readU8(d, 7) >> 4) & 0x03;
  fields.centreFrequency = readU32(d, 0) * 10;
  fields.bandwidth = bandwidth;
  fields.bandwidthName = nameOr(bandwidth, BANDWIDTH_NAMES);
  fields.priority = priority;
  fields.timeSlicing = timeSlicing !== 0;
  fields.mpeFec = mpeFec !== 0;
  fields.constellation = constellation;
  fields.constellationName = nameOr(constellation, TERRESTRIAL_CONSTELLATION_NAMES);
  fields.hierarchy = hierarchy;
  fields.codeRateHp = codeRateHp;
  fields.codeRateHpName = nameOr(codeRateHp, CODE_RATE_NAMES);
  fields.codeRateLp = codeRateLp;
  fields.codeRateLpName = nameOr(codeRateLp, CODE_RATE_NAMES);
  fields.guardInterval = guardInterval;
  fields.guardIntervalName = nameOr(guardInterval, GUARD_INTERVAL_NAMES);
  fields.transmissionMode = transmissionMode;
  fields.transmissionModeName = nameOr(transmissionMode, TRANSMISSION_MODE_NAMES);
  fields.otherFrequency = (readU8(d, 7) & 0x08) !== 0;
  return fields;
};

const multilingual: DescriptorHandler = (raw, d, context) => {
  // Multilingual network/bouquet/service/component descriptors.
  const fields: DescriptorFields = {};
  const defaultLanguage = ascii(d.subarray(0, 3));
  const languages: string[] = [];
  const names: string[] = [];
  let cursor = 3;
  while (cursor + 1 <= d.length) {
    if (cursor + 3 > d.length) break;
    const language = ascii(d.subarray(cursor, cursor + 3));
    cursor += 3;
    const firstLength = readU8(d, cursor);
    cursor += 1;
    const first = context.decodeText(d.subarray(cursor, cursor + firstLength));
    cursor += firstLength;
    languages.push(language);
    if (raw.tag === 0x5d) {
      const secondLength = cursor < d.length ? readU8(d, cursor) : 0;
      cursor += 1;
      const second = context.decodeText(d.subarray(cursor, cursor + secondLength));
      cursor += secondLength;
      names.push(`${language} ${first}/${second}`);
    } else {
      names.push(`${language} ${first}`);
    }
    if (cursor >= d.length) break;
  }
  fields.defaultLanguage = defaultLanguage;
  if (languages.length > 0) fields.languages = languages.join(', ');
  if (names.length > 0) fields.names = names.join('; ');
  return fields;
};

const frequencyList: DescriptorHandler = (_raw, d) => {
  const fields: DescriptorFields = {};
  // frequency_list_descriptor: centre frequencies in 10 Hz units.
  const frequencies: number[] = [];
  for (let i = 0; i + 4 <= d.length; i += 4) frequencies.push(readU32(d, i) * 10);
  fields.frequencies = frequencies.map((value) => String(value)).join(', ');
  fields.frequencyCount = frequencies.length;
  return fields;
};

const dataBroadcast: DescriptorHandler = (_raw, d) => ({
  dataBroadcastId: readU16(d, 0),
  componentTag: readU8(d, 2),
});

const caSystem: DescriptorHandler = (_raw, d) => {
  const systems: number[] = [];
  for (let i = 0; i + 2 <= d.length; i += 2) systems.push(readU16(d, i));
  const fields: DescriptorFields = {};
  if (systems.length > 0) fields.caSystemIds = systems.join(', ');
  return fields;
};

const dataBroadcastId: DescriptorHandler = (_raw, d) => {
  const ids: number[] = [];
  for (let i = 0; i + 2 <= d.length; i += 2) ids.push(readU16(d, i));
  const fields: DescriptorFields = {};
  if (ids.length > 0) fields.dataBroadcastIds = ids.join(', ');
  return fields;
};

const pdc: DescriptorHandler = (_raw, d) => {
  const fields: DescriptorFields = {};
  if (d.length >= 3) {
    const pil = (readU8(d, 0) << 16) + readU16(d, 1);
    fields.pil = pil;
    fields.pilHex = `0x${pil.toString(16).padStart(6, '0').toUpperCase()}`;
  }
  return fields;
};

const ancillaryData: DescriptorHandler = (_raw, d) => {
  const fields: DescriptorFields = {};
  fields.ancillaryIdentifier = readU8(d, 0);
  if (d.length > 1) fields.ancillaryData = hex(d, 1);
  return fields;
};

const serviceIdentifier: DescriptorHandler = (_raw, d) => {
  const services: number[] = [];
  for (let i = 0; i + 2 <= d.length; i += 2) services.push(readU16(d, i));
  const fields: DescriptorFields = {};
  if (services.length > 0) fields.serviceIds = services.join(', ');
  return fields;
};

const serviceAvailability: DescriptorHandler = (_raw, d) => {
  const fields: DescriptorFields = {};
  const flags = readU8(d, 0);
  fields.availabilityFlag = (flags & 0x80) !== 0;
  const cells: number[] = [];
  for (let i = 1; i + 2 <= d.length; i += 2) cells.push(readU16(d, i));
  if (cells.length > 0) fields.cellIds = cells.join(', ');
  return fields;
};

const defaultAuthority: DescriptorHandler = (_raw, d, context) => ({
  authority: context.decodeText(d),
});

const relatedContent: DescriptorHandler = (_raw, d) => {
  const entries: string[] = [];
  const count = readU8(d, 0);
  let cursor = 1;
  for (let i = 0; i < count && cursor + 8 <= d.length; i += 1) {
    entries.push(
      `${readU16(d, cursor)}/${readU16(d, cursor + 2)}/${readU16(d, cursor + 4)}/${readU16(d, cursor + 6)}`,
    );
    cursor += 8;
  }
  return { relatedContent: entries.join(', ') };
};

const tvaId: DescriptorHandler = (_raw, d) => {
  const ids: number[] = [];
  for (let i = 0; i + 2 <= d.length; i += 2) ids.push(readU16(d, i));
  const fields: DescriptorFields = {};
  if (ids.length > 0) fields.tvaIds = ids.join(', ');
  return fields;
};

const contentIdentifier: DescriptorHandler = (_raw, d) => {
  // content_identifier_descriptor: CRID entries.
  const crids: string[] = [];
  let cursor = 0;
  while (cursor + 2 <= d.length) {
    const flags = readU8(d, cursor);
    cursor += 1;
    const location = flags & 0x03;
    if (location === 0) {
      const length = readU8(d, cursor);
      cursor += 1;
      crids.push(ascii(d.subarray(cursor, cursor + length)));
      cursor += length;
    } else if (location === 1) {
      crids.push(`ref:${readU16(d, cursor)}`);
      cursor += 2;
    } else {
      break;
    }
  }
  return crids.length > 0 ? { crids: crids.join(', ') } : ({} as DescriptorFields);
};

const series: DescriptorHandler = (_raw, d, context) => {
  const fields: DescriptorFields = {};
  // series_descriptor (EN 300 468, 6.2.45).
  if (d.length >= 3) {
    fields.seriesId = readU16(d, 0);
    fields.repeatLabel = (readU8(d, 2) >> 4) & 0x0f;
    fields.programmePattern = (readU8(d, 2) >> 1) & 0x07;
    fields.expired = (readU8(d, 2) & 0x01) !== 0;
    if (d.length >= 4) {
      const nameLength = readU8(d, 3);
      fields.seriesName = context.decodeText(d.subarray(4, 4 + nameLength));
    }
  }
  return fields;
};

const s2Delivery: DescriptorHandler = (_raw, d, context) => {
  const fields: DescriptorFields = {};
  // S2_delivery_system_descriptor (EN 300 468, 6.2.13.4).
  const scramblingSelector = context.readBits(d, 0, 1) !== 0;
  let bit = 1;
  fields.scramblingSequenceSelector = scramblingSelector;
  if (scramblingSelector) {
    bit += 5;
    fields.scramblingSequenceIndex = context.readBits(d, bit, 18);
    bit += 18;
  }
  bit += 2;
  fields.tsis = context.readBits(d, bit, 1);
  bit += 1;
  const multipleInputStream = context.readBits(d, bit, 1) !== 0;
  bit += 1;
  if (multipleInputStream) {
    fields.inputStreamIdentifier = context.readBits(d, bit, 8);
    bit += 8;
  }
  bit += 2;
  const rollOff = context.readBits(d, bit, 2);
  bit += 2;
  fields.rollOff = rollOff;
  fields.rollOffName = nameOr(rollOff, ROLL_OFF_NAMES);
  fields.symbolRate = context.readBits(d, bit, 28) * 100;
  bit += 28;
  bit += 4;
  const modulation = context.readBits(d, bit, 4);
  fields.modulation = modulation;
  fields.modulationName = nameOr(modulation, SATELLITE_MODULATION_NAMES);
  return fields;
};

export const dvbHandlers: Record<number, DescriptorHandler> = {
  0x05: formatIdentifier,
  0x09: ca,
  0x13: carouselIdentifier,
  0x14: associationTag,
  0x40: nameText,
  0x47: nameText,
  0xd8: nameText,
  0x41: serviceList,
  0x43: satelliteDelivery,
  0x44: cableDelivery,
  0x48: service,
  0x4a: linkage,
  0x4b: nvodReference,
  0x4c: referenceServiceId,
  0x60: referenceServiceId,
  0x4d: shortEvent,
  0x4e: extendedEvent,
  0x4f: timeShiftedEvent,
  0x50: component,
  0x52: streamIdentifier,
  0x53: caIdentifier,
  0x54: content,
  0x55: parentalRating,
  0x58: localTimeOffset,
  0x5a: terrestrialDelivery,
  0x5b: multilingual,
  0x5c: multilingual,
  0x5d: multilingual,
  0x5e: multilingual,
  0x62: frequencyList,
  0x64: dataBroadcast,
  0x65: caSystem,
  0x66: dataBroadcastId,
  0x69: pdc,
  0x6b: ancillaryData,
  0x71: serviceIdentifier,
  0x72: serviceAvailability,
  0x73: defaultAuthority,
  0x74: relatedContent,
  0x75: tvaId,
  0x76: contentIdentifier,
  0xd5: series,
  0x79: s2Delivery,
};
