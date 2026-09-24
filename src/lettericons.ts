/** Small line drawings for the corner of each place letter. */
const drawings: Record<string, string> = {
  wallys: `
    <path d="M7 17 10 12 24 11 38 13 41 18 M9 17c2 3 5 3 7 0 2 3 5 3 8 0 2 3 5 3 8 0 2 3 5 3 7 0"/>
    <path d="M10 21v18h29V21 M15 25h8v9h-8z M28 39V24h7v15 M16 8c4-2 10-2 14 0"/>
    <path d="m24 2 2 3-2 3-2-3z" class="icon-accent"/>`,
  city_hall: `
    <path d="m5 19 9-12 8 11 8-14 13 15 M8 19v18h32V19 M19 37V25h10v12 M14 25h3v4h-3z M33 25h3v4h-3z"/>
    <path d="M4 41c9-2 31-2 40 0 M22 22c3-1 5-1 8 0"/>`,
  post_office: `
    <path d="M6 14c10-2 25-2 36 0l-1 25c-10 2-25 2-35 0z M7 17l17 13 17-13 M6 38l13-13 M41 38 29 25"/>
    <path d="M31 18c2-2 5-2 7 0 M34 14v7" class="icon-accent"/>`,
  maple_cafe: `
    <path d="M9 19h25v9c0 8-6 12-13 12S9 36 9 28z M34 22c8-1 10 3 7 8-2 3-5 4-8 3 M7 42c9 2 24 2 33 0"/>
    <path d="M17 15c-3-4 3-5 0-10 M25 15c-2-4 3-6 1-10" class="icon-accent"/>`,
  grocer: `
    <path d="M9 16c5-2 24-2 29 0l-3 26H12z M16 16c0-8 14-8 14 0 M14 24c5-1 14-1 20 0"/>
    <path d="M23 34c-3-7 1-10 4-11 3 4 2 8-4 11z M23 33c-3-3-5-4-7-4" class="icon-accent"/>`,
  florist: `
    <path d="M24 20v22 M24 33c-7-1-10-5-11-9 6 0 10 3 11 9z M24 36c5-6 9-7 12-7-1 5-5 8-12 9"/>
    <path d="M24 14c-6-10 3-13 3-4 4-8 11-1 3 4 10 3 4 11-3 5-3 9-11 5-7-2-9 1-10-8-3-8z" class="icon-accent"/>
    <circle cx="25" cy="16" r="2"/>`,
  phone_booth: `
    <path d="M13 42V11c0-4 4-6 11-6s11 2 11 6v31 M11 42h26 M16 13h16v25H16z M16 22h16 M24 13v25"/>
    <path d="M21 27c1 4 4 6 7 6l2-2-2-2-2 1-3-3 1-2-2-2-2 2z" class="icon-accent"/>`,
};

export function letterIcon(id: string): string {
  return `<svg viewBox="0 0 48 48" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.55" stroke-linecap="round" stroke-linejoin="round">${drawings[id] ?? '<path d="m24 6 4 12 12 6-12 4-4 12-5-12-11-4 11-6z"/>'}</svg>`;
}
