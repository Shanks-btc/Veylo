"use client";
// Attaches the late font stylesheet (IBM Plex Mono, Instrument Serif) after first paint. Until it
// loads, those texts use the system fallbacks in the font stacks (font-display: swap).
import { useEffect } from "react";
import { LATE_FONTS_CSS } from "../design/fonts";

export function LateFonts() {
  useEffect(() => {
    if (document.querySelector(`link[href="${LATE_FONTS_CSS}"]`)) return;
    const attach = () => {
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = LATE_FONTS_CSS;
      document.head.appendChild(link);
    };
    // Two frames: the first paint has happened before this runs.
    requestAnimationFrame(() => requestAnimationFrame(attach));
  }, []);
  return null;
}
