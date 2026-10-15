import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";

/** Mounts a player and its signed-URL subscription only near the visible timeline. */
export function LazyChatMedia({
  children,
  compact = false,
  style,
}: {
  readonly children: ReactNode;
  readonly compact?: boolean;
  readonly style?: CSSProperties | undefined;
}) {
  const slot = useRef<HTMLSpanElement>(null);
  const [visible, setVisible] = useState(() => typeof IntersectionObserver === "undefined");
  useEffect(() => {
    const element = slot.current;
    if (visible || !element) return;
    let active = true;
    const observer = new IntersectionObserver(
      (entries) => {
        if (!active || !entries.some((entry) => entry.isIntersecting)) return;
        setVisible(true);
        observer.disconnect();
      },
      { rootMargin: "200px" },
    );
    observer.observe(element);
    return () => {
      active = false;
      observer.disconnect();
    };
  }, [visible]);
  if (visible) return children;
  return (
    <span
      ref={slot}
      aria-label="メディアを表示待ち"
      className="inline-block max-w-full align-middle rounded-md bg-muted/40"
      style={{ width: "20rem", height: compact ? "3rem" : "11.25rem", ...style }}
    />
  );
}
