/**
 * A shared reader over a stdin {@link ReadableStream}. Owns the stream's single
 * reader so every read advances ONE cursor — sequential `read` builtins inside a
 * compound statement (`{ read a; read b; } < file`) read successive data rather
 * than each restarting from the top (the old materialized-string bug).
 *
 * Text reads (`readLine`/`readUntil`/`readBytes`) decode UTF-8 with a streaming
 * decoder so a multi-byte char split across chunks reassembles. `readAll` returns
 * raw bytes (binary-safe). `#carry` holds decoded-but-unreturned text.
 */
export class StdinReader {
  #reader: ReadableStreamDefaultReader<Uint8Array>;
  #dec = new TextDecoder();
  #carry = '';
  #eof = false;
  #inflight: Promise<ReadableStreamReadResult<Uint8Array>> | undefined;

  constructor(stream: ReadableStream<Uint8Array>) {
    this.#reader = stream.getReader();
  }

  async #pull(): Promise<boolean> {
    if (this.#eof) return false;
    const p = this.#inflight ?? this.#reader.read();
    this.#inflight = p;
    const { value, done } = await p;
    this.#inflight = undefined;
    if (done) { this.#eof = true; return false; }
    if (value && value.byteLength > 0) this.#carry += this.#dec.decode(value, { stream: true });
    return true;
  }

  async readLine(): Promise<string | undefined> {
    for (;;) {
      const nl = this.#carry.indexOf('\n');
      if (nl >= 0) { const line = this.#carry.slice(0, nl); this.#carry = this.#carry.slice(nl + 1); return line; }
      if (this.#eof) {
        this.#carry += this.#dec.decode();
        const nl2 = this.#carry.indexOf('\n');
        if (nl2 >= 0) { const line = this.#carry.slice(0, nl2); this.#carry = this.#carry.slice(nl2 + 1); return line; }
        if (this.#carry.length > 0) { const l = this.#carry; this.#carry = ''; return l; }
        return undefined;
      }
      await this.#pull();
    }
  }

  async readUntil(delim: string, max: number | undefined): Promise<string | undefined> {
    for (;;) {
      const idx = this.#carry.indexOf(delim);
      if (idx >= 0) {
        const end = max !== undefined && max >= 0 && max < idx ? max : idx;
        const out = this.#carry.slice(0, end);
        this.#carry = this.#carry.slice(end === idx ? idx + delim.length : end);
        return out;
      }
      if (max !== undefined && max >= 0 && this.#carry.length >= max) {
        const out = this.#carry.slice(0, max); this.#carry = this.#carry.slice(max); return out;
      }
      if (this.#eof) {
        this.#carry += this.#dec.decode();
        if (this.#carry.length === 0) return undefined;
        const end = max !== undefined && max >= 0 && max < this.#carry.length ? max : this.#carry.length;
        const out = this.#carry.slice(0, end); this.#carry = this.#carry.slice(end); return out;
      }
      await this.#pull();
    }
  }

  async readBytes(n: number): Promise<string> {
    while (this.#carry.length < n && !this.#eof) await this.#pull();
    if (this.#eof) this.#carry += this.#dec.decode();
    const out = this.#carry.slice(0, n); this.#carry = this.#carry.slice(out.length); return out;
  }

  async readAll(): Promise<Uint8Array> {
    const parts: Uint8Array[] = [];
    const enc = new TextEncoder();
    if (this.#carry.length > 0) { parts.push(enc.encode(this.#carry)); this.#carry = ''; }
    while (!this.#eof) {
      const p = this.#inflight ?? this.#reader.read();
      this.#inflight = p;
      const { value, done } = await p;
      this.#inflight = undefined;
      if (done) { this.#eof = true; break; }
      if (value && value.byteLength > 0) parts.push(value);
    }
    let total = 0; for (const p of parts) total += p.byteLength;
    const out = new Uint8Array(total);
    let off = 0; for (const p of parts) { out.set(p, off); off += p.byteLength; }
    return out;
  }

  hasCarry(): boolean { return this.#carry.length > 0 || !this.#eof; }
  cancel(): void { void this.#reader.cancel().catch(() => { /* closed */ }); }
}
