// The landing page's photos (design/images, Unsplash-licensed: design/images/LICENSES.md). The
// originals are never changed: scripts/images.mjs crops them and writes AVIF, WebP and JPEG at each
// width into public/img at build. Width and height come from the crop, so nothing shifts on load.
// Erasable TypeScript only, so Node can run this file directly.

export type Crop = { left: number; top: number; width: number; height: number };

export type ImageSpec = {
  readonly source: string;
  /** In source pixels. */
  readonly crop: Crop;
  /** Regions blurred out, in source pixels (text or logos that aren't ours). */
  readonly blur: readonly Crop[];
  readonly widths: readonly number[];
};

export const IMAGES = {
  // The man, the laptop and the world map; the red wall sign above the map is cropped out.
  hero: {
    source: "hero-team.jpg",
    crop: { left: 0, top: 1860, width: 3793, height: 3340 },
    blur: [],
    widths: [640, 1080, 1600, 2200],
  },
  // Ada and the sofa; the painting's lettering is cropped out and the laptop's maker logo blurred.
  ada: {
    source: "story-ada.jpg",
    crop: { left: 1750, top: 950, width: 2350, height: 2350 },
    blur: [{ left: 1980, top: 1950, width: 260, height: 190 }],
    widths: [160, 320],
  },
  kelvin: {
    source: "story-kelvin.jpg",
    crop: { left: 960, top: 0, width: 1800, height: 1800 },
    blur: [],
    widths: [160, 320],
  },
} as const satisfies Record<string, ImageSpec>;

export type ImageKey = keyof typeof IMAGES;
export const IMAGE_FORMATS = ["avif", "webp", "jpg"] as const;

export const imagePath = (key: ImageKey, width: number, format: string): string =>
  `/img/${key}-${width}.${format}`;

/** Intrinsic size at the largest width, for the width and height attributes. */
export function imageSize(key: ImageKey): { width: number; height: number } {
  const spec: ImageSpec = IMAGES[key];
  const width = spec.widths[spec.widths.length - 1] ?? spec.crop.width;
  return { width, height: Math.round((width * spec.crop.height) / spec.crop.width) };
}

/**
 * Problems with design/images/LICENSES.md: the build fails on any. Every source photo must be
 * named in it, so no image ships without its licence recorded.
 */
export function licenceProblems(
  licences: string | undefined,
  sources: readonly string[],
): string[] {
  if (licences === undefined) return ["design/images/LICENSES.md is missing"];
  return sources
    .filter((s) => !licences.includes(s))
    .map((s) => `design/images/LICENSES.md doesn't name ${s}`);
}
