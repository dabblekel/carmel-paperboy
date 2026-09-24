/** Per-model guide settings (public/models/<id>/guide.json). */
export interface GuideConfig {
  tooltips: string[];
  /** Map stops in order; "start" is the courier's starting point. */
  route: string[];
  startLabel?: string;
  /** Icon per stop id: home, shop, hall, post, coffee, phone. */
  icons?: Record<string, string>;
  map?: { title?: string };
  /** Tighter walk-up areas for doors with nearby scenery or people. Distances are in metres. */
  doorRange?: Record<string, { open: number; keep: number; across: number }>;
  conversation?: {
    after: string;
    npcNode: string;
    npcText: string | string[];
    replyText: string | string[];
  };
  greetings?: { npcNode: string; text: string }[];
}
