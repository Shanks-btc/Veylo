import "../design/fonts.css";
import "../design/tokens.css";
import "../styles/base.css";
import "../styles/ui.css";
import "../styles/w6.css";
import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { preload } from "react-dom";
import { EARLY_FONTS, fontUrl } from "../design/fonts";
import { DemoBanner } from "../ui/demo-banner";
import { LateFonts } from "../ui/late-fonts";
import { color } from "../design/tokens";
import { siteOrigin } from "../site";

// Fonts are self-hosted (font-src 'self'), Latin only. Only Inter Tight is preloaded; IBM Plex
// Mono and Instrument Serif load after first paint (src/ui/late-fonts.tsx).
export const metadata: Metadata = {
  metadataBase: new URL(siteOrigin()),
  title: "Veylo",
};

export const viewport: Viewport = { themeColor: color.ink };

export default function RootLayout({ children }: { children: ReactNode }) {
  for (const f of EARLY_FONTS)
    preload(fontUrl(f), { as: "font", type: "font/woff2", crossOrigin: "" });
  return (
    <html lang="en">
      <body>
        <DemoBanner />
        {children}
        <LateFonts />
      </body>
    </html>
  );
}
