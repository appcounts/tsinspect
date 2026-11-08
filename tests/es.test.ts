import { describe, expect, it } from 'vitest';
import {
  crc32Mpeg2,
  describeDescriptor,
  parseAc3,
  parseAc4,
  parseAdts,
  parseDts,
  parseH264,
  parseH265,
  parseLatm,
  parseMpeg2Video,
  parseScte35Section,
} from '@tsinspect/core';
import { BitWriter, concat } from './helpers.js';

function bytes(hex: string): Uint8Array {
  return Uint8Array.from(
    hex
      .trim()
      .split(/\s+/)
      .map((part) => Number.parseInt(part, 16)),
  );
}

describe('elementary stream metadata', () => {
  it('parses an MPEG-2 sequence header', () => {
    const stream = parseMpeg2Video(bytes('00 00 01 B3 2D 01 E0 34 00 00 00 00'));
    expect(stream?.codec).toBe('MPEG-2 Video');
    expect(stream?.width).toBe(720);
    expect(stream?.height).toBe(480);
    expect(stream?.aspectRatio).toBe('16:9');
    expect(stream?.frameRate).toBe(29.97);
  });

  it('parses an H.264 SPS from a real broadcast stream', () => {
    const stream = parseH264(
      bytes(
        '00 00 01 67 64 00 28 AD 90 A4 70 80 32 0B 8D 06 00 E8 3A 40 E7 21 20 83 03 47 FC 8C 11 08 08 12 14 24 A1 01 02 41 46 FF F4 D1 02 01 14 E8 3C 13 3B 10 16 1A 39 0B 12 32 20 70 E1 61 32 05 02 63 E1 60 F0 66 38 CA C1 58 E0 4C 20 58 D0 A0 74 41 8E 2C C5 01 E0 11 3F 78 0F 08 08 08 0F 80 00 00 03 00 80 00 00 19 4A 00',
      ),
    );
    expect(stream?.codec).toBe('AVC / H.264');
    expect(stream?.profile).toBe('High');
    expect(stream?.level).toBe('4.0');
    expect(stream?.width).toBe(1920);
    expect(stream?.height).toBe(1080);
    expect(stream?.frameRate).toBe(25);
  });

  it('parses a HEVC SPS', () => {
    const stream = parseH265(
      bytes(
        '00 00 00 01 42 01 01 01 40 00 00 03 00 00 03 00 00 03 00 00 03 00 5D A0 02 80 80 2E 1F 13 96 BB 90 84 64 B8 9A 80 00 02 82 00 00 03 00 02 00 00 03 00 28 10 24 00 00 13 80 60 00 02 8A 0B 96 2E 00 00 00 02',
      ),
    );
    expect(stream?.codec).toBe('HEVC / H.265');
    expect(stream?.profile).toBe('Main');
    expect(stream?.level).toBe('3.1');
    expect(stream?.width).toBe(1280);
    expect(stream?.height).toBe(720);
  });

  it('parses AAC ADTS and AC-3/E-AC-3 syncframes', () => {
    const aac = parseAdts(bytes('FF F1 50 80 01 1F FC'));
    expect(aac?.codec).toBe('AAC (ADTS)');
    expect(aac?.sampleRate).toBe(44100);
    expect(aac?.channels).toBe(2);

    const ac3 = parseAc3(bytes('0B 77 00 00 00 00 00 00'));
    expect(ac3?.codec).toBe('AC-3');
    expect(ac3?.sampleRate).toBe(48000);
    expect(ac3?.channels).toBe(2);

    const eac3 = parseAc3(bytes('0B 77 00 FF 34 85 E0 28'));
    expect(eac3?.codec).toBe('E-AC-3');
    expect(eac3?.sampleRate).toBe(48000);
    expect(eac3?.channels).toBe(2);
  });

  it('parses a LATM StreamMuxConfig from an ISDB-Tb stream', () => {
    // LOAS sync + length 516, then useSameStreamMux=0 and a StreamMuxConfig
    // carrying explicit HE-AAC (AOT 5, 24 kHz core, stereo, 48 kHz output).
    const payload = new Uint8Array(3 + 516);
    payload.set(bytes('56 E2 04 20 00 2B 11 88 00 03'), 0);
    const latm = parseLatm(payload);
    expect(latm?.codec).toBe('AAC (LATM)');
    expect(latm?.profile).toBe('HE-AAC');
    expect(latm?.sampleRate).toBe(48000);
    expect(latm?.channels).toBe(2);
  });

  it('parses a DTS core frame header', () => {
    const dts = parseDts(dtsFrame({ amode: 9, lfe: 1, frameSize: 1000 }));
    expect(dts?.codec).toBe('DTS');
    expect(dts?.profile).toBe('Core');
    expect(dts?.sampleRate).toBe(48000);
    expect(dts?.channels).toBe(6); // 5.0 layout + LFE
    expect(dts?.bitrateBps).toBe(750_000);
    expect(dts?.format).toBe('DTS');
  });

  it('rejects a DTS sync word with a reserved sample-rate code', () => {
    expect(parseDts(dtsFrame({ sfreq: 4 }))).toBeUndefined();
  });

  it('parses an AC-4 sync frame with a stereo v0 presentation', () => {
    const ac4 = parseAc4(ac4Frame(0));
    expect(ac4?.codec).toBe('AC-4');
    expect(ac4?.profile).toBe('bitstream v0');
    expect(ac4?.sampleRate).toBe(48000);
    expect(ac4?.channels).toBe(2);
    expect(ac4?.frameRate).toBe(25);
    expect(ac4?.bitrateBps).toBe(6 * 8 * 25);
  });

  it('reports AC-4 v2 at header level without channel layout', () => {
    const ac4 = parseAc4(ac4Frame(2));
    expect(ac4?.codec).toBe('AC-4');
    expect(ac4?.profile).toBe('bitstream v2');
    expect(ac4?.sampleRate).toBe(48000);
    expect(ac4?.channels).toBeUndefined();
    expect(ac4?.frameRate).toBe(25);
  });
});

describe('descriptor fields', () => {
  it('parses the DVB DTS descriptor (0x7B)', () => {
    const writer = new BitWriter();
    writer.write(13, 4); // sample_rate_code: 48 kHz
    writer.write(16, 6); // bit_rate_code: 960 kb/s
    writer.write(15, 7); // nblks
    writer.write(999, 14); // fsize
    writer.write(9, 6); // surround_mode: 5 / C+L+R+SL+SR
    writer.bit(true); // lfe
    writer.write(2, 2); // discrete extended surround
    const data = writer.bytes();
    const info = describeDescriptor({ tag: 0x7b, length: data.length, data });
    expect(info.name).toBe('DTS');
    expect(info.fields?.sampleRate).toBe(48000);
    expect(info.fields?.bitRate).toBe(960_000);
    expect(info.fields?.nblks).toBe(15);
    expect(info.fields?.frameSize).toBe(999);
    expect(info.fields?.surroundMode).toBe(9);
    expect(info.fields?.channels).toBe(6);
    expect(info.fields?.lfe).toBe(true);
    expect(info.fields?.extendedSurround).toBe(2);
  });

  it('parses the DVB AC-4 extension descriptor (0x7F/0x15)', () => {
    const data = bytes('15 C0 C0 02 AA BB CC');
    const info = describeDescriptor({ tag: 0x7f, length: data.length, data });
    expect(info.name).toBe('AC-4');
    expect(info.fields?.extensionTag).toBe(0x15);
    expect(info.fields?.ac4ConfigFlag).toBe(true);
    expect(info.fields?.ac4TocFlag).toBe(true);
    expect(info.fields?.dialogEnhancementEnabled).toBe(true);
    expect(info.fields?.channelMode).toBe(2);
    expect(info.fields?.channelModeName).toBe('Multichannel');
    expect(info.fields?.tocLength).toBe(2);
    expect(info.fields?.toc).toBe('AA BB');
    expect(info.fields?.additionalInfo).toBe('CC');
  });
});

describe('SCTE-35 sections', () => {
  // splice_insert, event 123, out-of-network, break_duration 10 s, auto-return.
  const SPLICE_INSERT = bytes(
    'fc 30 25 00 00 00 00 00 00 00 ff f0 14 05 00 00 00 7b 7f ef fe 00 31 58 ' +
      'd0 fe 00 0d bb a0 00 01 00 00 00 00 63 27 90 9a',
  );

  // time_signal with a Break start segmentation descriptor (20 s).
  const TIME_SIGNAL = bytes(
    'fc 30 2c 00 00 00 00 00 00 00 ff f0 05 06 fe 00 06 0a e0 00 16 02 14 ' +
      '43 55 45 49 00 00 05 39 7f ff 00 00 1b 77 40 00 00 22 00 00 7e 3b f0 a1',
  );

  function withUnknownCommandLength(section: Uint8Array): Uint8Array {
    const out = Uint8Array.from(section);
    out[10] = 0xff;
    out[11] = 0xff;
    out[12] = 0xff;
    const crc = crc32Mpeg2(out.subarray(0, out.length - 4));
    const at = out.length - 4;
    out[at] = (crc >>> 24) & 0xff;
    out[at + 1] = (crc >>> 16) & 0xff;
    out[at + 2] = (crc >>> 8) & 0xff;
    out[at + 3] = crc & 0xff;
    return out;
  }

  it('parses a command whose length field is 0xFFF', () => {
    const section = parseScte35Section(withUnknownCommandLength(SPLICE_INSERT));

    expect(section?.commandLength).toBe(0xfff);
    expect(section?.commandName).toBe('splice_insert');
    expect(section?.eventId).toBe(123);
    expect(section?.breakDuration).toBe(900_000);
    expect(section?.descriptors).toEqual([]);
  });

  it('names SCTE-35 descriptors in their own namespace', () => {
    const section = parseScte35Section(TIME_SIGNAL);
    const descriptorInfo = section?.descriptors[0];

    expect(descriptorInfo?.tagHex).toBe('0x02');
    expect(descriptorInfo?.name).toBe('segmentation_descriptor');
    expect(descriptorInfo?.fields?.eventId).toBe(0x539);
    expect(section?.segmentation?.identifier).toBe('CUEI');
    expect(section?.segmentation?.typeName).toBe('Break start');
  });
});

function dtsFrame({
  amode = 2,
  sfreq = 13,
  lfe = 0,
  frameSize = 512,
}: {
  amode?: number;
  sfreq?: number;
  lfe?: number;
  frameSize?: number;
} = {}): Uint8Array {
  const writer = new BitWriter();
  writer.write(0x7ffe8001, 32); // sync
  writer.bit(true); // normal frame
  writer.write(31, 5); // deficit samples -> 32
  writer.bit(false); // no CRC
  writer.write(15, 7); // 16 PCM blocks
  writer.write(frameSize - 1, 14);
  writer.write(amode, 6);
  writer.write(sfreq, 4);
  writer.write(16, 5); // 960 kb/s nominal
  writer.bit(false); // reserved
  writer.write(0, 9); // dyn/time/aux/hdcd/ext id/ext/aspf
  writer.write(lfe, 2);
  // The scanner requires 12 bytes even though the fields above use 11.
  return concat([writer.bytes(), new Uint8Array(2)]);
}

function ac4Frame(bitstreamVersion: number): Uint8Array {
  const writer = new BitWriter();
  writer.write(bitstreamVersion, 2);
  writer.write(0x155, 10); // sequence_counter
  writer.bit(false); // b_wait_frames
  writer.bit(true); // fs_index = 48 kHz base
  writer.write(2, 4); // frame_rate_index = 25 fps
  writer.bit(false); // b_iframe_global
  writer.bit(true); // b_single_presentation
  writer.bit(false); // b_payload_base
  if (bitstreamVersion <= 1) {
    writer.bit(true); // b_single_substream
    writer.bit(false); // presentation_version terminator
    writer.write(0, 3); // md_compat
    writer.bit(false); // b_belongs_to_presentation_id
    writer.bit(false); // b_multiplier
    writer.write(0, 2); // emdf_version
    writer.write(0, 3); // key_id
    writer.bit(false); // b_emdf_payloads_substream_info
    writer.bit(false); // b_more_bits
    writer.bit(true); // channel_mode: 1 -> stereo
    writer.bit(false);
    writer.bit(false); // b_sf_multiplier
    writer.bit(false); // b_bitrate_info
    writer.bit(false); // b_content_type
    writer.bit(false); // b_iframe
    writer.write(0, 2); // substream_index
    writer.bit(false); // b_pre_virtualized
    writer.bit(false); // reserved
  }
  const toc = writer.bytes();
  const frame = new Uint8Array(4 + toc.length);
  frame[0] = 0xac;
  frame[1] = 0x40;
  frame[2] = (toc.length >> 8) & 0xff;
  frame[3] = toc.length & 0xff;
  frame.set(toc, 4);
  return frame;
}
