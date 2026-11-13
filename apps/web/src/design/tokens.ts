// The one source of truth for Veylo's visual design (L42). Every colour in the web app comes from
// here: CSS reads the generated variables (scripts/gen-tokens.mjs writes src/design/tokens.css), and
// script (the globe) reads this object. A guard test fails on any literal hex colour elsewhere.
//
// Colour meaning is enforced by a guard test too:
//   private*  (amber)  only for things that are private;
//   success*  (green)  only for success or passed checks;
//   error*    (red)    only for errors or refusals.
// Erasable TypeScript only (no enums), so Node can run this file directly.

export const color = {
  // Ink and actions
  ink: "#0A0E1F",
  inkHover: "#1B2140",
  // Accent indigo. `accentInk` is the text-safe shade (4.5:1 on light surfaces).
  accent: "#5B6CFF",
  accentInk: "#3343C9",
  accentSoft: "#7C8BFF",
  accentDeep: "#3D4FE0",
  accentPale: "#C9CEFF",
  accentCode: "#A9B2FF",
  // Private amber. `privateInk` is text on the amber tint.
  private: "#F5B94A",
  privateInk: "#7A5200",
  privateLight: "#F8D38E",
  privateMarquee: "#8F6210",
  privateTileFrom: "#FFD27A",
  privateTileTo: "#E0961A",
  // Success green. `successInk` is text on light; `successOnDark` is text on dark.
  success: "#1E9E6A",
  successInk: "#126344",
  successOnDark: "#3DDC97",
  mintTileFrom: "#5BE3A9",
  mintTileTo: "#13996A",
  // Error red
  error: "#C2410C",
  errorOnDark: "#F2777A",
  // Light surfaces and text
  page: "#F4F5F8",
  card: "#FFFFFF",
  soft: "#EBEDF2",
  softHover: "#E1E4EC",
  line: "#DFE2EA",
  lineSoft: "#EEF0F5",
  text: "#0A0E1F",
  textSecondary: "#2A3048",
  textMuted: "#5D6480",
  textDim: "#8A90A8",
  // Dark surfaces and text
  dark0: "#0A0E1F",
  dark1: "#111832",
  dark2: "#151D3B",
  dark3: "#232A47",
  darkBandTop: "#141A33",
  darkBandBottom: "#06080F",
  darkText: "#F1F4FB",
  darkMuted: "#A3ADC8",
  darkDim: "#7E87A8",
  darkBody: "#C9CFE6",
  darkFooter: "#9AA1BE",
  // Tints
  tintIndigo: "#E4E7FF",
  tintAmber: "#FFF0D4",
  tintMint: "#DDF4EA",
  tintLilac: "#ECE6FF",
  // Pure white for text on dark buttons
  white: "#FFFFFF",
} as const;

export type ColorToken = keyof typeof color;

export const font = {
  sans: '"Inter Tight", system-ui, -apple-system, sans-serif',
  serif: '"Instrument Serif", Georgia, serif',
  mono: '"IBM Plex Mono", ui-monospace, Menlo, monospace',
} as const;

/** Pills for buttons and tags; cards from 20 to 36px. */
export const radius = { pill: "999px", sm: "14px", card: "20px", cardMd: "28px", cardLg: "36px" };

/** A 4px scale. */
export const space = [0, 4, 8, 12, 16, 20, 24, 32, 40, 48, 56, 64, 80, 96, 120] as const;

/** Two levels only. */
export const shadow = {
  low: "0 1px 2px rgba(10,14,31,.04), 0 4px 16px rgba(10,14,31,.06)",
  high: "0 24px 50px rgba(10,14,31,.10)",
} as const;

export const motion = {
  fast: "200ms",
  base: "400ms",
  slow: "800ms",
  ease: "cubic-bezier(.2,.8,.2,1)",
} as const;

/** The light theme (app default) and the dark theme, as semantic roles over the palette. */
export const themes = {
  light: {
    bg: color.page,
    surface: color.card,
    surfaceSoft: color.soft,
    surfaceSoftHover: color.softHover,
    border: color.line,
    borderSoft: color.lineSoft,
    fg: color.text,
    fgSecondary: color.textSecondary,
    fgMuted: color.textMuted,
    fgDim: color.textDim,
    action: color.ink,
    actionHover: color.inkHover,
    actionFg: color.white,
    accentText: color.accentInk,
    successText: color.successInk,
    errorText: color.error,
    privateText: color.privateInk,
    privateTint: color.tintAmber,
    successTint: color.tintMint,
    accentTint: color.tintIndigo,
  },
  dark: {
    bg: color.dark0,
    surface: color.dark1,
    surfaceSoft: color.dark2,
    surfaceSoftHover: color.dark3,
    border: color.dark3,
    borderSoft: color.dark2,
    fg: color.darkText,
    fgSecondary: color.darkBody,
    fgMuted: color.darkMuted,
    fgDim: color.darkDim,
    action: color.darkText,
    actionHover: color.white,
    actionFg: color.ink,
    accentText: color.accentPale,
    successText: color.successOnDark,
    errorText: color.errorOnDark,
    privateText: color.privateLight,
    privateTint: color.dark3,
    successTint: color.dark3,
    accentTint: color.dark3,
  },
} as const;

/** Hex to a number, for WebGL materials. */
export const hexNumber = (hex: string): number =>
  [...hex.slice(1).toLowerCase()].reduce((n, c) => n * 16 + "0123456789abcdef".indexOf(c), 0);

const kebab = (s: string) => s.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

/** The CSS custom properties, written to tokens.css at build. */
export function tokensCss(): string {
  const lines: string[] = [
    "/* Generated from src/design/tokens.ts by scripts/gen-tokens.mjs. Do not edit. */",
    ":root {",
  ];
  for (const [k, v] of Object.entries(color)) lines.push(`  --c-${kebab(k)}: ${v};`);
  for (const [k, v] of Object.entries(font)) lines.push(`  --font-${k}: ${v};`);
  for (const [k, v] of Object.entries(radius)) lines.push(`  --r-${kebab(k)}: ${v};`);
  space.forEach((v, i) => lines.push(`  --s-${i}: ${v}px;`));
  for (const [k, v] of Object.entries(shadow)) lines.push(`  --shadow-${k}: ${v};`);
  for (const [k, v] of Object.entries(motion)) lines.push(`  --motion-${k}: ${v};`);
  for (const [k, v] of Object.entries(themes.light)) lines.push(`  --${kebab(k)}: ${v};`);
  lines.push("}", ':root[data-theme="dark"] {');
  for (const [k, v] of Object.entries(themes.dark)) lines.push(`  --${kebab(k)}: ${v};`);
  lines.push("}", "");
  return lines.join("\n");
}
