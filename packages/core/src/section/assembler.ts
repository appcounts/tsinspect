export interface AssembledSection {
  pid: number;
  data: Uint8Array;
  packetIndex: number;
  packetOffset: number;
}

/**
 * Reassembles PSI/SI sections for one PID. Handles pointer_field, sections
 * split across packets, multiple sections per packet and 0xFF stuffing.
 */
export class SectionAssembler {
  private current: Uint8Array | null = null;
  private currentLength = 0;
  private currentNeeded = 0;
  private header: number[] = [];
  private firstPacket = -1;
  private firstOffset = -1;

  constructor(
    public readonly pid: number,
    private readonly maxSectionLength = 4093,
  ) {}

  push(
    payload: Uint8Array,
    pusi: boolean,
    packetIndex: number,
    packetOffset: number,
  ): AssembledSection[] {
    const out: AssembledSection[] = [];
    if (payload.length === 0) return out;

    if (pusi) {
      const pointer = payload[0] as number;
      if (pointer > payload.length - 1) {
        this.reset();
        return out;
      }

      if (pointer > 0) {
        this.feed(payload.subarray(1, 1 + pointer), packetIndex, packetOffset, out);
        // The pointer bytes are supposed to finish the previous section. If
        // they did not, the stream is corrupt and the partial section is lost.
        if (this.current !== null || this.header.length > 0) this.reset();
      } else if (this.current !== null || this.header.length > 0) {
        this.reset();
      }

      this.feed(payload.subarray(1 + pointer), packetIndex, packetOffset, out);
    } else if (this.current !== null || this.header.length > 0) {
      this.feed(payload, packetIndex, packetOffset, out);
    }

    return out;
  }

  reset(): void {
    this.current = null;
    this.currentLength = 0;
    this.currentNeeded = 0;
    this.header.length = 0;
    this.firstPacket = -1;
    this.firstOffset = -1;
  }

  get pendingBytes(): number {
    return this.currentLength + this.header.length;
  }

  private feed(
    bytes: Uint8Array,
    packetIndex: number,
    packetOffset: number,
    out: AssembledSection[],
  ): void {
    let pos = 0;

    while (pos < bytes.length) {
      if (this.current === null) {
        const need = 3 - this.header.length;
        const take = Math.min(need, bytes.length - pos);
        for (let i = 0; i < take; i += 1) {
          this.header.push(bytes[pos + i] as number);
        }
        pos += take;
        if (this.header.length < 3) return;

        const tableId = this.header[0] as number;
        const b1 = this.header[1] as number;
        const b2 = this.header[2] as number;
        this.header.length = 0;

        if (tableId === 0xff) return; // stuffing

        const sectionLength = ((b1 & 0x0f) << 8) | b2;
        if (sectionLength < 4 || sectionLength > this.maxSectionLength) {
          // Not a section we can trust (often a PES payload misrouted to a
          // section assembler). Drop the rest of this payload.
          return;
        }

        this.currentNeeded = 3 + sectionLength;
        this.current = new Uint8Array(this.currentNeeded);
        this.current[0] = tableId;
        this.current[1] = b1;
        this.current[2] = b2;
        this.currentLength = 3;
        this.firstPacket = packetIndex;
        this.firstOffset = packetOffset;
      }

      const copy = Math.min(this.currentNeeded - this.currentLength, bytes.length - pos);
      this.current.set(bytes.subarray(pos, pos + copy), this.currentLength);
      this.currentLength += copy;
      pos += copy;

      if (this.currentLength === this.currentNeeded) {
        out.push({
          pid: this.pid,
          data: this.current,
          packetIndex: this.firstPacket,
          packetOffset: this.firstOffset,
        });
        this.current = null;
        this.currentLength = 0;
        this.currentNeeded = 0;
        this.firstPacket = -1;
        this.firstOffset = -1;
      }
    }
  }
}

export function sectionLength(data: Uint8Array): number | null {
  if (data.length < 3) return null;
  const length = ((data[1] as number) & 0x0f) << 8 | (data[2] as number);
  if (length > 4093) return null;
  return length;
}

export function isLongSection(data: Uint8Array): boolean {
  return data.length >= 3 && ((data[1] as number) & 0x80) !== 0;
}
