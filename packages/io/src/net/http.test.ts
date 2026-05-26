import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DisabledHttpClient, DisabledHttpServer } from './providers/disabled-http.ts';

describe('DisabledHttpClient', () => {
  it('should always throw', () => {
    const provider = new DisabledHttpClient();
    assert.throws(
      () => provider.send({ method: 'GET', url: 'https://example.com', headers: [] }),
      { message: 'HTTP access is disabled' }
    );
  });
});

describe('DisabledHttpServer', () => {
  it('should throw on listen', async () => {
    const server = new DisabledHttpServer();
    await assert.rejects(
      () => server.listen(async () => ({ status: 200, headers: [] })),
      { message: 'HTTP server is disabled' }
    );
  });

  it('should resolve on close without error', async () => {
    const server = new DisabledHttpServer();
    await server.close(); // Should not throw
  });
});
