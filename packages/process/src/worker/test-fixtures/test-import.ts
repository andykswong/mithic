
import '@mithic/worker';
import { parentPort } from 'node:worker_threads';
parentPort!.postMessage('imported ok');
