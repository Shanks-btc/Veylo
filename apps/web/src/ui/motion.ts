// Reduced motion: every animation in script asks this first, and shows its final value instead.
export function prefersReducedMotion(): boolean {
  try {
    return globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? true;
  } catch {
    return true;
  }
}
