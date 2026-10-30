import { useEffect, useState } from "react";

// One start time for the whole page: the landing page can remount while
// sign-in loads, and the animations should carry on rather than restart.
const T0 = performance.now();

const reducedMotion = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

const seconds = () => (performance.now() - T0) / 1000;

/**
 * Seconds since the page loaded, updated every `stepMs`. Visitors who ask
 * for less motion get the fixed `still` value instead.
 */
export function useClock(stepMs: number, still: number) {
  const [reduced] = useState(reducedMotion);
  const [now, setNow] = useState(seconds);
  useEffect(() => {
    if (reduced) return;
    const timer = setInterval(() => setNow(seconds()), stepMs);
    return () => clearInterval(timer);
  }, [reduced, stepMs]);
  return reduced ? still : now;
}
