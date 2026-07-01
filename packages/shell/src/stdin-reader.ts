/**
 * A shared reader over a stdin {@link ReadableStream}. Owns the stream's single
 * reader so every read advances ONE cursor — sequential `read` builtins inside a
 * compound statement (`{ read a; read b; } < file`) read successive data rather
 * than each restarting from the top (the old materialized-string bug).
 *
 * The source of truth is a RAW byte buffer (`#buf` from `#pos`), so `readAll` and
 * `readAllStream` are binary-exact even after a preceding text read (`read hdr;
 * cat` over a binary body must not corrupt the body). Text reads
 * (`readLine`/`readUntil`/`readBytes`) UTF-8-decode a prefix of the raw buffer and
 * advance `#pos` by the exact number of BYTES that prefix occupied, so the raw
 * cursor and the text cursor never disagree.
 */
export class StdinReader {
  #reader: ReadableStreamDefaultReader<Uint8Array>;
  #buf: Uint8Array = new Uint8Array(0); // unconsumed raw bytes start at #pos
  #pos = 0;
  #eof = false;
  #inflight: Promise<ReadableStreamReadResult<Uint8Array>> | undefined;

  constructor(stream: ReadableStream<Uint8Array>) {
    this.#reader = stream.getReader();
  }

  /** Pull one chunk into the raw buffer (reusing an in-flight read a timed-out caller abandoned). */
  async #pull(): Promise<boolean> {
    if (this.#eof) return false;
    const p = this.#inflight ?? this.#reader.read();
    this.#inflight = p;
    const { value, done } = await p;
    this.#inflight = undefined;
    if (done) { this.#eof = true; return false; }
    if (value && value.byteLength > 0) this.#append(value);
    return true;
  }

  #append(chunk: Uint8Array): void {
    const remaining = this.#buf.byteLength - this.#pos;
    const next = new Uint8Array(remaining + chunk.byteLength);
    next.set(this.#buf.subarray(this.#pos), 0);
    next.set(chunk, remaining);
    this.#buf = next;
    this.#pos = 0;
  }

  /** The unconsumed raw bytes (a view; do not retain past the next read). */
  #rest(): Uint8Array { return this.#buf.subarray(this.#pos); }

  /** Index of `byte` in the unconsumed region, or -1. */
  #indexOfByte(byte: number): number {
    const rest = this.#rest();
    for (let i = 0; i < rest.byteLength; i++) if (rest[i] === byte) return i;
    return -1;
  }

  /** Decode the first `nBytes` of the unconsumed region as UTF-8 and advance `#pos`. */
  #takeBytes(nBytes: number): string {
    const rest = this.#rest();
    const n = Math.min(nBytes, rest.byteLength);
    const out = new TextDecoder().decode(rest.subarray(0, n));
    this.#pos += n;
    return out;
  }

  /**
   * Decode+consume the first `nChars` CHARACTERS of the unconsumed region.
   * Advances `#pos` by the exact byte length those characters occupy (so a
   * following raw read stays byte-aligned). Stops at EOF.
   */
  async #takeChars(nChars: number): Promise<string> {
    // Ensure enough bytes buffered that we surely have >= nChars chars (a char is
    // at most 4 bytes), or EOF.
    while (this.#rest().byteLength < nChars * 4 && !this.#eof) await this.#pull();
    const rest = this.#rest();
    const decoded = new TextDecoder().decode(rest); // whole remaining region
    const take = decoded.slice(0, nChars);
    const byteLen = new TextEncoder().encode(take).byteLength;
    this.#pos += byteLen;
    return take;
  }

  /** One line (without the trailing `\n`), or undefined at EOF with nothing left. */
  async readLine(): Promise<string | undefined> {
    for (;;) {
      const nl = this.#indexOfByte(0x0a);
      if (nl >= 0) { const line = this.#takeBytes(nl); this.#pos += 1; /* skip \n */ return line; }
      if (this.#eof) {
        const rest = this.#rest();
        if (rest.byteLength === 0) return undefined;
        return this.#takeBytes(rest.byteLength);
      }
      await this.#pull();
    }
  }

  /**
   * Text up to (excluding) the single-char `delim`, stopping at `max` CHARS if
   * given. undefined at a clean EOF (nothing left). Consumes the delimiter.
   */
  async readUntil(delim: string, max: number | undefined): Promise<string | undefined> {
    const delimByte = new TextEncoder().encode(delim)[0];
    for (;;) {
      const idx = this.#indexOfByte(delimByte);
      if (idx >= 0) {
        if (max !== undefined && max >= 0) {
          // Count chars up to the delimiter; if it exceeds max, take max chars.
          const upto = new TextDecoder().decode(this.#rest().subarray(0, idx));
          if (upto.length > max) return await this.#takeChars(max);
        }
        const out = this.#takeBytes(idx);
        this.#pos += 1; // consume delimiter (single byte)
        return out;
      }
      if (max !== undefined && max >= 0) {
        const rest = new TextDecoder().decode(this.#rest());
        if (rest.length >= max) return await this.#takeChars(max);
      }
      if (this.#eof) {
        const rest = this.#rest();
        if (rest.byteLength === 0) return undefined;
        if (max !== undefined && max >= 0) return await this.#takeChars(max);
        return this.#takeBytes(rest.byteLength);
      }
      await this.#pull();
    }
  }

  /** Exactly `n` chars (or fewer at EOF), as text. Advances the raw cursor by their byte length. */
  async readBytes(n: number): Promise<string> {
    return this.#takeChars(n);
  }

  /** Drain everything remaining as raw bytes (binary-EXACT — never re-encodes). */
  async readAll(): Promise<Uint8Array> {
    const parts: Uint8Array[] = [];
    const head = this.#rest();
    if (head.byteLength > 0) parts.push(head.slice()); // copy: #buf may be replaced
    this.#pos = this.#buf.byteLength;
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

  /**
   * Stream the remaining raw bytes to `sink` chunk-by-chunk (binary-exact, no
   * full buffering) — for a streaming `cat`. Stops if `sink` throws (EPIPE).
   */
  async pumpTo(sink: (chunk: Uint8Array) => void | Promise<void>): Promise<void> {
    const head = this.#rest();
    if (head.byteLength > 0) { const c = head.slice(); this.#pos = this.#buf.byteLength; await sink(c); }
    while (!this.#eof) {
      const p = this.#inflight ?? this.#reader.read();
      this.#inflight = p;
      const { value, done } = await p;
      this.#inflight = undefined;
      if (done) { this.#eof = true; break; }
      if (value && value.byteLength > 0) await sink(value);
    }
  }

  hasData(): boolean { return this.#pos < this.#buf.byteLength || !this.#eof; }
  cancel(): void { void this.#reader.cancel().catch(() => { /* closed */ }); }
}
