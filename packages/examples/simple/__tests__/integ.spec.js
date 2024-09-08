import { describe, it } from '@jest/globals';

describe('simple', () => {
  it('should run successfully without errors', async () => {
    await import('../index.js');
  });
});
