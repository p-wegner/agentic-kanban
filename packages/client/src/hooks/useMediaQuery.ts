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

/** True below Tailwind's `sm` breakpoint (<640px) — i.e. phone-width screens. */
export function useIsNarrow(): boolean {
  return useMediaQuery("(max-width: 639px)");
}
