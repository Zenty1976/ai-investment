import { useEffect, useRef, useState } from "react";

export type TileSize = "xs" | "sm" | "md" | "lg";

/**
 * Observes the size of the given element ref and returns a semantic size tier.
 * Widgets use this to decide how much information to render.
 *
 * Tiers (based on inner pixel dimensions after TileShell chrome ~28px is removed):
 *   xs  — very small: icon + status only
 *   sm  — compact: title + 1–2 key metrics
 *   md  — medium: summary + short list
 *   lg  — large: full view — default at h:4 tiles (320px tile − 28px header = 292px content)
 *
 * Thresholds are tuned so that the default h:4 grid row (292px content) reaches "lg".
 */
export function useTileSize(ref: React.RefObject<HTMLElement | null>): TileSize {
  const [size, setSize] = useState<TileSize>("md");

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const compute = (width: number, height: number): TileSize => {
      if (width < 180 || height < 110) return "xs";
      if (width < 300 || height < 185) return "sm";
      if (width < 380 || height < 260) return "md";
      return "lg";
    };

    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      setSize(compute(width, height));
    });

    observer.observe(el);
    const { width, height } = el.getBoundingClientRect();
    setSize(compute(width, height));

    return () => observer.disconnect();
  }, [ref]);

  return size;
}
