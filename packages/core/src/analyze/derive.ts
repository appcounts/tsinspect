import type {
  DescriptorInfo,
  EsMetadata,
  ProbeEvent,
  ProbePid,
  ProbeRatingRegion,
  ProbeResult,
  ProbeService,
  ProbeStream,
  Standard,
} from '../model/types.js';
import { isSectionCrcValid } from '../section/crc32.js';
import { tableName } from '../tables/common.js';
import type { PmtSection } from '../tables/pmt.js';
import type { AtscChannel } from '../tables/psip.js';
import type { SdtService } from '../tables/sdt.js';
import { pidKind, streamTypeName } from '../ts/packet.js';
import { hex16, readU16 } from '../util/bytes.js';
import type { MutablePidStat, SectionInfo } from './internal.js';

const ATSC_TABLE_IDS = new Set([0xc7, 0xc8, 0xc9, 0xca, 0xcb, 0xcc, 0xcd]);
const ISDB_TABLE_IDS = new Set([0xc3, 0xc4, 0xc5, 0xc6]);
const ATSC_DESCRIPTOR_TAGS = new Set([0x81, 0x86, 0x87, 0xa0, 0xa1, 0xa2, 0xa3]);
const ISDB_DESCRIPTOR_TAGS = new Set([0xc1, 0xc8, 0xc9, 0xca, 0xcb, 0xf6]);
const DVB_DESCRIPTOR_TAGS = new Set([
  0x40, 0x41, 0x47, 0x48, 0x4d, 0x4e, 0x50, 0x54, 0x55, 0x56, 0x58, 0x59, 0x5a, 0x62, 0x6a, 0x7a,
  0x7c,
]);

export function inspectSection(data: Uint8Array): SectionInfo | null {
  if (data.length < 3) return null;
  const tableId = data[0] as number;
  if (tableId === 0xff) return null;
  const b1 = data[1] as number;
  const sectionLength = ((b1 & 0x0f) << 8) | (data[2] as number);
  if (3 + sectionLength !== data.length) return null;
  const long = (b1 & 0x80) !== 0;

  if (!long) {
    return {
      tableId,
      mode: 'short',
      length: data.length,
      ...(tableId === 0x73 && data.length >= 4 ? { crcValid: isSectionCrcValid(data) } : {}),
    };
  }

  if (data.length < 12) return null;
  return {
    tableId,
    tableIdExtension: readU16(data, 3),
    version: ((data[5] as number) >> 1) & 0x1f,
    currentNext: ((data[5] as number) & 0x01) !== 0,
    sectionNumber: data[6] as number,
    lastSectionNumber: data[7] as number,
    crcValid: isSectionCrcValid(data),
    mode: 'long',
    length: data.length,
  };
}

export function dedupeStreams(streams: PmtSection['streams']): PmtSection['streams'] {
  const map = new Map<number, PmtSection['streams'][number]>();
  for (const stream of streams) map.set(stream.pid, stream);
  return [...map.values()];
}

export function summarizeEventDescriptors(
  descriptors: DescriptorInfo[],
): Pick<
  ProbeEvent,
  'content' | 'rating' | 'languages' | 'items' | 'seriesId' | 'seriesName' | 'linkage'
> {
  const contentDescriptor = descriptors.find((descriptor) => descriptor.tag === 0x54);
  const ratingDescriptor = descriptors.find((descriptor) => descriptor.tag === 0x55);
  const content = contentDescriptor?.fields?.contentName ?? contentDescriptor?.fields?.content;
  const rating = ratingDescriptor?.fields?.ratingSummary ?? ratingDescriptor?.fields?.ratings;
  const languages = new Set<string>();

  for (const descriptor of descriptors) {
    if (descriptor.tag === 0x4d || descriptor.tag === 0x4e) {
      const language = descriptor.fields?.language;
      if (typeof language === 'string' && language.trim().length > 0) {
        languages.add(language.trim());
      }
    }
    const list = descriptor.fields?.languages;
    if (typeof list === 'string') {
      for (const part of list.split(',')) {
        const code = part.trim().split(/\s+/)[0];
        if (code !== undefined && code.length > 0 && code !== 'undefined') languages.add(code);
      }
    }
  }

  const extended = descriptors.find((descriptor) => descriptor.tag === 0x4e);
  const itemsField = extended?.fields?.items;
  const items =
    typeof itemsField === 'string'
      ? itemsField
          .split(';')
          .map((item) => item.trim())
          .filter((item) => item.length > 0)
      : undefined;

  const series = descriptors.find((descriptor) => descriptor.tag === 0xd5);
  const seriesId =
    typeof series?.fields?.seriesId === 'number' ? series.fields.seriesId : undefined;
  const seriesName =
    typeof series?.fields?.seriesName === 'string' ? series.fields.seriesName : undefined;

  const linkageDescriptor = descriptors.find((descriptor) => descriptor.tag === 0x4a);
  const linkage = linkageDescriptor
    ? `${linkageDescriptor.fields?.linkageTypeName ?? 'linkage'} TS ${
        linkageDescriptor.fields?.transportStreamId ?? '-'
      } service ${linkageDescriptor.fields?.serviceId ?? '-'}`
    : undefined;

  return {
    ...(content !== undefined ? { content: String(content) } : {}),
    ...(rating !== undefined ? { rating: String(rating) } : {}),
    ...(languages.size > 0 ? { languages: [...languages] } : {}),
    ...(items !== undefined && items.length > 0 ? { items } : {}),
    ...(seriesId !== undefined ? { seriesId } : {}),
    ...(seriesName !== undefined ? { seriesName } : {}),
    ...(linkage !== undefined ? { linkage } : {}),
  };
}

export function applyAtscAdvisories(events: ProbeEvent[], regions: ProbeRatingRegion[]): void {
  const regionById = new Map(regions.map((region) => [region.ratingRegion, region]));
  const heading = (regionId: number): string => {
    const region = regionById.get(regionId);
    if (!region) return `RRT${regionId} (region not in sample)`;
    const name = region.name?.trim();
    return name ? `RRT${regionId} (${name})` : `RRT${regionId}`;
  };

  for (const event of events) {
    if (event.rating) continue;
    const advisory = event.descriptors.find((descriptor) => descriptor.tag === 0x87);
    if (!advisory) continue;

    // entries are "region/dimension/value" triples, so each value can be
    // resolved against the RRT of its own region.
    const rated = new Map<number, Array<[number, number]>>();
    const raw = typeof advisory.fields?.ratings === 'string' ? advisory.fields.ratings : '';
    for (const entry of raw.split(',')) {
      const match = /^\s*(\d+)\/(\d+)\/(\d+)\s*$/.exec(entry);
      if (!match) continue;
      const regionId = Number(match[1]);
      const list = rated.get(regionId) ?? [];
      list.push([Number(match[2]), Number(match[3])]);
      rated.set(regionId, list);
    }

    const description =
      typeof advisory.fields?.ratingDescription === 'string'
        ? advisory.fields.ratingDescription.trim()
        : '';
    const fallbackRegion =
      typeof advisory.fields?.ratingRegion === 'number' ? advisory.fields.ratingRegion : undefined;
    if (rated.size === 0 && description.length === 0) continue;

    const parts: string[] = [];
    for (const [regionId, pairs] of rated) {
      const region = regionById.get(regionId);
      const labels = pairs.map(([dimensionIndex, valueIndex]) => {
        const dimension = region?.dimensions[dimensionIndex];
        const value = dimension?.values[valueIndex];
        const label = value?.abbrev || value?.text;
        const dimensionName = dimension?.name?.trim();
        return `${dimensionName || `dimension ${dimensionIndex}`} = ${
          label || `value ${valueIndex}`
        }`;
      });
      parts.push(`${heading(regionId)}: ${labels.join(', ')}`);
    }
    if (description.length > 0) {
      parts.push(
        rated.size === 0 && fallbackRegion !== undefined
          ? `${heading(fallbackRegion)}: ${description}`
          : description,
      );
    }
    if (parts.length === 0) continue;
    event.rating = parts.join('; ');
  }
}

export function choosePcrPid(
  pmtByProgram: Map<number, PmtSection>,
  pcrPidCounts: Map<number, number>,
): number | undefined {
  for (const pmt of pmtByProgram.values()) {
    if (pmt.pcrPid !== 0x1fff && pcrPidCounts.has(pmt.pcrPid)) return pmt.pcrPid;
  }
  let best: number | undefined;
  let bestCount = 0;
  for (const [pid, count] of pcrPidCounts) {
    if (count > bestCount) {
      best = pid;
      bestCount = count;
    }
  }
  return best;
}

export function parseLocalOffset(value: string | number | boolean | undefined): number | undefined {
  if (typeof value !== 'string') return undefined;
  const match = /^([+-])(\d{2}):(\d{2})$/.exec(value);
  if (!match) return undefined;
  const seconds = Number(match[2]) * 3600 + Number(match[3]) * 60;
  return match[1] === '-' ? -seconds : seconds;
}

function descriptorLanguage(descriptors: ProbeStream['descriptors']): string | undefined {
  for (const descriptor of descriptors) {
    const fields = descriptor.fields ?? {};
    if (typeof fields.language === 'string') return fields.language;
    if (typeof fields.languages === 'string') {
      return fields.languages.split(',')[0]?.trim();
    }
  }
  return undefined;
}

function channelModeName(channels: number): string {
  if (channels === 1) return 'mono';
  if (channels === 2) return 'stereo';
  if (channels === 6) return '5.1';
  if (channels === 8) return '7.1';
  return `${channels} ch`;
}

function formatNumber(value: number, maximumFractionDigits = 3): string {
  return value.toLocaleString('en-US', { maximumFractionDigits });
}

function streamDescriptionDetails(stream: ProbeStream): string | undefined {
  const es = stream.es;
  if (!es) return undefined;
  const parts: string[] = [];
  if (es.kind === 'video') {
    if (es.width !== undefined && es.height !== undefined) {
      parts.push(`${es.width}x${es.height}${es.interlaced ? 'i' : 'p'}`);
    }
    if (es.frameRate !== undefined) parts.push(`@${formatNumber(es.frameRate)} Hz`);
    if (es.aspectRatio !== undefined) parts.push(es.aspectRatio);
    const profileLevel = [es.profile, es.level].filter(Boolean).join('/');
    if (profileLevel.length > 0) parts.push(profileLevel);
  } else if (es.kind === 'audio') {
    const language = descriptorLanguage(stream.descriptors);
    if (language !== undefined) parts.push(language);
    if (es.codec !== undefined) parts.push(es.codec);
    if (es.channels !== undefined) parts.push(channelModeName(es.channels));
    if (es.sampleRate !== undefined) parts.push(`@${formatNumber(es.sampleRate, 0)} Hz`);
    const ac3 = stream.descriptors.find((descriptor) => descriptor.tag === 0x81)?.fields;
    if (typeof ac3?.audioServiceTypeName === 'string') {
      parts.push(ac3.audioServiceTypeName);
    }
    if (typeof ac3?.bsid === 'number') parts.push(`bsid ${ac3.bsid}`);
    const supplementary = stream.descriptors.find(
      (descriptor) => descriptor.tag === 0x7f && descriptor.fields?.extensionTag === 0x06,
    )?.fields;
    if (typeof supplementary?.editorialClassificationName === 'string') {
      parts.push(supplementary.editorialClassificationName);
    }
  } else if (es.kind === 'subtitle') {
    const language = descriptorLanguage(stream.descriptors);
    if (language !== undefined) parts.push(language);
    if (es.codec !== undefined) parts.push(es.codec);
  }
  return parts.length > 0 ? parts.join(', ') : undefined;
}

function dvbServiceTypeName(type: number): string {
  switch (type) {
    case 0x01:
      return 'digital television';
    case 0x02:
      return 'digital radio';
    case 0x03:
      return 'teletext';
    case 0x04:
      return 'NVOD reference';
    case 0x05:
      return 'NVOD time-shifted';
    case 0x06:
      return 'mosaic';
    case 0x07:
      return 'FM radio';
    case 0x08:
      return 'DVB SRM';
    case 0x09:
      return 'advanced codec digital radio';
    case 0x0a:
      return 'advanced codec mosaic';
    case 0x0b:
      return 'advanced codec data broadcast';
    case 0x16:
      return 'AVC digital television';
    case 0x19:
      return 'HEVC digital television';
    case 0x1f:
      return 'HEVC UHD digital television';
    case 0xc0:
      return 'ISDB data service';
    default:
      return `service type 0x${type.toString(16).padStart(2, '0')}`;
  }
}

export function buildServices(
  patPrograms: Map<number, number>,
  pmtByProgram: Map<number, PmtSection>,
  sdtServicesById: Map<number, SdtService>,
  atscChannels: Map<number, AtscChannel>,
  esByPid: Map<number, EsMetadata>,
  stats: Map<number, MutablePidStat>,
  packetSize: number,
  durationSec: number | undefined,
  tsid: number | undefined,
  t2miPids: Set<number>,
  ssuSignalled: boolean,
  caBySystem: Map<number, { ecm: Set<number>; emm: Set<number> }>,
): ProbeService[] {
  const services: ProbeService[] = [];
  const programNumbers = new Set<number>([
    ...patPrograms.keys(),
    ...pmtByProgram.keys(),
    ...atscChannels.keys(),
  ]);

  for (const programNumber of programNumbers) {
    const pmt = pmtByProgram.get(programNumber);
    const sdt = sdtServicesById.get(programNumber);
    const vct = atscChannels.get(programNumber);
    const streams: ProbeStream[] = (pmt?.streams ?? []).map((stream) => {
      const candidate: ProbeStream = {
        streamType: stream.streamType,
        streamTypeHex: `0x${stream.streamType.toString(16).padStart(2, '0').toUpperCase()}`,
        pid: stream.pid,
        pidHex: hex16(stream.pid),
        description: streamTypeName(stream.streamType),
        descriptors: stream.descriptors,
        ...(esByPid.has(stream.pid) ? { es: esByPid.get(stream.pid) } : {}),
      };
      const details = streamDescriptionDetails(candidate);
      return details !== undefined ? { ...candidate, descriptionDetails: details } : candidate;
    });

    const serviceCaSystems = new Set<number>();
    const serviceEcmPids = new Set<number>();
    const serviceEmmPids = new Set<number>();
    if (pmt) {
      const descriptors = [
        ...pmt.programDescriptors,
        ...pmt.streams.flatMap((stream) => stream.descriptors),
      ];
      for (const descriptor of descriptors) {
        if (descriptor.tag !== 0x09 && descriptor.tag !== 0xf6) continue;
        const systemId = descriptor.fields?.caSystemId;
        if (typeof systemId === 'number') serviceCaSystems.add(systemId);
        const ecmPid = descriptor.fields?.caPid ?? descriptor.fields?.ecmPid;
        if (typeof ecmPid === 'number') serviceEcmPids.add(ecmPid);
      }
    }
    for (const systemId of serviceCaSystems) {
      for (const emmPid of caBySystem.get(systemId)?.emm ?? []) serviceEmmPids.add(emmPid);
    }

    const pmtPid = patPrograms.get(programNumber) ?? 0;
    const servicePids = new Set<number>();
    if (pmtPid > 0) servicePids.add(pmtPid);
    if (pmt && pmt.pcrPid !== 0x1fff) servicePids.add(pmt.pcrPid);
    for (const stream of streams) servicePids.add(stream.pid);
    const pids = [...servicePids].sort((a, b) => a - b);
    let packets = 0;
    for (const pid of pids) packets += stats.get(pid)?.packets ?? 0;
    const bitrateBps =
      durationSec !== undefined && durationSec > 0
        ? (packets * packetSize * 8) / durationSec
        : undefined;
    const serviceCa =
      pmt?.programDescriptors.some(
        (descriptor) => descriptor.tag === 0x09 || descriptor.tag === 0xf6,
      ) ?? false;
    let scrambledComponents = 0;
    for (const pid of pids) {
      const stat = stats.get(pid);
      const stream = pmt?.streams.find((entry) => entry.pid === pid);
      const descriptorScrambled =
        serviceCa ||
        (stream?.descriptors.some(
          (descriptor) => descriptor.tag === 0x09 || descriptor.tag === 0xf6,
        ) ??
          false);
      const pidScrambled =
        stat !== undefined && stat.packets > 0 && stat.scrambled >= stat.packets * 0.5;
      if (descriptorScrambled || pidScrambled) scrambledComponents += 1;
    }
    const components = {
      total: pids.length,
      clear: pids.length - scrambledComponents,
      scrambled: scrambledComponents,
    };

    const serviceType = sdt?.serviceType ?? vct?.serviceType;
    services.push({
      programNumber,
      programNumberHex: hex16(programNumber),
      ...(sdt?.serviceId !== undefined
        ? { serviceId: sdt.serviceId }
        : vct?.sourceId !== undefined
          ? { serviceId: vct.sourceId }
          : {}),
      ...(sdt?.serviceName !== undefined
        ? { name: sdt.serviceName }
        : vct?.shortName !== undefined
          ? { name: vct.shortName }
          : {}),
      ...(sdt?.providerName !== undefined ? { providerName: sdt.providerName } : {}),
      ...(serviceType !== undefined ? { serviceType } : {}),
      ...(vct !== undefined
        ? { serviceTypeName: atscServiceTypeName(vct.serviceType) }
        : sdt?.serviceType !== undefined
          ? { serviceTypeName: dvbServiceTypeName(sdt.serviceType) }
          : {}),
      ...(vct !== undefined
        ? {
            majorChannelNumber: vct.majorChannelNumber,
            minorChannelNumber: vct.minorChannelNumber,
            sourceId: vct.sourceId,
            channelTsid: vct.channelTsid,
            modulationMode: vct.modulationMode,
          }
        : {}),
      ...(tsid !== undefined ? { tsid } : {}),
      ...(sdt?.originalNetworkId !== undefined
        ? { originalNetworkId: sdt.originalNetworkId }
        : vct !== undefined
          ? { originalNetworkId: 0 }
          : {}),
      hidden: vct?.hidden ?? false,
      packets,
      ...(bitrateBps !== undefined ? { bitrateBps, bitrate204Bps: (bitrateBps * 204) / 188 } : {}),
      pids,
      components,
      isScrambled: scrambledComponents > 0,
      ...(serviceCaSystems.size > 0
        ? {
            conditionalAccess: {
              systems: [...serviceCaSystems].sort((a, b) => a - b),
              ecmPids: [...serviceEcmPids].sort((a, b) => a - b),
              emmPids: [...serviceEmmPids].sort((a, b) => a - b),
            },
          }
        : {}),
      ssu: ssuSignalled,
      t2mi: streams.some((stream) => t2miPids.has(stream.pid)),
      pmtPid,
      ...(pmt && pmt.pcrPid !== 0x1fff ? { pcrPid: pmt.pcrPid } : {}),
      descriptors: pmt?.programDescriptors ?? [],
      streams,
    });
  }

  return services.sort((a, b) => a.programNumber - b.programNumber);
}

function atscServiceTypeName(type: number): string {
  switch (type) {
    case 0x01:
      return 'analog television';
    case 0x02:
      return 'ATSC digital television';
    case 0x03:
      return 'ATSC audio';
    case 0x04:
      return 'ATSC data only';
    default:
      return 'reserved';
  }
}

export function buildPids(
  stats: Map<number, MutablePidStat>,
  pmtPids: Set<number>,
  pmtByProgram: Map<number, PmtSection>,
  pcrPid: number | undefined,
): ProbePid[] {
  const kindByPid = new Map<number, string>();
  const audioTypeByPid = new Map<number, string>();
  for (const pmtPid of pmtPids) kindByPid.set(pmtPid, 'PMT');
  for (const pmt of pmtByProgram.values()) {
    for (const stream of pmt.streams) {
      kindByPid.set(stream.pid, streamTypeName(stream.streamType));
      const audioDescriptor = stream.descriptors.find((entry) => entry.tag === 0x81);
      const audioType = audioDescriptor?.fields?.audioServiceTypeName;
      if (typeof audioType === 'string' && audioType.length > 0) {
        audioTypeByPid.set(stream.pid, audioType);
      }
    }
  }
  if (pcrPid !== undefined && !kindByPid.has(pcrPid)) kindByPid.set(pcrPid, 'PCR');

  const pids: ProbePid[] = [];
  for (const [pid, stat] of stats) {
    const kind = kindByPid.get(pid) ?? pidKind(pid);
    pids.push({
      pid,
      pidHex: hex16(pid),
      packets: stat.packets,
      payloadBytes: stat.payloadBytes,
      pusi: stat.pusi,
      scrambled: stat.scrambled,
      ccErrors: stat.ccErrors,
      tei: stat.tei,
      pcrCount: stat.pcrCount,
      ...(stat.lastCc !== undefined ? { lastCc: stat.lastCc } : {}),
      ...(stat.firstPacket !== undefined ? { firstPacket: stat.firstPacket } : {}),
      ...(stat.firstPacketOffset !== undefined
        ? { firstPacketOffset: stat.firstPacketOffset }
        : {}),
      ...(kind ? { kind } : {}),
      ...(audioTypeByPid.has(pid) ? { audioServiceType: audioTypeByPid.get(pid) as string } : {}),
    });
  }
  return pids.sort((a, b) => a.pid - b.pid);
}

export interface DetectionInput {
  layoutSize: number;
  tableIds: Set<number>;
  descriptorTags: Set<number>;
  pmtByProgram: Map<number, PmtSection>;
  hasAtscPsi: boolean;
}

export function detectStandard(input: DetectionInput): ProbeResult['standard'] {
  let atsc = 0;
  let isdb = 0;
  let dvb = 0;
  const evidence: string[] = [];
  const seen = new Set<string>();
  const add = (text: string): void => {
    if (!seen.has(text)) {
      seen.add(text);
      evidence.push(text);
    }
  };

  const isdbStrong =
    input.layoutSize === 204 ||
    [...input.descriptorTags].some((tag) => ISDB_DESCRIPTOR_TAGS.has(tag)) ||
    [...input.tableIds].some((tableId) => tableId >= 0xc3 && tableId <= 0xc6);
  const atscStrong =
    input.hasAtscPsi ||
    [...input.descriptorTags].some((tag) => ATSC_DESCRIPTOR_TAGS.has(tag)) ||
    [...input.tableIds].some((tableId) => tableId >= 0xc9 && tableId <= 0xcd) ||
    [...input.pmtByProgram.values()].some((pmt) =>
      pmt.programDescriptors.some(
        (descriptor) => descriptor.tag === 0x05 && descriptor.fields?.formatIdentifier === 'GA94',
      ),
    );

  for (const tableId of input.tableIds) {
    const hex = tableId.toString(16).padStart(2, '0').toUpperCase();
    if (tableId === 0xc7 || tableId === 0xc8) {
      // ISDB LDT/CDT and ATSC MGT/TVCT share table ids 0xC7/0xC8.
      const isdbName = tableId === 0xc7 ? 'ISDB LDT' : 'ISDB CDT';
      const atscName = tableId === 0xc7 ? 'ATSC MGT' : 'ATSC TVCT';
      if (isdbStrong && !atscStrong) {
        isdb += 1;
        add(`${isdbName} (0x${hex})`);
      } else if (atscStrong && !isdbStrong) {
        atsc += 1;
        add(`${atscName} (0x${hex})`);
      } else if (isdbStrong && atscStrong) {
        isdb += 1;
        atsc += 1;
        add(`shared table 0x${hex} (${isdbName} / ${atscName})`);
      } else {
        atsc += 1;
        add(`${atscName} (0x${hex})`);
      }
      continue;
    }
    const label = `${tableName(
      tableId,
      tableId >= 0xc3 && tableId <= 0xc6 ? 'ISDB' : ATSC_TABLE_IDS.has(tableId) ? 'ATSC' : 'DVB',
    )} (0x${hex})`;
    if (ATSC_TABLE_IDS.has(tableId)) {
      atsc += 1;
      add(label);
    } else if (ISDB_TABLE_IDS.has(tableId)) {
      isdb += 1;
      add(label);
    } else if (
      tableId === 0x40 ||
      tableId === 0x41 ||
      tableId === 0x42 ||
      tableId === 0x46 ||
      tableId === 0x4a ||
      (tableId >= 0x4e && tableId <= 0x6f) ||
      (tableId >= 0x70 && tableId <= 0x74) ||
      tableId === 0x7e ||
      tableId === 0x7f
    ) {
      dvb += 1;
      add(label);
    }
  }

  for (const tag of input.descriptorTags) {
    const label = `descriptor 0x${tag.toString(16).padStart(2, '0').toUpperCase()}`;
    if (ATSC_DESCRIPTOR_TAGS.has(tag)) {
      atsc += 1;
      add(label);
    }
    if (ISDB_DESCRIPTOR_TAGS.has(tag)) {
      isdb += 1;
      add(label);
    }
    if (DVB_DESCRIPTOR_TAGS.has(tag)) {
      dvb += 1;
      add(label);
    }
  }

  for (const pmt of input.pmtByProgram.values()) {
    for (const descriptor of pmt.programDescriptors) {
      if (descriptor.tag === 0x05 && descriptor.fields?.formatIdentifier === 'GA94') {
        atsc += 2;
        add('registration GA94 (ATSC)');
      }
    }
  }

  if (input.hasAtscPsi) {
    atsc += 2;
    add('ATSC PSIP PID 0x1FFB');
  }
  if (input.layoutSize === 204) {
    isdb += 2;
    add('204-byte ISDB-Tb packets');
  }
  if (input.layoutSize === 192) {
    add('192-byte M2TS packets');
  }

  let detected: Standard = 'unknown';
  if (atsc > 0 && (isdb > 0 || dvb > 0)) detected = 'mixed';
  else if (atsc > 0) detected = 'ATSC';
  else if (isdb > 0) detected = 'ISDB';
  else if (dvb > 0) detected = 'DVB';

  const strength = Math.max(atsc, isdb, dvb);
  const confidence =
    detected === 'unknown'
      ? 0.2
      : detected === 'mixed'
        ? 0.8
        : Math.min(0.99, 0.7 + strength * 0.03);

  return { detected, confidence, evidence };
}
