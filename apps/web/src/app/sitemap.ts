import type { MetadataRoute } from "next";
import { siteOrigin } from "../site";

export const dynamic = "force-static";

/** The public pages: the app and the portal are behind sign-in. */
const PUBLIC_PATHS = [
  "/",
  "/docs",
  "/security",
  "/privacy",
  "/terms",
  "/verify",
  "/proof",
] as const;

export default function sitemap(): MetadataRoute.Sitemap {
  return PUBLIC_PATHS.map((path) => ({
    url: `${siteOrigin()}${path}`,
    changeFrequency: "monthly" as const,
    priority: path === "/" ? 1 : 0.6,
  }));
}
