import fs from 'node:fs';
import { PNG } from 'pngjs';

const BODY = 824, CANVAS = 1024, OFF = (CANVAS - BODY) / 2;
const N = 5;   // superellipse exponent ≈ Apple's continuous corner
const SS = 4;  // supersampling → smooth antialiased edge

const body = PNG.sync.read(fs.readFileSync('/tmp/mocca/body.png'));
const out = new PNG({ width: CANVAS, height: CANVAS });
out.data.fill(0); // fully transparent canvas

const c = BODY / 2;
for (let y = 0; y < BODY; y++) {
  for (let x = 0; x < BODY; x++) {
    let inside = 0;
    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        const u = (x + (sx + 0.5) / SS - c) / c;
        const v = (y + (sy + 0.5) / SS - c) / c;
        if (Math.abs(u) ** N + Math.abs(v) ** N <= 1) inside++;
      }
    }
    if (!inside) continue;
    const cov = inside / (SS * SS);
    const si = (y * BODY + x) * 4;
    const di = ((y + OFF) * CANVAS + (x + OFF)) * 4;
    out.data[di] = body.data[si];
    out.data[di + 1] = body.data[si + 1];
    out.data[di + 2] = body.data[si + 2];
    out.data[di + 3] = Math.round(body.data[si + 3] * cov);
  }
}
fs.writeFileSync('assets/icon.png', PNG.sync.write(out));
console.log('wrote assets/icon.png — 1024 squircle, transparent corners');
