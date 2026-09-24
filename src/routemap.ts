/**
 * The route map: not geography, just the stops in order, each with a small illustrated icon,
 * joined by a curving dashed line. Built as inline SVG so it stays crisp at any size.
 */
export interface RouteStopView {
  id: string;
  label: string;
  icon: string;
  number: number | null; // null for the start
}

const INK = '#3b3024';
const RED = '#c8553d';
const CREAM = '#fffaf2';

/** 48×48 icons drawn in the model's palette. Each sits centred on (0, 0). */
const ICONS: Record<string, string> = {
  home: `
    <path d="M-15 -1 L0 -15 L15 -1 Z" fill="#b8563f"/>
    <rect x="-12" y="-2" width="24" height="17" rx="1.5" fill="#efe3cc"/>
    <rect x="-3.5" y="5" width="7" height="10" rx="1" fill="#5f8f7d"/>
    <rect x="5" y="1" width="5" height="5" rx="0.8" fill="#8fb3c7"/>
    <rect x="7" y="-13" width="4" height="7" fill="#9b8466"/>`,
  shop: `
    <rect x="-14" y="-7" width="28" height="22" rx="1.5" fill="#f1ece0"/>
    <path d="M-16 -8 h32 v5 q-4 4 -8 0 q-4 4 -8 0 q-4 4 -8 0 q-4 4 -8 0 z" fill="#8cbca8"/>
    <rect x="-10" y="1" width="8" height="8" rx="1" fill="#8fb3c7"/>
    <rect x="3" y="1" width="7" height="14" rx="1" fill="#5f8f7d"/>
    <path d="M-5 -17 q2 -3 5 -1 l3 -2 l1 2 l-2 2 v4 h-2 v-3 h-4 v3 h-2 v-4 z" fill="#c9995f"/>`,
  hall: `
    <path d="M-16 -1 L-8 -13 L0 -1 Z M-2 -1 L7 -15 L16 -1 Z" fill="#8a6a4f"/>
    <rect x="-14" y="-2" width="28" height="17" rx="1.5" fill="#b59b7e"/>
    <rect x="-4" y="4" width="8" height="11" rx="1" fill="#6f9c8a"/>
    <rect x="-5" y="1.5" width="10" height="2.5" fill="#f1ece0"/>
    <rect x="-11" y="3" width="5" height="5" rx="0.8" fill="#9fc0d0"/>`,
  post: `
    <rect x="-15" y="-10" width="30" height="21" rx="2.5" fill="#e3b45c"/>
    <path d="M-15 -8 L0 3 L15 -8" fill="none" stroke="#9a6f2c" stroke-width="2.2" stroke-linejoin="round"/>
    <circle cx="10" cy="-11" r="5" fill="${RED}"/>
    <path d="M8 -11 h4" stroke="${CREAM}" stroke-width="1.6" stroke-linecap="round"/>`,
  coffee: `
    <path d="M-12 -3 h20 v7 a10 10 0 0 1 -20 0 z" fill="#f1ece0"/>
    <path d="M8 0 a5 5 0 0 1 0 8" fill="none" stroke="#f1ece0" stroke-width="3"/>
    <rect x="-12" y="-3" width="20" height="3" fill="#8b5a3c"/>
    <path d="M-6 -8 q-2 -3 0 -6 M0 -8 q-2 -3 0 -6" fill="none" stroke="#b9a58c" stroke-width="1.8" stroke-linecap="round"/>
    <ellipse cx="-2" cy="14" rx="14" ry="2.5" fill="#d9ccb4"/>`,
  phone: `
    <rect x="-9" y="-12" width="18" height="28" rx="2" fill="${RED}"/>
    <path d="M-9 -11 q9 -7 18 0" fill="#a8412c"/>
    <rect x="-6" y="-7" width="12" height="15" rx="1" fill="#bcd7e3"/>
    <path d="M-6 -2 h12 M-6 3 h12 M0 -7 v15" stroke="${RED}" stroke-width="1.4"/>
    <rect x="-6" y="-11" width="12" height="2.6" rx="0.6" fill="${CREAM}"/>`,
  default: `<circle r="13" fill="#d9c3a3"/>`,
};

/** A gentle wave through the points: each segment leaves and arrives vertically. */
function curve(points: [number, number][]): string {
  let d = `M${points[0][0]},${points[0][1]}`;
  for (let i = 0; i < points.length - 1; i++) {
    const [x1, y1] = points[i], [x2, y2] = points[i + 1];
    const k = (y2 - y1) * 0.55;
    d += ` C${x1},${y1 + k} ${x2},${y2 - k} ${x2},${y2}`;
  }
  return d;
}

/** A rubber-stamp star: translucent yellow ink, a slightly uneven double outline. */
function stampSvg(i: number): string {
  const pts = (R: number, r: number) => Array.from({ length: 10 }, (_, k) => {
    const a = -Math.PI / 2 + (k * Math.PI) / 5, rad = k % 2 ? r : R;
    return `${(Math.cos(a) * rad).toFixed(1)},${(Math.sin(a) * rad).toFixed(1)}`;
  }).join(' ');
  const tilt = [-14, 9, -6, 13, -10, 6][i % 6];
  return `
        <g class="stamp" aria-hidden="true"><g transform="rotate(${tilt})">
          <polygon points="${pts(30, 13)}" fill="#f5c518" fill-opacity="0.42" stroke="#e0a800" stroke-opacity="0.85" stroke-width="2.4" stroke-linejoin="round"/>
          <polygon points="${pts(24, 10.4)}" fill="none" stroke="#e0a800" stroke-opacity="0.6" stroke-width="1.2" stroke-linejoin="round" stroke-dasharray="5 2 9 2"/>
        </g></g>`;
}

const escapeXml = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** The open map: icons alternate high and low along a meandering dashed line. */
export function routeSvg(stops: RouteStopView[]): string {
  // Reads top to bottom: the start at top left, the last stop at bottom right. Stops zigzag
  // left and right while drifting rightwards; labels sit on the outer side of each icon.
  const n = stops.length;
  const W = 330, top = 46, gap = 82, H = top * 2 + (n - 1) * gap;
  const drift = n > 1 ? 140 / (n - 1) : 0;
  const pts: [number, number][] = stops.map((_, i) => [62 + i * drift + (i % 2) * 58, top + i * gap]);
  const path = curve(pts);
  const nodes = stops.map((s, i) => {
    const [x, y] = pts[i];
    const labelRight = i % 2 === 0;
    const badge = s.number === null ? '★' : String(s.number);
    return `
      <g class="stop" data-stop="${escapeXml(s.id)}" transform="translate(${x} ${y})">
        <circle r="29" fill="${CREAM}" stroke="#e2d5bd" stroke-width="1.5"/>
        <g transform="scale(1.18)">${ICONS[s.icon] ?? ICONS.default}</g>${s.number === null ? '' : stampSvg(i)}
        <g transform="translate(21 -21)">
          <circle r="9.5" fill="${s.number === null ? INK : RED}" stroke="${CREAM}" stroke-width="2.5"/>
          <text y="0.5" text-anchor="middle" dominant-baseline="middle" font-size="${s.number === null ? 10 : 11}" font-weight="700" fill="${CREAM}">${badge}</text>
        </g>
      </g>
      <text x="${labelRight ? x + 40 : x - 40}" y="${y + 5}" text-anchor="${labelRight ? 'start' : 'end'}" font-size="14" font-weight="650" fill="${INK}">${escapeXml(s.label)}</text>`;
  }).join('');
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Route: ${escapeXml(stops.map((s) => (s.number === null ? s.label : `${s.number}. ${s.label}`)).join(', '))}" font-family="ui-rounded, 'SF Pro Rounded', system-ui, sans-serif">
    <path d="${path}" fill="none" stroke="${CREAM}" stroke-width="7" stroke-linecap="round"/>
    <path d="${path}" fill="none" stroke="${RED}" stroke-width="3" stroke-linecap="round" stroke-dasharray="8 7"/>
    ${nodes}
  </svg>`;
}

/** The closed state: a small folded paper map (three panels, a dotted route and a pin). */
export const FOLDED_MAP_SVG = `
<svg viewBox="0 0 72 60" aria-hidden="true">
  <path d="M6 12 L26 6 L46 12 L66 6 L66 50 L46 56 L26 50 L6 56 Z" fill="#f6efe0"/>
  <path d="M26 6 L46 12 L46 56 L26 50 Z" fill="#e9dfca"/>
  <path d="M6 12 L26 6 L26 50 L6 56 Z" fill="#fbf6ec"/>
  <path d="M46 12 L66 6 L66 50 L46 56 Z" fill="#f1e8d6"/>
  <path d="M6 12 L26 6 L46 12 L66 6 L66 50 L46 56 L26 50 L6 56 Z" fill="none" stroke="#b9a68a" stroke-width="1.4" stroke-linejoin="round"/>
  <path d="M13 44 C20 34 24 40 32 30 S44 24 50 30 S58 22 60 17" fill="none" stroke="${RED}" stroke-width="2.2" stroke-linecap="round" stroke-dasharray="3.5 3.2"/>
  <circle cx="13" cy="44" r="3" fill="${INK}"/>
  <path d="M60 9 a5 5 0 0 1 5 5 c0 4 -5 9 -5 9 s-5 -5 -5 -9 a5 5 0 0 1 5 -5 z" fill="${RED}"/>
  <circle cx="60" cy="14" r="1.8" fill="${CREAM}"/>
</svg>`;
