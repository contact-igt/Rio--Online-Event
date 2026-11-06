// Small monoline icons drawn for this project (24x24, stroke only). Decorative by default: the text beside them carries the meaning.
// Not illustrations and not the event artwork; just interface glyphs.

const paths = {
  trophy: "M8 21h8M12 17v4M7 4h10v5a5 5 0 0 1-10 0V4ZM7 6H4v1a3 3 0 0 0 3 3M17 6h3v1a3 3 0 0 1-3 3",
  users: "M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7ZM2.5 20c0-3.3 2.9-6 6.5-6s6.5 2.7 6.5 6M16.5 4.5a3.2 3.2 0 0 1 0 6M18 14.3c2 .7 3.5 2.6 3.5 5.2",
  video: "M3 7a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7ZM15 10l6-3v10l-6-3",
  laptop: "M5 6h14v9H5zM2.5 19h19",
  mail: "M3 6h18v12H3zM3 7l9 6 9-6",
  edit: "M4 20l1-4L16.5 4.5a2 2 0 0 1 3 3L8 19l-4 1ZM14 7l3 3",
  upload: "M12 16V5M7.5 9.5 12 5l4.5 4.5M4 16v3h16v-3",
  check: "m5 12.5 4.5 4.5L19 7.5",
  calendar: "M4 6h16v14H4zM4 10h16M8 3v4M16 3v4",
  mic: "M12 14a3.5 3.5 0 0 0 3.5-3.5V6a3.5 3.5 0 0 0-7 0v4.5A3.5 3.5 0 0 0 12 14ZM6 11a6 6 0 0 0 12 0M12 17v4",
  book: "M12 6c-2-1.5-5-2-8-1.5v13c3-.5 6 0 8 1.5 2-1.5 5-2 8-1.5v-13C17 4 14 4.5 12 6ZM12 6v13",
  scroll: "M7 4h11v13a3 3 0 0 1-3 3H6a3 3 0 0 0 3-3V4ZM7 4a2 2 0 0 0-2 2v1h2M10 9h5M10 12.5h5",
  palette: "M12 3a9 9 0 1 0 0 18c1.5 0 2-1 1.5-2-.5-1 0-2.5 1.5-2.5h2a3.5 3.5 0 0 0 3.5-3.5C20.5 7 16.5 3 12 3ZM7.5 11h.01M10 7.5h.01M14.5 7.5h.01",
  chat: "M4 5h16v11H11l-4 4v-4H4zM8.5 9.5h7M8.5 12.5h4",
  smile: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM8.5 14a4 4 0 0 0 7 0M9 9.5h.01M15 9.5h.01",
  info: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM12 11v5M12 8h.01",
  arrow: "M5 12h14M13 6l6 6-6 6",
  chevron: "m9 6 6 6-6 6",
  lock: "M6 11h12v9H6zM8.5 11V8a3.5 3.5 0 0 1 7 0v3",
  star: "m12 3.5 2.6 5.4 5.9.8-4.3 4.1 1 5.9L12 16.9 6.8 19.7l1-5.9L3.5 9.7l5.9-.8L12 3.5Z",
  list: "M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01",
  clipboard: "M9 4h6v3H9zM7 5.5H5v15h14v-15h-2M9 12h6M9 16h4",
  user: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM4.5 20c0-3.6 3.4-6 7.5-6s7.5 2.4 7.5 6",
  play: "M8 5v14l11-7z",
} as const;

export type IconName = keyof typeof paths;

export function Icon({ name, className = "h-6 w-6" }: { name: IconName; className?: string }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className={`shrink-0 fill-none stroke-current ${className}`} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d={paths[name]} />
    </svg>
  );
}

// One glyph per competition, chosen by what the task is, so the cards are easy to tell apart at a glance.
export const eventIcon: Record<string, IconName> = {
  "malalai-mozhi": "smile",
  "kathai-sollum-kutties": "book",
  "thirukkural-thiramai": "scroll",
  "kutti-pesalar": "mic",
  "tamil-kalaikoodam": "palette",
  "tamilil-sollu": "chat",
};
