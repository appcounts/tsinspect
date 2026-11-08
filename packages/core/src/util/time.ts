/** MPEG/DVB time decoding: Modified Julian Date plus 24-bit BCD time of day. */

export interface DvbDateTime {
  /** Seconds since the Unix epoch, UTC. */
  unixSeconds: number;
  /** ISO-8601 representation, for example 2026-11-06T12:34:56.000Z. */
  iso: string;
  mjd: number;
  hour: number;
  minute: number;
  second: number;
}

export function decodeBcd(value: number): number {
  return ((value >> 4) & 0x0f) * 10 + (value & 0x0f);
}

function bcdDigitsValid(value: number): boolean {
  return (value >> 4) <= 9 && (value & 0x0f) <= 9;
}

/** MJD 40587 is 1970-01-01. */
export const MJD_UNIX_EPOCH = 40587;

export function mjdToUnixSeconds(mjd: number): number {
  return (mjd - MJD_UNIX_EPOCH) * 86_400;
}

export function unixSecondsToMjd(unixSeconds: number): number {
  return Math.floor(unixSeconds / 86_400) + MJD_UNIX_EPOCH;
}

/**
 * Read the 5-byte UTC time used by EIT, TDT and TOT:
 * 16-bit MJD followed by 24-bit BCD hours/minutes/seconds.
 * Returns null for reserved or malformed values.
 */
export function parseDvbDateTime(data: Uint8Array, offset = 0): DvbDateTime | null {
  if (offset + 5 > data.length) return null;

  const mjd = ((data[offset] as number) << 8) | (data[offset + 1] as number);
  const hourBcd = data[offset + 2] as number;
  const minuteBcd = data[offset + 3] as number;
  const secondBcd = data[offset + 4] as number;

  if (!bcdDigitsValid(hourBcd) || !bcdDigitsValid(minuteBcd) || !bcdDigitsValid(secondBcd)) {
    return null;
  }

  const hour = decodeBcd(hourBcd);
  const minute = decodeBcd(minuteBcd);
  const second = decodeBcd(secondBcd);
  if (hour > 23 || minute > 59 || second > 59) return null;

  const unixSeconds = mjdToUnixSeconds(mjd) + hour * 3600 + minute * 60 + second;
  return {
    unixSeconds,
    iso: new Date(unixSeconds * 1000).toISOString(),
    mjd,
    hour,
    minute,
    second,
  };
}

/**
 * Read the 3-byte BCD duration used by EIT events.
 * Values with invalid BCD digits yield null.
 */
export function parseDvbDurationSeconds(data: Uint8Array, offset = 0): number | null {
  if (offset + 3 > data.length) return null;
  const hourByte = data[offset] as number;
  const minuteByte = data[offset + 1] as number;
  const secondByte = data[offset + 2] as number;
  if (
    !bcdDigitsValid(hourByte) ||
    !bcdDigitsValid(minuteByte) ||
    !bcdDigitsValid(secondByte)
  ) {
    return null;
  }
  const hour = decodeBcd(hourByte);
  const minute = decodeBcd(minuteByte);
  const second = decodeBcd(secondByte);
  if (minute > 59 || second > 59) return null;
  return hour * 3600 + minute * 60 + second;
}

/** Format a UTC Unix time for display, keeping the ISO shape stable. */
export function formatDvbTime(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString();
}
