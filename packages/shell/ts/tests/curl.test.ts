import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI = join(__dirname, '../cli/index.ts');

let server: ReturnType<typeof createServer>;
let port: number;

before(async () => {
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let body = '';
    req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
    req.on('end', () => {
      if (req.url === '/') {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('hello from test server');
      } else if (req.url === '/json') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ key: 'value', number: 42 }));
      } else if (req.url === '/api' && req.method === 'POST') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ received: body, method: req.method }));
      } else if (req.url === '/404') {
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('Not Found');
      } else if (req.url === '/redirect') {
        res.writeHead(302, { 'location': `/` });
        res.end();
      } else if (req.url === '/headers') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(req.headers));
      } else {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end(`path: ${req.url}`);
      }
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve();
    });
  });
});

after(() => {
  server?.close();
});

function runShell(script: string, mode: 'worker' | 'async'): Promise<{ stdout: string; stderr: string; exit: number }> {
  return new Promise((resolve) => {
    const args = mode === 'async' ? [CLI, '--async'] : [CLI];
    const child = spawn('node', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 15000,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    child.on('close', (code: number | null) => {
      resolve({ stdout, stderr, exit: code ?? 0 });
    });
    child.stdin.write(script);
    child.stdin.end();
  });
}

for (const mode of ['worker', 'async'] as const) {
  describe(`curl smoke (${mode} mode)`, () => {

    it('basic GET', async () => {
      const { stdout, exit } = await runShell(`curl http://127.0.0.1:${port}/\n`, mode);
      assert.strictEqual(exit, 0);
      assert.strictEqual(stdout.trim(), 'hello from test server');
    });

    it('POST with body and headers', async () => {
      const { stdout, exit } = await runShell(
        `curl -X POST -d '{"key":"val"}' -H 'Content-Type: application/json' http://127.0.0.1:${port}/api\n`,
        mode,
      );
      assert.strictEqual(exit, 0);
      const parsed = JSON.parse(stdout.trim());
      assert.strictEqual(parsed.method, 'POST');
      assert.strictEqual(parsed.received, '{"key":"val"}');
    });

    it('fail on 404', async () => {
      const { exit } = await runShell(`curl -f http://127.0.0.1:${port}/404\n`, mode);
      assert.ok(exit !== 0, `expected non-zero exit code, got ${exit}`);
    });

    it('follow redirects', async () => {
      const { stdout, exit } = await runShell(`curl -L http://127.0.0.1:${port}/redirect\n`, mode);
      assert.strictEqual(exit, 0);
      assert.strictEqual(stdout.trim(), 'hello from test server');
    });

    it('pipe to jq', async () => {
      const { stdout, exit } = await runShell(`curl -s http://127.0.0.1:${port}/json | jq -r '.key'\n`, mode);
      assert.strictEqual(stdout.trim(), 'value');
      assert.strictEqual(exit, 0);
    });

  });
}
