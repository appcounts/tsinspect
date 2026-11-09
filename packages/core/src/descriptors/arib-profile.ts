import type { AribProfile } from './arib-string.js';

/** Minimal stream evidence needed to choose an ARIB character-set profile. */
export interface AribProfileEvidence {
  packet: { size: number };
  transport: { country?: string };
}

/**
 * Resolve the ARIB STD-B24 profile. SBTVD/ISDB-T international streams use
 * Brazil-style Latin characters even when they keep 188-byte packets, so the
 * country signalled by TOT takes priority over the packet-size fallback.
 */
export function resolveAribProfile(
  result: AribProfileEvidence,
  requested: 'auto' | AribProfile = 'auto',
): AribProfile {
  if (requested !== 'auto') return requested;
  if (result.packet.size === 204) return 'brazil';
  const country = result.transport.country;
  if (country !== undefined && country !== '') {
    return country === 'JPN' ? 'japan' : 'brazil';
  }
  return 'japan';
}
