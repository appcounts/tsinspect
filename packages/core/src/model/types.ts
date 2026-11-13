export type Standard = 'DVB' | 'ATSC' | 'ISDB' | 'mixed' | 'unknown';

export type PacketFormat = 'ts' | 'm2ts' | 'isdb-tb' | 'rs208';

export type SourceKind = 'file' | 'url' | 'buffer';

export type Severity = 'info' | 'warning' | 'error';

export interface PacketLayout {
  /** Total bytes per packet, including any prefix/trailer. */
  packetSize: 188 | 192 | 204 | 208;
  /** Offset of the 0x47 sync byte from the start of a packet. */
  syncOffset: number;
  format: PacketFormat;
  /** Byte offset of the first complete packet in the buffer. */
  firstPacketOffset: number;
}

export interface DescriptorInfo {
  tag: number;
  tagHex: string;
  length: number;
  name: string;
  /** Raw descriptor payload as uppercase hex. */
  raw: string;
  fields?: Record<string, string | number | boolean>;
}

export interface ProbeStream {
  streamType: number;
  streamTypeHex: string;
  pid: number;
  pidHex: string;
  description: string;
  /** TSAnalyze-style codec parameters, e.g. "1280x720p, @59.94 Hz, 16:9". */
  descriptionDetails?: string;
  descriptors: DescriptorInfo[];
  /** Elementary-stream header metadata extracted from the first PES payloads. */
  es?: EsMetadata;
}

export interface EsMetadata {
  kind: 'video' | 'audio' | 'subtitle' | 'data' | 'unknown';
  codec?: string;
  profile?: string;
  level?: string;
  width?: number;
  height?: number;
  frameRate?: number;
  aspectRatio?: string;
  interlaced?: boolean;
  constrained?: boolean;
  sampleRate?: number;
  channels?: number;
  bitrateBps?: number;
  format?: string;
}

export interface ProbeService {
  programNumber: number;
  programNumberHex: string;
  serviceId?: number;
  name?: string;
  providerName?: string;
  serviceType?: number;
  serviceTypeName?: string;
  /** ATSC virtual channel major number, when a VCT is present. */
  majorChannelNumber?: number;
  /** ATSC virtual channel minor number, when a VCT is present. */
  minorChannelNumber?: number;
  /** ATSC source_id, when a VCT is present. */
  sourceId?: number;
  /** ATSC channel_TSID, when a VCT is present. */
  channelTsid?: number;
  /** ATSC modulation_mode, when a VCT is present. */
  modulationMode?: number;
  pmtPid: number;
  pcrPid?: number;
  descriptors: DescriptorInfo[];
  streams: ProbeStream[];
  /** Transport stream id carrying this service. */
  tsid?: number;
  /** Original network id from SDT. */
  originalNetworkId?: number;
  /** Hidden service flag from ATSC VCT or SDT, when signalled. */
  hidden?: boolean;
  /** Packets belonging to the service (PMT + ES + PCR PIDs). */
  packets?: number;
  bitrateBps?: number;
  /** Bitrate normalised to 204-byte ISDB-Tb packets. */
  bitrate204Bps?: number;
  /** Service PID list: PMT, elementary streams and PCR PID. */
  pids?: number[];
  components?: { total: number; clear: number; scrambled: number };
  isScrambled?: boolean;
  /** Signalling System for Update, when detected. */
  ssu?: boolean;
  /** T2-MI encapsulation, when detected. */
  t2mi?: boolean;
  /** EPG schedule coverage derived from EIT/ETT events. */
  epg?: ProbeEpgCoverage;
  /** Conditional access wiring for this service, when signalled. */
  conditionalAccess?: {
    systems: number[];
    ecmPids: number[];
    emmPids: number[];
  };
  /** ISDB Emergency Warning Broadcast System state for this service. */
  ewbs?: {
    started: boolean;
    signalLevel: number;
    areaCodes: number[];
  };
}

/** EPG schedule window covered by the event information of a service. */
export interface ProbeEpgCoverage {
  events: number;
  firstStartIso?: string;
  lastEndIso?: string;
  /** Covered window length in days (rounded up). */
  days: number;
  /** Schedule table ids seen for the service (DVB), sorted ascending. */
  tableIds?: number[];
}

/** EIT section family that carried an event. */
export type EventSource = 'present-following' | 'schedule';

export interface ProbeEvent {
  /** DVB service id or ATSC source id owning the event. */
  serviceId: number;
  eventId: number;
  /**
   * EIT section families that carried this event. An event announced both in
   * a present/following section and in a schedule section lists both entries.
   */
  sources?: EventSource[];
  /** Position inside a DVB present/following section, when carried by one. */
  presentFollowing?: 'present' | 'following';
  name?: string;
  text?: string;
  startTimeIso?: string;
  durationSec?: number;
  endTimeIso?: string;
  runningStatus?: number;
  runningStatusName?: string;
  /** DVB content descriptor summary (genre/sub-genre nibbles). */
  content?: string;
  /** Parental rating summary (dimension/level). */
  rating?: string;
  /** Event languages from short/extended event or ISO-639 descriptors. */
  languages?: string[];
  /** Extended event items (item description / item text). */
  items?: string[];
  /** Series link id from the series descriptor (0xD5), when present. */
  seriesId?: number;
  /** Series name from the series descriptor, when present. */
  seriesName?: string;
  /** Linkage summary from the linkage descriptor (0x4A), when present. */
  linkage?: string;
  descriptors: DescriptorInfo[];
}

export interface ProbeClock {
  utcIso?: string;
  source: 'TDT' | 'TOT' | 'STT';
  gpsUtcOffset?: number;
  utcFirstIso?: string;
  utcLastIso?: string;
  localFirstIso?: string;
  localLastIso?: string;
  /** Local time offset from TOT, in seconds. */
  localOffsetSec?: number;
  /** Local time offset as sign and HH:MM (for example `+01:00`). */
  localTimeOffset?: string;
  /** Offset that applies after the TOT time of change (for example `+02:00`). */
  nextLocalTimeOffset?: string;
  /** UTC instant when the TOT local time offset changes. */
  timeOfChangeIso?: string;
  /** Country code from the TOT local time offset descriptor. */
  countryCode?: string;
  /** Last TOT UTC timestamp. */
  totIso?: string;
}

export interface ProbeRatingValue {
  abbrev: string;
  text: string;
}

export interface ProbeRatingDimension {
  name: string;
  graduatedScale: boolean;
  values: ProbeRatingValue[];
}

/** ATSC Rating Region Table (RRT) instance. */
export interface ProbeRatingRegion {
  ratingRegion: number;
  protocolVersion: number;
  name: string;
  dimensions: ProbeRatingDimension[];
  descriptors: DescriptorInfo[];
}

/** ISDB-Tb 204-byte packet trailer summary. */
export interface ProbeIsdb {
  trailerPackets: number;
  layers: Array<{ layer: number; packets: number }>;
  iipPackets: number;
  iipPid?: number;
  emergencyControlPackets: number;
  /** Country code from TOT, when present. */
  country?: string;
  /** TMCC identifiers observed in the trailers, ascending. */
  tmccIdentifiers?: number[];
  /** Count-down indexes observed in the trailers, when they carry one. */
  frameIndicators?: { frameHead: number; countDown: number };
  /** Partial reception service range from descriptor 0xC6. */
  partialReception?: { startServiceId: number; endServiceId: number };
  /** Number of packets whose trailer buffer-reset flag was set. */
  bufferResetPackets?: number;
}

/** Payload capabilities inferred from PSI/SI descriptors and stream types. */
export interface ProbeCapabilities {
  teletext: boolean;
  dvbSubtitles: boolean;
  atscCaptions: boolean;
  aribCaptions: boolean;
  vbi: boolean;
  scte35: boolean;
  scrambled: boolean;
  /** Conditional-access system ids from CA/ISDB access-control descriptors. */
  caSystems: number[];
}

export interface ProbePid {
  pid: number;
  pidHex: string;
  packets: number;
  payloadBytes: number;
  pusi: number;
  scrambled: number;
  ccErrors: number;
  tei: number;
  pcrCount: number;
  lastCc?: number;
  kind?: string;
  /** Audio service type signalled in the PMT, e.g. "visually impaired". */
  audioServiceType?: string;
  /** PID carries ISDB IIP packets. */
  iip?: boolean;
  /** Index of the first packet on this PID in the analysed source. */
  firstPacket?: number;
  /** Absolute byte offset of the first packet on this PID. */
  firstPacketOffset?: number;
}

/** A field value in a table summary; objects and arrays become child nodes. */
export type ProbeFieldValue =
  | string
  | number
  | boolean
  | ProbeFieldValue[]
  | { [key: string]: ProbeFieldValue };

export interface ProbeTable {
  pid: number;
  pidHex: string;
  tableId: number;
  tableIdHex: string;
  tableIdExtension?: number;
  name: string;
  mode: 'long' | 'short' | 'unknown';
  length: number;
  occurrences: number;
  firstPacket: number;
  firstPacketOffset: number;
  version?: number;
  currentNext?: boolean;
  sectionNumber?: number;
  lastSectionNumber?: number;
  crcValid?: boolean;
  /** Packet index of the last occurrence of this section. */
  lastPacket?: number;
  /** Average repetition interval of this table section, in seconds. */
  repeatIntervalSec?: number;
  /** Longest gap between two repetitions, in seconds. */
  maxRepeatGapSec?: number;
  /** Version numbers observed for this table identity, ascending. */
  versions?: number[];
  /** Section numbers missing from the last_section_number range. */
  missingSections?: number[];
  /** Compact semantic summary from the latest section, when parsed. */
  fields?: Record<string, ProbeFieldValue>;
}

/** Conditional-access system wiring derived from CAT and PMT CA descriptors. */
export interface ProbeCaSystem {
  caSystemId: number;
  /** ECM PIDs announced by PMT CA descriptors. */
  ecmPids: number[];
  /** EMM PIDs announced by CAT CA descriptors. */
  emmPids: number[];
}

export interface ProbeConditionalAccess {
  /** CAT PID (0x0001) when a CAT section was seen. */
  catPid?: number;
  /** CAT version, when present. */
  catVersion?: number;
  systems: ProbeCaSystem[];
  ecmPids: number[];
  emmPids: number[];
}

/** T2-MI encapsulation summary. */
export interface ProbeT2mi {
  pid: number;
  /** T2-MI packets parsed. */
  packets: number;
  /** Packet type histogram (0x00 TS, 0x20/0x21/0x22 L1, ...). */
  types: Array<{ type: number; name: string; packets: number }>;
  /** Number of transport-stream packets carried in T2-MI type 0x00 packets. */
  tsPackets: number;
  /** PLP ids found in L1 signalling, when parsed. */
  plps?: number[];
  /** Per-packet CRC failures. */
  crcErrors: number;
}

/** One MPE datagram session (DVB data broadcasting, EN 301 192). */
export interface ProbeMpeSession {
  pid: number;
  /** 48-bit MAC destination address as "xx:xx:xx:xx:xx:xx". */
  macAddress: string;
  /** First section number observed for this MAC address. */
  firstSection: number;
  lastSection: number;
  /** LLC/SNAP encapsulation is used. */
  llcSnap: boolean;
  payloadScrambling: number;
  addressScrambling: number;
  /** Datagram sections counted for this session. */
  datagrams: number;
  payloadBytes: number;
  /** IPv4 header summary when an IPv4 datagram is carried directly. */
  ipv4?: {
    source: string;
    destination: string;
    protocol: number;
    multicast: boolean;
  };
}

/** MPE-FEC frame summary (DVB-H, EN 301 192 clause 7). */
export interface ProbeMpeFec {
  pid: number;
  /** MPE-FEC sections seen (0x78 table id). */
  frames: number;
  /** Sections with a full 191-byte payload. */
  sections: number;
  paddingColumns: number;
  payloadBytes: number;
}

/** One entry in a rebuilt object carousel directory tree. */
export interface ProbeCarouselEntry {
  /** Absolute path inside the carousel, "/" separated ("/" is the root). */
  path: string;
  kind: 'file' | 'directory' | 'stream';
  /** Announced content size for files. */
  size?: number;
  /** File content was recovered from the carousel modules. */
  complete: boolean;
  /** Module that carries the object (files only). */
  moduleId?: number;
  /** Printable object key, e.g. "003". */
  objectKey?: string;
  contentType?: string;
  /** Program numbers referenced by stream object taps. */
  programs?: number[];
}

/** One DSM-CC object carousel announced on a data PID. */
export interface ProbeDsmccCarousel {
  pid: number;
  /** DownloadServerInitiate messages. */
  serverInitiates: number;
  /** DownloadInfoIndication messages. */
  downloadInfos: number;
  /** DownloadDataBlock messages. */
  dataBlocks: number;
  /** Transaction / download ids observed, ascending. */
  transactions: number[];
  /** Modules announced by DII messages. */
  modules: Array<{ id: number; size: number; version?: number }>;
  /** Files and directories decoded from BIOP messages (flat list). */
  objects: Array<{
    name: string;
    kind: 'file' | 'directory' | 'service-gateway' | 'unknown';
    size?: number;
  }>;
  /** Service gateway object kinds seen in DSI messages. */
  gateways: string[];
  /** Root of the rebuilt tree, when a service gateway was resolved. */
  root?: string;
  /** Directory tree rebuilt from the service gateway bindings. */
  entries: ProbeCarouselEntry[];
  /** Modules whose data blocks were complete and parsed. */
  completeModules: number;
  /** Announced modules that still miss data blocks in the sample. */
  pendingModules: number;
  /** Modules signalled as compressed (zlib) by the moduleInfo descriptors. */
  compressedModules: number;
  /** Bindings whose referenced object was not present in the sample. */
  danglingBindings: number;
  /** Parsed objects that no directory binding reaches. */
  unreachableObjects: number;
  /** The tree, module or content budget was exhausted before completion. */
  truncated?: boolean;
}

/** MHP or HbbTV application announced by an AIT. */
export interface ProbeBroadcastApplication {
  pid: number;
  applicationType: number;
  applicationTypeName: string;
  organizationId: number;
  applicationId: number;
  controlCode: number;
  name?: string;
  /** HbbTV application URLs from the 0x00/0x01 descriptors. */
  urls?: string[];
  /** AIT version. */
  version?: number;
}

/** DVB data broadcast: MPE, MPE-FEC, DSM-CC carousels and MHP/HbbTV. */
export interface ProbeDataBroadcast {
  mpe: ProbeMpeSession[];
  mpeFec: ProbeMpeFec[];
  carousels: ProbeDsmccCarousel[];
  applications: ProbeBroadcastApplication[];
  /** MHP (DVB-J / DVB-HTML) application signalling was found. */
  mhp: boolean;
  /** HbbTV application signalling was found. */
  hbbtv: boolean;
}

/** SCTE 18 cable Emergency Alert System alert. */
export interface ProbeEasAlert {
  pid: number;
  /** EAS sequence number (section version field). */
  sequenceNumber: number;
  eventId: number;
  originatorCode: string;
  eventCode: string;
  /** Alert priority, 0 (highest) to 15 (lowest). */
  priority: number;
  timeRemainingSec: number;
  startTimeIso?: string;
  durationSec: number;
  natureOfActivation?: string;
  alertText?: string;
  locations: Array<{ stateCode: number; countySubdivision: number; countyCode: number }>;
  exceptionCount: number;
  descriptors: DescriptorInfo[];
  /** Number of times the same alert was repeated in the sample. */
  occurrences: number;
  /** Stream time (PCR seconds) when the alert was first observed. */
  firstSeenSec?: number;
  /** Stream time (PCR seconds) when the alert was last observed. */
  lastSeenSec?: number;
}

/** ISDB EWBS state carried by the emergency information descriptor (0xFC). */
export interface ProbeEwbsService {
  serviceId: number;
  started: boolean;
  /** 0 = first-level (EWBS) signal, 1 = second-level signal. */
  signalLevel: number;
  areaCodes: number[];
  /** Stream time (PCR seconds) when the service was first observed started. */
  firstSeenSec?: number;
  /** Stream time (PCR seconds) when the service was last observed started. */
  lastSeenSec?: number;
}

/** Indonesian EWS region of disaster warning (TRDW) entry. */
export interface ProbeEwsRegion {
  disasterCode: number;
  /** 0x01 = Awas (caution), 0x02 = Siaga (stand-by), 0x03 = Waspada (alert). */
  locationTypeCode: number;
  packageId: number;
  locations: Array<{ code: string; description: string }>;
}

/** Indonesian EWS disaster code (TCDW) entry. */
export interface ProbeEwsDisaster {
  packageId: number;
  /** 0x01 = BMKG, 0x02 = BNPB. */
  authority: number;
  disasterCode: number;
  name: string;
  position: string;
  date: string;
  characteristic: string;
}

/** Indonesian EWS disaster message (TMDW) entry. */
export interface ProbeEwsMessage {
  locationTypeCode: number;
  packageId: number;
  message: string;
}

/** Indonesian Early Warning System private tables (Permen Kominfo 3/2014). */
export interface ProbeEws {
  /** PID carrying the EWS private sections. */
  pid: number;
  regions: ProbeEwsRegion[];
  disasters: ProbeEwsDisaster[];
  messages: ProbeEwsMessage[];
}

/** One time segment of an emergency warning, in stream (PCR) time. */
export interface ProbeEmergencySegment {
  kind: 'EAS' | 'EWS' | 'EWBS';
  /** Segment start in stream time (seconds from the first PCR in the sample). */
  startSec: number;
  /** Segment end; omitted when the warning is still active at the sample end. */
  endSec?: number;
  /**
   * Severity within the system: EAS priority (0 highest), EWBS signal level
   * (0 = first level, 1 = second level) or EWS location_type_code (1 = Awas,
   * 2 = Siaga, 3 = Waspada).
   */
  level?: number;
  /** Alert, disaster or service title. */
  title?: string;
  /** Affected areas (postal codes, area codes or EAS locations). */
  areas?: string;
  /** Additional detail, such as the EWS information message. */
  detail?: string;
  pid?: number;
  /** EWBS service_id the warning belongs to, for per-program grouping. */
  serviceId?: number;
}

/** Emergency alerting summary for the analysed stream. */
export interface ProbeEmergency {
  /** SCTE 18 EAS alerts found on any PID (usually 0x1FFB). */
  eas?: ProbeEasAlert[];
  /** ISDB Emergency Warning Broadcast System signalling. */
  ewbs?: {
    /** TMCC emergency-control flag was set in at least one trailer. */
    activated: boolean;
    activationPackets: number;
    services: ProbeEwbsService[];
    tmccIdentifiers?: number[];
  };
  /** Indonesian Early Warning System carried as private tables. */
  ews?: ProbeEws;
  /** Time-segmented view of every emergency warning in the sample. */
  timeline?: ProbeEmergencySegment[];
}

export interface Diagnostic {
  code: string;
  severity: Severity;
  message: string;
  pid?: number;
  packet?: number;
  tableId?: number;
}

export interface ProbeResult {
  schemaVersion: '1.0';
  tool: {
    name: string;
    version: string;
  };
  source: {
    kind: SourceKind;
    name: string;
    size?: number;
    sampledBytes: number;
    full: boolean;
  };
  packet: {
    size: number;
    format: PacketFormat;
    syncOffset: number;
    firstPacketOffset: number;
  };
  standard: {
    detected: Standard;
    confidence: number;
    evidence: string[];
  };
  transport: {
    tsid?: number;
    tsidHex?: string;
    networkId?: number;
    networkName?: string;
    networkPid?: number;
    packetCount: number;
    pcrPid?: number;
    durationSec?: number;
    bitrateBps?: number;
    /** Country code from TOT, when present. */
    country?: string;
  };
  services: ProbeService[];
  pids: ProbePid[];
  tables: ProbeTable[];
  capabilities: ProbeCapabilities;
  diagnostics: Diagnostic[];
  events: ProbeEvent[];
  clock?: ProbeClock;
  isdb?: ProbeIsdb;
  /** Conditional-access systems and their ECM/EMM PIDs. */
  conditionalAccess?: ProbeConditionalAccess;
  /** T2-MI encapsulation details, when a T2-MI PID is detected. */
  t2mi?: ProbeT2mi;
  /** DVB data broadcast (MPE, MPE-FEC, DSM-CC, MHP/HbbTV), when present. */
  dataBroadcast?: ProbeDataBroadcast;
  /** Emergency alerting (SCTE 18 EAS, ISDB EWBS), when signalled. */
  emergency?: ProbeEmergency;
  /** ATSC Rating Region Table instances. */
  ratings?: ProbeRatingRegion[];
}
