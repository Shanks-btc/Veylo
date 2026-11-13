// Build step: responsive AVIF, WebP and JPEG from design/images (originals untouched), the Open
// Graph image from the hero, and the photo licences copied alongside.
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { IMAGES, imagePath, licenceProblems } from "../src/design/images.ts";
import { color } from "../src/design/tokens.ts";

const web = fileURLToPath(new URL("..", import.meta.url));
const sources = join(web, "..", "..", "design", "images");
const pub = join(web, "public");
const licences = join(sources, "LICENSES.md");
const problems = licenceProblems(
  existsSync(licences) ? readFileSync(licences, "utf8") : undefined,
  [...new Set(Object.values(IMAGES).map((s) => s.source))],
);
if (problems.length > 0) {
  for (const p of problems) console.error(`images: ${p}`);
  process.exit(1);
}
mkdirSync(join(pub, "img"), { recursive: true });

async function cropped(spec) {
  let img = sharp(join(sources, spec.source)).rotate();
  if (spec.blur.length > 0) {
    const patches = await Promise.all(
      spec.blur.map(async (r) => ({
        input: await sharp(join(sources, spec.source)).extract(r).blur(40).toBuffer(),
        left: r.left,
        top: r.top,
      })),
    );
    img = sharp(await img.composite(patches).toBuffer());
  }
  return sharp(await img.extract(spec.crop).toBuffer());
}

let files = 0;
for (const [key, spec] of Object.entries(IMAGES)) {
  const base = await (await cropped(spec)).toBuffer();
  for (const width of spec.widths) {
    const resized = () => sharp(base).resize({ width });
    await resized()
      .avif({ quality: 50 })
      .toFile(join(pub, imagePath(key, width, "avif")));
    await resized()
      .webp({ quality: 72 })
      .toFile(join(pub, imagePath(key, width, "webp")));
    await resized()
      .jpeg({ quality: 78, mozjpeg: true })
      .toFile(join(pub, imagePath(key, width, "jpg")));
    files += 3;
  }
}

// Open Graph image: the hero crop under the navy wash, with the headline.
const wash = Buffer.from(
  `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630">
    <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${color.ink}" stop-opacity=".78"/>
      <stop offset="1" stop-color="${color.ink}" stop-opacity=".9"/></linearGradient></defs>
    <rect width="1200" height="630" fill="url(#g)"/>
    <text x="80" y="300" font-family="Inter Tight, Segoe UI, Arial, sans-serif" font-size="68" font-weight="600" fill="${color.darkText}">Pay your team anywhere.</text>
    <text x="80" y="390" font-family="Inter Tight, Segoe UI, Arial, sans-serif" font-size="68" font-weight="600" fill="${color.private}">Keep payroll private.</text>
    <text x="80" y="520" font-family="Inter Tight, Segoe UI, Arial, sans-serif" font-size="32" font-weight="600" fill="${color.darkText}">veylo</text>
  </svg>`,
);
const hero = await (await cropped(IMAGES.hero)).toBuffer();
await sharp(hero)
  .resize(1200, 630, { fit: "cover", position: "attention" })
  .composite([{ input: wash }])
  .jpeg({ quality: 82, mozjpeg: true })
  .toFile(join(pub, "og.jpg"));
files += 1;

copyFileSync(licences, join(pub, "img", "LICENSES.md"));
files += 1;
console.log(`images: wrote ${files} file(s)`);
