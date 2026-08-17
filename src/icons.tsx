import type { ReactNode, SVGProps } from "react";

export type IconName =
  | "box"
  | "brush"
  | "clear"
  | "cube"
  | "download"
  | "erase"
  | "fit"
  | "grid"
  | "hand"
  | "redo"
  | "shuffle"
  | "top"
  | "undo"
  | "upload";

interface IconProps extends SVGProps<SVGSVGElement> {
  name: IconName;
}

export function Icon({ name, ...props }: IconProps) {
  const common = {
    width: 18,
    height: 18,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.8,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
  };

  const paths: Record<IconName, ReactNode> = {
    box: <><path d="M4 6.5 12 2l8 4.5v10L12 21l-8-4.5z"/><path d="m4 6.5 8 4.5 8-4.5M12 11v10"/></>,
    brush: <><path d="M4 17.5 16.5 5a2.1 2.1 0 0 1 3 3L7 20.5H3.5z"/><path d="m13.5 8 3 3"/></>,
    clear: <><path d="M4 7h16M9 7V4h6v3m-8 0 1 14h8l1-14M10 11v6m4-6v6"/></>,
    cube: <><path d="m12 2 8 4.5v11L12 22l-8-4.5v-11z"/><path d="m4 6.5 8 4.5 8-4.5M12 11v11"/></>,
    download: <><path d="M12 3v12m-4-4 4 4 4-4"/><path d="M5 20h14"/></>,
    erase: <><path d="m4 15 8.5-9a2 2 0 0 1 3 0l3 3a2 2 0 0 1 0 3L11 20H7z"/><path d="m10 9 7 7M11 20h9"/></>,
    fit: <><path d="M8 3H3v5m13-5h5v5M8 21H3v-5m18 0v5h-5"/><path d="M8 8h8v8H8z"/></>,
    grid: <><path d="M4 4h16v16H4zM4 10h16M10 4v16"/><path d="M10 15h10M15 10v10"/></>,
    hand: <path d="M7.5 12V7.5a1.5 1.5 0 0 1 3 0V11m0-5V4.5a1.5 1.5 0 0 1 3 0V11m0-5V5a1.5 1.5 0 0 1 3 0v7m0-4.5a1.5 1.5 0 0 1 3 0V14c0 4-2.5 7-6.5 7H11c-2.2 0-3.4-1.1-4.5-2.7L3.8 14a1.6 1.6 0 0 1 2.6-1.8l1.1 1.3z"/>,
    redo: <><path d="m15 5 4 4-4 4"/><path d="M19 9h-8a6 6 0 0 0-6 6v2"/></>,
    shuffle: <><path d="M17 3h4v4M3 6h4c5 0 5 12 10 12h4"/><path d="m17 15 4 3-4 3M3 18h4c1.7 0 2.8-1.4 3.8-3"/><path d="M13.2 9C14.2 7.3 15.3 6 17 6h4"/></>,
    top: <><path d="M4 4h16v16H4z"/><path d="M8 8h8v8H8zM4 10h4m8 4h4"/></>,
    undo: <><path d="m9 5-4 4 4 4"/><path d="M5 9h8a6 6 0 0 1 6 6v2"/></>,
    upload: <><path d="M12 16V4m-4 4 4-4 4 4"/><path d="M5 20h14"/></>,
  };

  return <svg {...common} {...props}>{paths[name]}</svg>;
}
