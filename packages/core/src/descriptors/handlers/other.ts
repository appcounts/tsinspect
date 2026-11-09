import { hex, readU8, readU16 } from '../../util/bytes.js';
import { ascii } from '../dvb-string.js';
import { dataComponentName } from '../names.js';
import type { DescriptorFields, DescriptorHandler } from '../registry.js';

const tsInformation: DescriptorHandler = (_raw, d, context) => {
  const fields: DescriptorFields = {};
  // ISDB TS information descriptor (ARIB STD-B10, 6.2.26).
  if (d.length >= 8) {
    fields.remoteControlKeyId = readU8(d, 0) >> 4;
    fields.transmissionType = readU8(d, 0) & 0x0f;
    fields.originalNetworkId = readU16(d, 1);
    fields.transportStreamId = readU16(d, 3);
    fields.serviceId = readU16(d, 5);
    const nameLength = readU8(d, 7);
    fields.tsName = context.decodeText(d.subarray(8, 8 + nameLength));
  }
  return fields;
};

const extendedEvent: DescriptorHandler = (_raw, d, context) => {
  const fields: DescriptorFields = {};
  // ISDB extended event descriptor (ARIB STD-B10, 6.2.13). The layout
  // mirrors the DVB extended_event_descriptor but the text is ARIB coded.
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

const partialReception: DescriptorHandler = (_raw, d) => {
  const fields: DescriptorFields = {};
  // ISDB partial reception descriptor (ARIB STD-B10, 6.2.29).
  if (d.length >= 4) {
    fields.startServiceId = readU16(d, 0);
    fields.endServiceId = readU16(d, 2);
    if (d.length >= 5) fields.label = readU8(d, 4);
  }
  return fields;
};

const hierarchy: DescriptorHandler = (_raw, d) => {
  const fields: DescriptorFields = {};
  // ISDB hierarchy descriptor (ARIB STD-B10, 6.2.30).
  if (d.length >= 1) {
    fields.hierarchyType = readU8(d, 0) >> 4;
    if (d.length >= 2) fields.layerIndex = (readU8(d, 1) >> 5) & 0x07;
  }
  return fields;
};

const dataContent: DescriptorHandler = (_raw, d) => {
  const fields: DescriptorFields = {};
  // ISDB data content descriptor (ARIB STD-B10, 6.2.32).
  if (d.length >= 2) {
    fields.dataComponentId = readU16(d, 0);
    if (d.length >= 3) fields.entryComponent = readU8(d, 2);
    if (d.length > 3) fields.additionalInfo = hex(d, 3);
  }
  return fields;
};

const videoEncodeControl: DescriptorHandler = (_raw, d) => {
  // ISDB video encode control descriptor (ARIB STD-B10, 6.2.33).
  const fields: DescriptorFields = {};
  if (d.length >= 1) fields.profileAndLevel = readU8(d, 0);
  return fields;
};

const stillPicture: DescriptorHandler = (_raw, d) => {
  // ISDB still picture descriptor (ARIB STD-B10, 6.2.34).
  const fields: DescriptorFields = {};
  if (d.length >= 1) fields.stillPictureId = readU8(d, 0);
  return fields;
};

const digitalCopyControl: DescriptorHandler = (_raw, d) => ({
  recordingControl: readU8(d, 0) >> 6,
  maximumBitrate: d.length >= 2 ? readU8(d, 1) : 0,
});

const videoDecodeControl: DescriptorHandler = (_raw, d) => ({
  stillPicture: (readU8(d, 0) & 0x80) !== 0,
  sequenceEnd: (readU8(d, 0) & 0x40) !== 0,
  videoEncodeFormat: (readU8(d, 0) >> 2) & 0x0f,
});

const accessControl: DescriptorHandler = (_raw, d) => ({
  caSystemId: readU16(d, 0),
  transmissionType: readU8(d, 2),
  ecmPid: readU16(d, 3) & 0x1fff,
});

const dataComponent: DescriptorHandler = (_raw, d) => {
  const fields: DescriptorFields = {};
  fields.dataComponentId = readU16(d, 0);
  fields.dataComponentName = dataComponentName(fields.dataComponentId);
  fields.additionalInfoLength = Math.max(0, d.length - 2);
  if (d.length > 2) fields.additionalInfo = hex(d, 2);
  return fields;
};

export const otherHandlers: Record<number, DescriptorHandler> = {
  0xc1: digitalCopyControl,
  0xc3: tsInformation,
  0xc4: extendedEvent,
  0xc6: partialReception,
  0xc7: hierarchy,
  0xc8: videoDecodeControl,
  0xc9: dataContent,
  0xca: videoEncodeControl,
  0xcb: stillPicture,
  0xf6: accessControl,
  0xfd: dataComponent,
};
