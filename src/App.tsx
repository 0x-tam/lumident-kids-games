import { Suspense, lazy } from "react";
import GamesCollection from "./GamesCollection";
import Welcome from "./Welcome";
import { PlayerProvider, usePlayer } from "./shared/player";
import { Stage } from "./three/Stage";
import { FLAGS } from "./three/store";

/*
 * `?selftest=<name>` needs the harness present even on a scene whose game does not import
 * it — the shared collider assertion in `src/dev/selftest.ts` applies everywhere. Dev-only,
 * same substitution trick as the probe below, so the harness never ships.
 */
if (import.meta.env.DEV && FLAGS.selftest !== null) void import("./dev/selftest");

/*
 * `?probe=1` mounts the foundation smoke scene (src/dev/probe.tsx).
 *
 * Dev-only, and gated the same way `?drive` is in `main.tsx`: `import.meta.env.DEV` is
 * substituted with the literal `false` at build time, so the `import()` sits in a branch
 * Rollup deletes — the probe chunk is never emitted and the query string can never reach a
 * debug scene in production. Behind `React.lazy` so it costs the hub nothing in dev either.
 */
const Probe = import.meta.env.DEV ? lazy(() => import("./dev/probe")) : null;
const SHOW_PROBE =
  import.meta.env.DEV &&
  typeof window !== "undefined" &&
  new URLSearchParams(window.location.search).has("probe");

function Screen() {
  const { player } = usePlayer();
  return player ? <GamesCollection /> : <Welcome />;
}

export default function App() {
  return (
    <PlayerProvider>
      {/*
        One WebGL context for the whole app (3D-SPEC §5). It is mounted above the screens
        so that switching between the welcome screen, the hub and any game never remounts
        it. The canvas is fixed at z-index 0 with pointer-events none; the DOM UI sits on
        top of it at z-index 10 and owns every pointer.
      */}
      <Stage />
      {SHOW_PROBE && Probe !== null ? (
        // The probe replaces the app rather than overlaying it. The 3D always paints from
        // the single canvas at z-index 0, so an overlaid probe would just be a scene half
        // hidden behind the hub — useless as a thing to inspect.
        <Suspense fallback={null}>
          <Probe />
        </Suspense>
      ) : (
        <div className="relative z-10">
          <Screen />
        </div>
      )}
    </PlayerProvider>
  );
}
