// Self-hosted fonts, Latin subset only (W2.1 R2). Inter Tight, the weights above the fold, is
// declared in the page's CSS and preloaded. IBM Plex Mono and Instrument Serif are declared in a
// separate stylesheet that script attaches after first paint, so they never block it.
// Erasable TypeScript only, so Node can run this file directly.

export type FontFile = {
  readonly family: string;
  readonly weight: number;
  readonly pkg: string;
  readonly file: string;
};

const latin = (pkg: string, family: string, weight: number): FontFile => ({
  family,
  weight,
  pkg,
  file: `${pkg}-latin-${weight}-normal.woff2`,
});

/** Above the fold, preloaded: headline (600), body (400), buttons and nav (500). */
export const EARLY_FONTS: readonly FontFile[] = [
  latin("inter-tight", "Inter Tight", 400),
  latin("inter-tight", "Inter Tight", 500),
  latin("inter-tight", "Inter Tight", 600),
];

/** After first paint, never preloaded. */
export const LATE_FONTS: readonly FontFile[] = [
  latin("ibm-plex-mono", "IBM Plex Mono", 400),
  latin("ibm-plex-mono", "IBM Plex Mono", 500),
  latin("instrument-serif", "Instrument Serif", 400),
];

export const fontUrl = (f: FontFile): string => `/fonts/${f.file}`;
export const LATE_FONTS_CSS = "/fonts/late.css";

export function fontFaceCss(fonts: readonly FontFile[]): string {
  return fonts
    .map(
      (f) =>
        `@font-face{font-family:"${f.family}";font-style:normal;font-weight:${f.weight};font-display:swap;src:url(${fontUrl(f)}) format("woff2");unicode-range:U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD;}`,
    )
    .join("\n");
}
