/** A message with a binary payload and additional information. */
export class Message {
  /** The topic/subject/channel this message was received on, if any. */
  private readonly _topic?: string;
  /** The content type describing the format of the data in the message. */
  private _contentType?: string;
  /** An opaque blob of data. */
  private _data: Uint8Array;
  /** Metadata (also called headers or attributes in some systems) attached to the message. */
  private _metadata?: Record<string, string>;

  /** Creates a new {@link Message}. */
  public static from(record: MessageRecord): Message {
    const message = new Message(record.data, record.topic);
    if (record.contentType) { message.setContentType(record.contentType); }
    if (record.metadata) { message.setMetadata(record.metadata); }
    return message;
  }

  public constructor(
    /** An opaque blob of data. */
    data: Uint8Array,
    /** The topic/subject/channel this message was received on, if any. */
    topic?: string
  ) {
    this._data = data;
    this._topic = topic;
  }

  /** Returns the {@link MessageRecord} for this {@link Message} */
  public toRecord(): MessageRecord {
    return {
      topic: this._topic,
      contentType: this._contentType,
      data: this._data,
      metadata: this.metadata() || [],
    };
  }

  /** The topic/subject/channel this message was received on, if any. */
  public topic(): string | undefined {
    return this._topic;
  }

  /** The content type describing the format of the data in the message. */
  public contentType(): string | undefined {
    return this._contentType;
  }

  /** Sets the content type describing the format of the data in the message. */
  public setContentType(contentType: string): void {
    this._contentType = contentType;
  }

  /** An opaque blob of data. */
  public data(): Uint8Array {
    return this._data;
  }

  /** Sets the opaque blob of data for this message. */
  public setData(data: Uint8Array): void {
    this._data = data;
  }

  /** Metadata (also called headers or attributes in some systems) attached to the message. */
  public metadata(): [key: string, value: string][] | undefined {
    return this._metadata && Object.entries(this._metadata);
  }

  /** Sets the metadata. */
  public setMetadata(metadata: [key: string, value: string][]): void {
    this._metadata = Object.fromEntries(metadata);
  }

  /** Adds a new key-value pair to the metadata, overwriting any existing value for the same key. */
  public addMetadata(key: string, value: string): void {
    if (!this._metadata) {
      this._metadata = {};
    }
    this._metadata[key] = value;
  }

  /** Gets a value from the metadata. */
  public getMetadata(key: string): string | undefined {
    return this._metadata?.[key];
  }

  /** Removes a key-value pair from the metadata. */
  public removeMetadata(key: string): void {
    if (this._metadata) {
      delete this._metadata[key];
    }
  }
}

/** Record holding the contents of a {@link Message}. */
export interface MessageRecord {
  /** The topic/subject/channel this message was received on, if any. */
  readonly topic?: string,
  /** The content type describing the format of the data in the message. */
  readonly contentType?: string,
  /** An opaque blob of data. */
  readonly data: Uint8Array,
  /** Metadata attached to the message. */
  readonly metadata: [key: string, value: string][],
}
