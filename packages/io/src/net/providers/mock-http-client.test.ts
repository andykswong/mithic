import { beforeEach, describe, it, expect } from 'vitest';
import { MockHttpClient } from './mock-http-client.ts';
import { streamToBytes } from '../http.ts';

describe('MockHttpClient', () => {
  let provider: MockHttpClient;

  beforeEach(() => {
    provider = new MockHttpClient();
  });

  it('should return registered response for matching URL', async () => {
    provider.addResponse('https://example.com/hello', {
      status: 200,
      headers: [['content-type', 'text/plain']],
      body: new Uint8Array([72, 101, 108, 108, 111]),
    });

    const response = await provider.send({
      method: 'GET',
      url: 'https://example.com/hello',
      headers: [],
    });

    expect(response.status).toBe(200);
    expect(response.headers).toEqual([['content-type', 'text/plain']]);
    // B6: the body is a stream — drain it to compare bytes.
    expect(await streamToBytes(response.body!)).toEqual(new Uint8Array([72, 101, 108, 108, 111]));
  });

  it('should match URL by prefix', async () => {
    provider.addResponse('https://example.com/api', { status: 200, headers: [] });

    const response = await provider.send({
      method: 'GET',
      url: 'https://example.com/api/users',
      headers: [],
    });

    expect(response.status).toBe(200);
    expect(response.body).toBeUndefined();
  });

  it('should throw if no mock response configured', async () => {
    await expect(
      provider.send({ method: 'GET', url: 'https://unknown.com', headers: [] }),
    ).rejects.toThrow('No mock response configured for: https://unknown.com');
  });

  it('B6: mints a FRESH stream per send so the same URL can be fetched twice', async () => {
    provider.addResponse('https://example.com/twice', {
      status: 200,
      headers: [],
      body: new Uint8Array([1, 2, 3]),
    });

    const first = await provider.send({ method: 'GET', url: 'https://example.com/twice', headers: [] });
    const second = await provider.send({ method: 'GET', url: 'https://example.com/twice', headers: [] });
    // Two distinct (single-use) streams; both yield the bytes.
    expect(first.body).not.toBe(second.body);
    expect(await streamToBytes(first.body!)).toEqual(new Uint8Array([1, 2, 3]));
    expect(await streamToBytes(second.body!)).toEqual(new Uint8Array([1, 2, 3]));
  });
});
