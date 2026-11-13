import "../styles/landing.css";
import type { Metadata } from "next";
import { LandingNav } from "../landing/nav";
import { RevealController } from "../landing/reveal-controller";
import {
  Closing,
  Faq,
  Features,
  Footer,
  Hero,
  How,
  Marquee,
  QuoteBand,
  StorySection,
  Who,
} from "../landing/sections";
import { PRIVACY_CONDITION, SITE_DESCRIPTION, SITE_TITLE } from "../site";

export const metadata: Metadata = {
  title: SITE_TITLE,
  description: SITE_DESCRIPTION,
  alternates: { canonical: "/" },
  openGraph: {
    type: "website",
    url: "/",
    siteName: "Veylo",
    title: SITE_TITLE,
    description: `${SITE_DESCRIPTION} ${PRIVACY_CONDITION}`,
    images: [
      {
        url: "/og.jpg",
        width: 1200,
        height: 630,
        alt: "Pay your team anywhere. Keep payroll private.",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: SITE_TITLE,
    description: SITE_DESCRIPTION,
    images: ["/og.jpg"],
  },
};

export default function Landing() {
  return (
    <div className="landing">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <LandingNav />
      <RevealController />
      <main id="main">
        <Hero />
        <Marquee />
        <StorySection />
        <Features />
        <Who />
        <QuoteBand />
        <How />
        <Faq />
        <Closing />
      </main>
      <Footer />
    </div>
  );
}
