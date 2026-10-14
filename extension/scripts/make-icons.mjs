import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Resvg } from '@resvg/resvg-js';

const here = dirname(fileURLToPath(import.meta.url));
const svg = readFileSync(join(here, 'icon.svg'));
const outDir = join(here, '..', 'public', 'icons');
mkdirSync(outDir, { recursive: true });
for (const size of [16, 32, 48, 128]) {
  const png = new Resvg(svg, { fitTo: { mode: 'width', value: size } }).render().asPng();
  writeFileSync(join(outDir, `icon${size}.png`), png);
}
