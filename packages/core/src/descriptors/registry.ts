import type { RawDescriptor } from './descriptor.js';
import { audioHandlers } from './handlers/audio.js';
import { atscHandlers } from './handlers/atsc.js';
import { dvbHandlers } from './handlers/dvb.js';
import { otherHandlers } from './handlers/other.js';
import { subtitleHandlers } from './handlers/subtitle.js';

/** Field bag produced by a descriptor handler, merged into DescriptorInfo.fields. */
export type DescriptorFields = Record<string, string | number | boolean>;

/** Read-only helpers a handler may need; supplied by describeDescriptor. */
export interface DescriptorContext {
  decodeText: (value: Uint8Array) => string;
  readU32: (data: Uint8Array, offset: number) => number;
  readBits: (data: Uint8Array, bitOffset: number, count: number) => number;
}

/** Handles exactly the branch body of one descriptor tag. */
export interface DescriptorHandler {
  (raw: RawDescriptor, data: Uint8Array, context: DescriptorContext): DescriptorFields;
}

export const DESCRIPTOR_HANDLERS: Partial<Record<number, DescriptorHandler>> = {
  ...audioHandlers,
  ...subtitleHandlers,
  ...dvbHandlers,
  ...atscHandlers,
  ...otherHandlers,
};
