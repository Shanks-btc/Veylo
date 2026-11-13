"use client";
// 2. The 3D dotted globe with payout arcs. three.js is bundled (pinned, never a CDN) and loaded
// only after the page has painted and gone idle. Amber arcs are private and dissolve after the
// amber veil ring; indigo arcs are direct and stay visible. Mouse parallax; on scroll the globe
// pulls back and fades. Reduced motion or no WebGL: the static frame stays.
import { useEffect, useRef, useState } from "react";
import { color, hexNumber } from "../design/tokens";
import { prefersReducedMotion } from "../ui/motion";
import { GlobeFrame } from "./globe-frame";

/**
 * After first paint. With a mouse (hover), once the page is loaded and idle. On touch devices,
 * only after the first scroll, touch or key press: parsing three.js on a phone's main thread
 * before the visitor does anything would block it (Lighthouse TBT), and the photo and static
 * frame already show the globe.
 */
function afterFirstPaint(run: () => void): () => void {
  let cancelled = false;
  let idle: number | undefined;
  const hover = globalThis.matchMedia?.("(hover: hover) and (pointer: fine)").matches ?? false;
  if (!hover) {
    const events = ["scroll", "touchstart", "pointerdown", "keydown"] as const;
    const once = () => {
      for (const e of events) window.removeEventListener(e, once);
      if (!cancelled) idle = window.setTimeout(run, 300);
    };
    for (const e of events) window.addEventListener(e, once, { passive: true });
    return () => {
      cancelled = true;
      for (const e of events) window.removeEventListener(e, once);
      if (idle !== undefined) window.clearTimeout(idle);
    };
  }
  const go = () => {
    if (cancelled) return;
    const ric = (globalThis as { requestIdleCallback?: (cb: () => void, o?: object) => number })
      .requestIdleCallback;
    idle = ric ? ric(() => !cancelled && run(), { timeout: 4000 }) : window.setTimeout(run, 1500);
  };
  if (document.readyState === "complete") window.setTimeout(go, 1200);
  else window.addEventListener("load", () => window.setTimeout(go, 1200), { once: true });
  return () => {
    cancelled = true;
    if (idle !== undefined) window.clearTimeout(idle);
  };
}

export function HeroGlobe() {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [live, setLive] = useState(false);

  useEffect(() => {
    if (prefersReducedMotion()) return;
    let stop = () => {};
    const cancel = afterFirstPaint(async () => {
      const cv = canvas.current;
      if (!cv) return;
      try {
        const THREE = await import("three");
        let renderer: InstanceType<typeof THREE.WebGLRenderer>;
        try {
          renderer = new THREE.WebGLRenderer({ canvas: cv, antialias: true, alpha: true });
        } catch {
          return; // No WebGL: the photo and the static frame stay.
        }
        renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
        const scene = new THREE.Scene();
        const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 100);
        camera.position.set(0, 0.6, 7.4);
        const group = new THREE.Group();
        scene.add(group);
        group.position.y = -1.4;

        const n = 2600;
        const pos = new Float32Array(n * 3);
        for (let i = 0; i < n; i += 1) {
          const y = 1 - (i / (n - 1)) * 2;
          const r = Math.sqrt(1 - y * y);
          const th = i * 2.39996;
          pos[i * 3] = Math.cos(th) * r * 2;
          pos[i * 3 + 1] = y * 2;
          pos[i * 3 + 2] = Math.sin(th) * r * 2;
        }
        const geo = new THREE.BufferGeometry();
        geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
        group.add(
          new THREE.Points(
            geo,
            new THREE.PointsMaterial({
              color: hexNumber(color.accent),
              size: 0.022,
              transparent: true,
              opacity: 0.75,
            }),
          ),
        );
        const veilMat = new THREE.MeshBasicMaterial({
          color: hexNumber(color.private),
          transparent: true,
          opacity: 0.55,
        });
        const veil = new THREE.Mesh(new THREE.TorusGeometry(2.55, 0.012, 8, 200), veilMat);
        veil.rotation.x = Math.PI / 2.4;
        group.add(veil);
        const veilBand = new THREE.Mesh(
          new THREE.RingGeometry(2.3, 2.8, 128),
          new THREE.MeshBasicMaterial({
            color: hexNumber(color.private),
            transparent: true,
            opacity: 0.05,
            side: THREE.DoubleSide,
          }),
        );
        veilBand.rotation.x = Math.PI / 2.4;
        group.add(veilBand);

        const sph = (lat: number, lon: number) => {
          const a = (lat * Math.PI) / 180;
          const b = (lon * Math.PI) / 180;
          return new THREE.Vector3(
            2 * Math.cos(a) * Math.cos(b),
            2 * Math.sin(a),
            2 * Math.cos(a) * Math.sin(b),
          );
        };
        const hub = sph(20, -10);
        const dests = [
          [51, 0],
          [6, 3],
          [-23, -46],
          [19, 72],
          [1, 103],
          [40, -74],
          [-33, 151],
          [35, 139],
          [52, 13],
          [-1, 36],
        ] as const;
        type Arc = {
          curve: InstanceType<typeof THREE.QuadraticBezierCurve3>;
          dot: InstanceType<typeof THREE.Mesh>;
          mat: InstanceType<typeof THREE.MeshBasicMaterial>;
          priv: boolean;
          offset: number;
        };
        const arcs: Arc[] = dests.map(([lat, lon], k) => {
          const end = sph(lat, lon);
          const mid = hub.clone().add(end).multiplyScalar(0.5);
          mid.setLength(2 + hub.distanceTo(end) * 0.45);
          const curve = new THREE.QuadraticBezierCurve3(hub, mid, end);
          const priv = k % 2 === 0;
          group.add(
            new THREE.Line(
              new THREE.BufferGeometry().setFromPoints(curve.getPoints(60)),
              new THREE.LineBasicMaterial({
                color: hexNumber(priv ? color.private : color.accentSoft),
                transparent: true,
                opacity: 0.35,
              }),
            ),
          );
          const mat = new THREE.MeshBasicMaterial({
            color: hexNumber(priv ? color.private : color.accentPale),
            transparent: true,
          });
          const dot = new THREE.Mesh(new THREE.SphereGeometry(0.035, 12, 12), mat);
          group.add(dot);
          const endDot = new THREE.Mesh(
            new THREE.SphereGeometry(0.03, 10, 10),
            new THREE.MeshBasicMaterial({ color: hexNumber(color.darkText) }),
          );
          endDot.position.copy(end);
          group.add(endDot);
          return { curve, dot, mat, priv, offset: k / dests.length };
        });
        const hubDot = new THREE.Mesh(
          new THREE.SphereGeometry(0.07, 16, 16),
          new THREE.MeshBasicMaterial({ color: hexNumber(color.private) }),
        );
        hubDot.position.copy(hub);
        group.add(hubDot);

        const resize = () => {
          const w = cv.clientWidth;
          const h = cv.clientHeight;
          renderer.setSize(w, h, false);
          camera.aspect = w / Math.max(1, h);
          camera.updateProjectionMatrix();
        };
        resize();
        window.addEventListener("resize", resize);
        let mx = 0;
        let my = 0;
        const move = (e: PointerEvent) => {
          mx = e.clientX / window.innerWidth - 0.5;
          my = e.clientY / window.innerHeight - 0.5;
        };
        window.addEventListener("pointermove", move);
        const hero = cv.closest(".hero") as HTMLElement | null;
        let visible = true;
        const io = new IntersectionObserver(([e]) => {
          visible = e?.isIntersecting ?? true;
        });
        if (hero) io.observe(hero);

        let raf = 0;
        const loop = (ts: number) => {
          raf = requestAnimationFrame(loop);
          if (!visible) return;
          const t = ts / 1000;
          const sp = Math.min(1, Math.max(0, window.scrollY / (hero?.offsetHeight || 800)));
          camera.position.z = 7.4 + sp * 4;
          camera.position.y = 0.6 - sp * 1.2;
          cv.style.setProperty("opacity", String(1 - sp * 0.85));
          group.rotation.y = t * 0.08 + mx * 0.4;
          group.rotation.x = my * 0.15;
          for (const a of arcs) {
            const u = (t * 0.18 + a.offset) % 1;
            a.dot.position.copy(a.curve.getPoint(u));
            // Private dots dissolve once they pass the veil; direct dots stay.
            a.mat.opacity = a.priv ? Math.max(0, 1 - Math.max(0, u - 0.45) * 2.2) : 1;
            a.dot.scale.setScalar(a.priv && u > 0.45 ? 1 + (u - 0.45) * 6 : 1);
          }
          veilMat.opacity = 0.4 + 0.2 * Math.sin(t * 1.5);
          renderer.render(scene, camera);
        };
        raf = requestAnimationFrame(loop);
        setLive(true);
        stop = () => {
          cancelAnimationFrame(raf);
          io.disconnect();
          window.removeEventListener("resize", resize);
          window.removeEventListener("pointermove", move);
          renderer.dispose();
        };
      } catch {
        // Any failure keeps the photo and the static frame.
      }
    });
    return () => {
      cancel();
      stop();
    };
  }, []);

  return (
    <>
      <GlobeFrame hidden={live} />
      <canvas ref={canvas} className="hero-globe" aria-hidden="true" />
    </>
  );
}
