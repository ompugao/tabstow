import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Resvg } from '@resvg/resvg-js';

const here = dirname(fileURLToPath(import.meta.url));
const svg = readFileSync(join(here, 'icon.svg'), 'utf8');
// The Chrome Web Store wants the 128px icon's artwork within the central 96px.
// Toolbar and extension-page sizes are too small for that padding, so they are
// cropped to the artwork.
const cropped = svg.replace('viewBox="0 0 128 128"', 'viewBox="16 16 96 96"');
const outDir = join(here, '..', 'public', 'icons');
mkdirSync(outDir, { recursive: true });
for (const size of [16, 32, 48, 128]) {
  const png = new Resvg(size === 128 ? svg : cropped, { fitTo: { mode: 'width', value: size } }).render().asPng();
  writeFileSync(join(outDir, `icon${size}.png`), png);
}
