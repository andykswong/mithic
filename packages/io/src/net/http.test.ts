import { describe, it, expect } from 'vitest';
import { DisabledHttpClient, DisabledHttpServer } from './providers/disabled-http.ts';

describe('DisabledHttpClient', () => {
  it('should always throw', () => {
    const provider = new DisabledHttpClient();
    expect(() => provider.send({ method: 'GET', url: 'https://example.com', headers: [] }))
      .toThrow('HTTP access is disabled');
  });
});

describe('DisabledHttpServer', () => {
  it('should throw on listen', async () => {
    const server = new DisabledHttpServer();
    await expect(server.listen(async () => ({ status: 200, headers: [] })))
      .rejects.toThrow('HTTP server is disabled');
  });

  it('should resolve on close without error', async () => {
    const server = new DisabledHttpServer();
    await server.close(); // Should not throw
  });
});
