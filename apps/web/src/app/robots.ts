import type { MetadataRoute } from "next";
import { siteOrigin } from "../site";

export const dynamic = "force-static";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [{ userAgent: "*", allow: "/", disallow: "/app/" }],
    sitemap: `${siteOrigin()}/sitemap.xml`,
  };
}
