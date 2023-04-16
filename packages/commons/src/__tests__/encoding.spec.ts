import { CID } from 'multiformats';
import { identity } from 'multiformats/hashes/identity';
import { BlockMultibaseEncoding, JsonEncoding, LinkMultibaseEncoding } from '../encoding.js';

const DATA = new Uint8Array([1, 2, 3]);
const DATA_CID = CID.createV1(0, identity.digest(DATA));

describe(JsonEncoding.name, () => {
  const jsonEncoding = new JsonEncoding();

  it('should encode JSON data correctly', () => {
    const data = { name: 'Alice', age: 30 };
    const encoded = jsonEncoding.encode(data);

    expect(encoded).toBe('{"name":"Alice","age":30}');
  });

  it('should decode JSON data correctly', () => {
    const encoded = '{"name":"Alice","age":30}';
    const decoded = jsonEncoding.decode(encoded);

    expect(decoded).toEqual({ name: 'Alice', age: 30 });
  });
});

describe(LinkMultibaseEncoding.name, () => {
  const linkStringEncoding = new LinkMultibaseEncoding();

  it('should encode Link data correctly', () => {
    const encoded = linkStringEncoding.encode(DATA_CID);
    expect(encoded).toBe('mAQAAAwECAw');
  });

  it('should decode Link data correctly', () => {
    const encoded = 'mAQAAAwECAw';
    const decoded = linkStringEncoding.decode(encoded);
    expect(decoded).toEqual(DATA_CID);
  });
});

describe(BlockMultibaseEncoding.name, () => {
  const blockEncoding = new BlockMultibaseEncoding<Uint8Array>();

  it('should encode data block correctly', () => {
    const encoded = blockEncoding.encode(DATA);

    expect(encoded).toBe('mAQID');
  });

  it('should decode data block correctly', () => {
    const encoded = 'mAQID';
    const decoded = blockEncoding.decode(encoded);

    expect(decoded).toEqual(DATA);
  });
});
