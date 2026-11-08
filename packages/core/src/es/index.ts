import type { EsMetadata } from '../model/types.js';
import { parseAc3, parseAc4, parseAdts, parseDts, parseLatm, parseMpegAudio } from './audio.js';
import { parseH264, parseH265, parseMpeg2Video } from './video.js';

/**
 * Parse the first PES payload of an elementary stream using the PMT stream
 * type as a hint. Falls back to trying common video and audio sync words.
 *
 * `descriptorExtensions` carries the first byte of tag 0x7F extension
 * descriptors so private AC-4 PES streams can be recognised.
 */
export function parseEsMetadata(
  streamType: number,
  payload: Uint8Array,
  descriptorTags?: Set<number>,
  descriptorExtensions?: Set<number>,
): EsMetadata | undefined {
  if (streamType === 0x06) {
    if (descriptorExtensions?.has(0x15)) return parseAc4(payload) ?? tryFallback(payload);
    if (descriptorTags?.has(0x7b)) return parseDts(payload) ?? tryFallback(payload);
    if (descriptorTags?.has(0x6a) || descriptorTags?.has(0x7a)) return parseAc3(payload);
    if (descriptorTags?.has(0x7c)) return parseLatm(payload) ?? parseAdts(payload);
    return tryFallback(payload);
  }
  switch (streamType) {
    case 0x01:
    case 0x02:
      return parseMpeg2Video(payload);
    case 0x1b:
    case 0x1f:
    case 0x20:
      return parseH264(payload);
    case 0x24:
    case 0x25:
    case 0x26:
    case 0x28:
    case 0x29:
    case 0x2a:
    case 0x2b:
      return parseH265(payload);
    case 0x03:
    case 0x04:
      return parseMpegAudio(payload);
    case 0x0f:
      return parseAdts(payload);
    case 0x11:
    case 0x1c:
      return parseLatm(payload);
    case 0x81:
    case 0x84:
    case 0x87:
    case 0x88:
      return parseAc3(payload);
    case 0x85:
    case 0x8a:
      return parseDts(payload);
    default:
      return tryFallback(payload);
  }
}

function tryFallback(payload: Uint8Array): EsMetadata | undefined {
  return (
    parseAc3(payload) ??
    parseAc4(payload) ??
    parseDts(payload) ??
    parseLatm(payload) ??
    parseAdts(payload) ??
    parseMpegAudio(payload) ??
    parseMpeg2Video(payload) ??
    parseH264(payload) ??
    parseH265(payload)
  );
}
