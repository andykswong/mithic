import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { MockHttpClient } from './mock-http-client.ts';
import type { HttpResponse } from '../http.ts';

describe('MockHttpClient', () => {
  let provider: MockHttpClient;

  beforeEach(() => {
    provider = new MockHttpClient();
  });

  it('should return registered response for matching URL', async () => {
    const mockResponse: HttpResponse = {
      status: 200,
      headers: [['content-type', 'text/plain']],
      body: new Uint8Array([72, 101, 108, 108, 111]),
    };
    provider.addResponse('https://example.com/hello', mockResponse);

    const response = await provider.send({
      method: 'GET',
      url: 'https://example.com/hello',
      headers: [],
    });

    assert.deepStrictEqual(response, mockResponse);
  });

  it('should match URL by prefix', async () => {
    const mockResponse: HttpResponse = {
      status: 200,
      headers: [],
    };
    provider.addResponse('https://example.com/api', mockResponse);

    const response = await provider.send({
      method: 'GET',
      url: 'https://example.com/api/users',
      headers: [],
    });

    assert.deepStrictEqual(response, mockResponse);
  });

  it('should throw if no mock response configured', async () => {
    await assert.rejects(
      () => provider.send({
        method: 'GET',
        url: 'https://unknown.com',
        headers: [],
      }),
      { message: 'No mock response configured for: https://unknown.com' }
    );
  });
});
