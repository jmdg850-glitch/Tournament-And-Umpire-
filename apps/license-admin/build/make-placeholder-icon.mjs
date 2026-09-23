// Generates a flat placeholder icon.png (matches index.html's theme-color).
// Replace with real brand artwork before a customer-facing production build.
import { PNG } from "pngjs";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const dir = dirname(fileURLToPath(import.meta.url));
const SIZE = 512;
// #062a2f
const R = 0x06, G = 0x2a, B = 0x2f;

const png = new PNG({ width: SIZE, height: SIZE });
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    const idx = (SIZE * y + x) << 2;
    png.data[idx] = R;
    png.data[idx + 1] = G;
    png.data[idx + 2] = B;
    png.data[idx + 3] = 255;
  }
}

const out = join(dir, "icon.png");
writeFileSync(out, PNG.sync.write(png));
console.log("wrote", out);
