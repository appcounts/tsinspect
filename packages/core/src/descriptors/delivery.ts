export const POLARIZATION_NAMES = [
  'linear horizontal',
  'linear vertical',
  'circular left',
  'circular right',
];
export const SATELLITE_MODULATION_NAMES = [
  'auto',
  'QPSK',
  '8PSK',
  '16APSK',
  '32APSK',
  'reserved',
  'reserved',
  'reserved',
];
export const CABLE_MODULATION_NAMES = [
  'auto',
  '16QAM',
  '32QAM',
  '64QAM',
  '128QAM',
  '256QAM',
  'reserved',
  'reserved',
];
export const TERRESTRIAL_CONSTELLATION_NAMES = ['QPSK', '16QAM', '64QAM', 'reserved'];
export const CODE_RATE_NAMES = ['1/2', '2/3', '3/4', '5/6', '7/8', 'reserved', 'reserved', 'reserved'];
export const GUARD_INTERVAL_NAMES = ['1/32', '1/16', '1/8', '1/4'];
export const TRANSMISSION_MODE_NAMES = ['2K', '8K', '4K', 'reserved'];
export const BANDWIDTH_NAMES = [
  '8 MHz',
  '7 MHz',
  '6 MHz',
  '5 MHz',
  '1.712 MHz',
  'reserved',
  'reserved',
  'reserved',
];
export const FEC_OUTER_NAMES = [
  'not defined',
  'none',
  'RS(204,188)',
  'reserved',
  'reserved',
  'reserved',
  'reserved',
  'reserved',
];
export const ROLL_OFF_NAMES = ['0.35', '0.25', '0.20', 'reserved'];

export function nameOr(value: number, names: string[]): string {
  return names[value] ?? `reserved (${value})`;
}
