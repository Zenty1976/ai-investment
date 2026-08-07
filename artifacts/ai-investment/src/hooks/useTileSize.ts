import { useEffect, useRef, useState } from "react";

export type TileSize = "xs" | "sm" | "md" | "lg";

/**
 * Observes the size of the given element ref and returns a semantic size tier.
 * Widgets use this to decide how much information to render.
 *
 * Tiers (based on pixel dimensions):
 *   xs  — very small tile: icon + status badge only
 *   sm  — compact tile: title + 1-2 key metrics
 *   md  — medium tile: summary + key metrics list
 *   lg  — large tile: full-featured view with lists/charts
 */
export function useTileSize(ref: React.RefObject<HTMLElement | null>): TileSize {
  const [size, setSize] = useState<TileSize>("md");

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const compute = (width: number, height: number): TileSize => {
      if (width < 210 || height < 140) return "xs";
      if (width < 360 || height < 230) return "sm";
      if (width < 530 || height < 340) return "md";
      return "lg";
    };

    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      setSize(compute(width, height));
    });

    observer.observe(el);
    // Compute immediately from current dimensions
    const { width, height } = el.getBoundingClientRect();
    setSize(compute(width, height));

    return () => observer.disconnect();
  }, [ref]);

  return size;
}
