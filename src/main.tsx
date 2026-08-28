import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App";

/*
 * No <StrictMode>.
 *
 * React 18's StrictMode mounts, unmounts and remounts every effect in development. For
 * react-three-fiber that means `unmountComponentAtNode` runs on the canvas, which calls
 * `forceContextLoss()` and then rebuilds the root on a canvas whose context it just threw
 * away. That breaks the product's first architectural rule — one WebGL context, created
 * once, never torn down (3D-SPEC §5) — fires our context-lost handler on every dev boot,
 * and poisons the `renderer.info` baseline the memory budget in §5 is measured against.
 *
 * The double-invoke safety StrictMode buys is not worth a dev environment that behaves
 * differently from production in exactly the subsystem this product is built around.
 */
const boot = () => createRoot(document.getElementById("root")!).render(<App />);

/*
 * `?drive=1` installs the deterministic frame driver (src/dev/drive.ts) BEFORE React
 * mounts — it patches ResizeObserver, which react-three-fiber observes during its very
 * first render, so it has to be in place already.
 *
 * ## Why the `import.meta.env.DEV` gate had to go (A23)
 *
 * Every performance number this project has ever published — cold start 123 ms,
 * `panelInDom` 218–1947 ms, every transition timing, every endurance loop — was measured
 * against a Vite dev server serving unbundled ES modules, and `dist/` was never captured
 * from once. The reason was this line: the gate meant `?drive=1` did nothing in a production
 * build, so the capture harness *could not* point at `vite preview` even if it wanted to.
 * An instrument that only exists in the environment you are not shipping is not an
 * instrument.
 *
 * A production build changes the shape of the entry frame in the direction that matters —
 * one chunk arriving, mounting and compiling together instead of a hundred module requests
 * interleaved — and can make the entry hitch **worse**, which is exactly the number §9
 * budgets. So the driver is reachable in both, and the cost of that is bounded and small:
 * the module is behind a dynamic `import()` gated on a query parameter, so Rollup emits it
 * as a separate chunk that a child's browser never requests. `index.html`'s inline hook is
 * already unconditional and already returns immediately without `?drive=1`.
 */
if (new URLSearchParams(window.location.search).has("drive")) {
  void import("./dev/drive").then((m) => {
    m.installDriver();
    boot();
  });
} else {
  boot();
}
