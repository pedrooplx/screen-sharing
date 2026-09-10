import { createServer } from 'node:net';
import { createSocket } from 'node:dgram';

/**
 * A TCP+UDP port that is genuinely bindable right now. Plain "bind :0, read the
 * port, close" is racy on Windows: the OS hands out ports from ranges that may
 * be excluded (Hyper-V / WSL reservations), and the tests here need the SAME
 * number free for both TCP and UDP. Retries until it finds one.
 */
export async function freePort(attempts = 30): Promise<number> {
  for (let i = 0; i < attempts; i++) {
    const candidate = await pickCandidate();
    if (await bindable(candidate)) return candidate;
  }
  throw new Error('could not find a free TCP+UDP port');
}

function pickCandidate(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}

function bindable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const tcp = createServer();
    const udp = createSocket('udp4');
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      tcp.close();
      udp.close();
      resolve(ok);
    };
    tcp.once('error', () => finish(false));
    udp.once('error', () => finish(false));
    tcp.listen(port, '127.0.0.1', () => {
      udp.bind(port, '127.0.0.1', () => finish(true));
    });
  });
}
