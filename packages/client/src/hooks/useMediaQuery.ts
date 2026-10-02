import { useEffect, useState } from "react";

/**
 * Reactive `window.matchMedia` hook — re-renders when the query's match state
 * flips (e.g. on resize / orientation change). Mirrors the matchMedia idiom in
 * `useTheme.ts`.
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() =>
    typeof window !== "undefined" ? window.matchMedia(query).matches : false,
  );

  useEffect(() => {
    const mq = window.matchMedia(query);
    const handler = () => setMatches(mq.matches);
    handler();
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, [query]);

  return matches;
}

/** True from `sm` up to below `lg` (640–1023px) — tablet-width screens. */
export function useIsTablet(): boolean {
  return useMediaQuery("(min-width: 640px) and (max-width: 1023px)");
}

/** True below Tailwind's `sm` breakpoint (<640px) — i.e. phone-width screens. */
export function useIsNarrow(): boolean {
  return useMediaQuery("(max-width: 639px)");
}
