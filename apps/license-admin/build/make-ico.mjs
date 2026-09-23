import pngToIco from "png-to-ico";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const dir = dirname(fileURLToPath(import.meta.url));
const png = join(dir, "icon.png");
const ico = join(dir, "icon.ico");
if (!existsSync(png)) {
  console.error("missing", png);
  process.exit(1);
}
const buf = await pngToIco(readFileSync(png));
writeFileSync(ico, buf);
console.log("wrote", ico, buf.length);
