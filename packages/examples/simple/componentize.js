import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { componentize } from '@bytecodealliance/componentize-js';

const jsSource = await readFile('src/index.js', 'utf8');
const outputDir = './dist';

const { component } = await componentize(jsSource, {
  witPath: './wit',
  worldName: 'simple',
  disableFeatures: ['http', 'fetch-event'],
});

if (!existsSync(outputDir)) {
  await mkdir(outputDir, { recursive: true });
}
await writeFile(`${outputDir}/component.wasm`, component);
