import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { createServer, type Server, type Socket } from 'node:net';
import { createSocket, type Socket as DgramSocket } from 'node:dgram';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI = join(__dirname, '../cli/index.ts');

function runShell(script: string, mode: 'worker' | 'async', options?: { timeout?: number }): Promise<{ stdout: string; stderr: string; exit: number }> {
  return new Promise((resolve) => {
    const args = mode === 'async' ? [CLI, '--async'] : [CLI];
    const child = spawn('node', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: options?.timeout ?? 10000,
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
  describe(`/dev/tcp integration (${mode} mode)`, () => {
    let echoServer: Server;
    let echoPort: number;
    let connections: Socket[];

    before(async () => {
      connections = [];
      echoServer = createServer((socket) => {
        connections.push(socket);
        socket.on('error', () => {});
        socket.on('data', (chunk) => {
          socket.write(chunk);
        });
      });
      await new Promise<void>((resolve) => echoServer.listen(0, '127.0.0.1', resolve));
      echoPort = (echoServer.address() as { port: number }).port;
    });

    after(() => {
      for (const conn of connections) conn.destroy();
      echoServer.close();
    });

    it('exec 3>/dev/tcp/host/port opens connection and shell exits 0', async () => {
      const { exit, stderr } = await runShell(
        `exec 3> /dev/tcp/127.0.0.1/${echoPort}\necho "connected"\nexec 3>&-\n`,
        mode,
      );
      assert.strictEqual(exit, 0, `Expected exit 0, got ${exit}. stderr: ${stderr}`);
    });

    it('echo >&3 sends data to TCP server', async () => {
      const dataServer = createServer((socket) => {
        socket.on('error', () => {});
      });
      const received = new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timeout')), 7000);
        dataServer.on('connection', (socket) => {
          socket.on('error', () => {});
          socket.once('data', (chunk) => {
            clearTimeout(timer);
            resolve(chunk.toString());
          });
        });
      });
      await new Promise<void>((resolve) => dataServer.listen(0, '127.0.0.1', resolve));
      const dataPort = (dataServer.address() as { port: number }).port;

      runShell(
        `exec 3> /dev/tcp/127.0.0.1/${dataPort}\necho -n "tcp_test_${mode}" >&3\nexec 3>&-\n`,
        mode,
      );

      const msg = await received;
      assert.strictEqual(msg, `tcp_test_${mode}`);
      dataServer.close();
    });

    it('redirect stdout to TCP: echo > /dev/tcp/host/port', async () => {
      const dataServer = createServer((socket) => {
        socket.on('error', () => {});
      });
      const received = new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timeout')), 7000);
        dataServer.on('connection', (socket) => {
          socket.on('error', () => {});
          let buf = '';
          socket.on('data', (chunk) => {
            buf += chunk.toString();
            if (buf.includes('\n') || buf.includes('redirect_data')) {
              clearTimeout(timer);
              resolve(buf);
            }
          });
        });
      });
      await new Promise<void>((resolve) => dataServer.listen(0, '127.0.0.1', resolve));
      const dataPort = (dataServer.address() as { port: number }).port;

      runShell(
        `echo -n "redirect_data" > /dev/tcp/127.0.0.1/${dataPort}\n`,
        mode,
      );

      const msg = await received;
      assert.ok(msg.includes('redirect_data'), `Expected 'redirect_data' in received: ${msg}`);
      dataServer.close();
    });

    it('pipe through TCP: echo | cat > /dev/tcp/host/port', async () => {
      const dataServer = createServer((socket) => {
        socket.on('error', () => {});
      });
      const received = new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timeout')), 7000);
        dataServer.on('connection', (socket) => {
          socket.on('error', () => {});
          let buf = '';
          socket.on('data', (chunk) => {
            buf += chunk.toString();
            if (buf.includes('piped')) {
              clearTimeout(timer);
              resolve(buf);
            }
          });
        });
      });
      await new Promise<void>((resolve) => dataServer.listen(0, '127.0.0.1', resolve));
      const dataPort = (dataServer.address() as { port: number }).port;

      runShell(
        `echo -n "piped" | cat > /dev/tcp/127.0.0.1/${dataPort}\n`,
        mode,
      );

      const msg = await received;
      assert.ok(msg.includes('piped'), `Expected 'piped' in received: ${msg}`);
      dataServer.close();
    });

    it('read from TCP: server sends data, shell reads with cat', { skip: mode === 'worker' ? 'Worker mode: TCP socket EOF propagation through the sync bridge is not immediate — cat blocks on blockingRead after remote close' : undefined }, async () => {
      const sendServer = createServer((socket) => {
        socket.on('error', () => {});
        socket.write('server-data\n');
        socket.end();
      });
      await new Promise<void>((resolve) => sendServer.listen(0, '127.0.0.1', resolve));
      const sendPort = (sendServer.address() as { port: number }).port;

      const { stdout } = await runShell(
        `cat < /dev/tcp/127.0.0.1/${sendPort}\n`,
        mode,
      );
      assert.ok(stdout.includes('server-data'), `Expected 'server-data' in stdout: ${stdout}`);
      sendServer.close();
    });

    it('bidirectional: exec 3<>/dev/tcp with echo and read', { skip: 'Bidirectional sockets require single-connection read/write; WASI open_at creates separate connections for writeViaStream and readViaStream' }, async () => {
      const { stdout, exit } = await runShell(
        `exec 3<> /dev/tcp/127.0.0.1/${echoPort}\necho "ping" >&3\nread -u 3 -r response\necho "$response"\nexec 3>&-\n`,
        mode,
      );
      assert.strictEqual(exit, 0, `Unexpected exit code: ${exit}`);
      assert.ok(stdout.includes('ping'), `Expected 'ping' echoed back in stdout: ${stdout}`);
    });

    it('multiple simultaneous connections', { skip: 'Depends on bidirectional socket support (read from TCP fd)' }, async () => {
      const server2 = createServer((socket) => {
        connections.push(socket);
        socket.on('error', () => {});
        socket.on('data', (chunk) => {
          socket.write(`S2:${chunk}`);
        });
      });
      await new Promise<void>((resolve) => server2.listen(0, '127.0.0.1', resolve));
      const port2 = (server2.address() as { port: number }).port;

      const { stdout, exit } = await runShell(
        `exec 3<> /dev/tcp/127.0.0.1/${echoPort}\nexec 4<> /dev/tcp/127.0.0.1/${port2}\necho "A" >&3\necho "B" >&4\nread -u 3 -r r1\nread -u 4 -r r2\necho "$r1"\necho "$r2"\nexec 3>&-\nexec 4>&-\n`,
        mode,
      );
      assert.strictEqual(exit, 0, `Unexpected exit code: ${exit}`);
      assert.ok(stdout.includes('A'), `Expected 'A' in stdout: ${stdout}`);
      assert.ok(stdout.includes('S2:B'), `Expected 'S2:B' in stdout: ${stdout}`);
      server2.close();
    });

    it('connection refused: cat /dev/tcp/127.0.0.1/1 exits non-zero', async () => {
      const { stderr, exit } = await runShell(
        `cat < /dev/tcp/127.0.0.1/1\n`,
        mode,
      );
      assert.notStrictEqual(exit, 0, `Expected non-zero exit, got ${exit}`);
      assert.ok(stderr.length > 0, `Expected error in stderr, got empty`);
    });

    it('connection refused error message references the path', async () => {
      const { stderr } = await runShell(
        `exec 3> /dev/tcp/127.0.0.1/1\n`,
        mode,
      );
      assert.ok(
        stderr.includes('/dev/tcp/127.0.0.1/1'),
        `Expected path in error, got: ${stderr}`,
      );
    });
  });

  describe(`/dev/udp integration (${mode} mode)`, () => {
    let udpServer: DgramSocket;
    let udpPort: number;

    before(async () => {
      udpServer = createSocket('udp4');
      udpServer.on('message', (msg, rinfo) => {
        udpServer.send(msg, rinfo.port, rinfo.address);
      });
      await new Promise<void>((resolve) => udpServer.bind(0, '127.0.0.1', resolve));
      udpPort = udpServer.address().port;
    });

    after(() => {
      udpServer.close();
    });

    it('exec 3>/dev/udp/host/port opens without error', async () => {
      const { exit, stderr } = await runShell(
        `exec 3> /dev/udp/127.0.0.1/${udpPort}\necho "ok"\nexec 3>&-\n`,
        mode,
      );
      assert.strictEqual(exit, 0, `Expected exit 0, stderr: ${stderr}`);
    });

    it('echo >&3 sends data to UDP server', async () => {
      const received = new Promise<string>((resolve) => {
        udpServer.once('message', (msg) => resolve(msg.toString()));
      });

      await runShell(
        `exec 3> /dev/udp/127.0.0.1/${udpPort}\necho -n "udp_${mode}" >&3\nexec 3>&-\n`,
        mode,
      );

      const msg = await Promise.race([
        received,
        new Promise<string>((_, reject) => setTimeout(() => reject(new Error('timeout')), 7000)),
      ]);
      assert.strictEqual(msg, `udp_${mode}`);
    });

    it('UDP send via redirect: echo > /dev/udp/host/port', async () => {
      const received = new Promise<string>((resolve) => {
        udpServer.once('message', (msg) => resolve(msg.toString()));
      });

      await runShell(
        `echo -n "udp_redirect" > /dev/udp/127.0.0.1/${udpPort}\n`,
        mode,
      );

      const msg = await Promise.race([
        received,
        new Promise<string>((_, reject) => setTimeout(() => reject(new Error('timeout')), 7000)),
      ]);
      assert.strictEqual(msg, 'udp_redirect');
    });
  });
}
