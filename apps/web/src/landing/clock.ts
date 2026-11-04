import { type RefObject, useEffect, useState } from "react";

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

/**
 * Like useClock, but counting from when `ref` first comes into view, so a
 * demo further down the page plays from its start. Zero until then.
 */
export function useClockInView(ref: RefObject<Element | null>, stepMs: number, still: number) {
  const now = useClock(stepMs, still);
  const [reduced] = useState(reducedMotion);
  const [from, setFrom] = useState<number | null>(null);
  useEffect(() => {
    const element = ref.current;
    if (reduced || !element) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        setFrom(seconds());
        observer.disconnect();
      },
      { threshold: 0.3 },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref, reduced]);
  if (reduced) return still;
  return from === null ? 0 : Math.max(0, now - from);
}
