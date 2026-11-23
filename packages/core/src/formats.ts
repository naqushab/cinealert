// BMS keeps formats on two levels:
//  1. format chip  = separate child event code (2D, 3D, IMAX 3D, 4DX 3D, ICE 3D ...)
//  2. screen label = show.screenAttr (PXL, Infinity Vision, ScreenX, INSIGNIA ...)
// A wanted format matches if any alias is a substring of "<chip title> <screen label>".
export const FORMAT_ALIASES: Record<string, string[]> = {
  IMAX: ["imax"],
  PXL: ["pxl"],
  INFINITY_VISION: ["infinity vision", "infinity vsn", "inf vsn", "infvsn", "invsn", "inf vision"],
  "4DX": ["4dx"],
  SCREENX: ["screenx", "screen x"],
  ICE: ["ice"],
  EPIQ: ["epiq"],
  DOLBY: ["dolby"],
  INSIGNIA: ["insignia"],
  "3D": ["3d"],
  "2D": ["2d"],
};

export function aliasesFor(name: string): string[] {
  const key = name.trim().toUpperCase().replace(/[\s-]+/g, "_");
  return FORMAT_ALIASES[key] || FORMAT_ALIASES[name.trim().toUpperCase()] || [name.trim().toLowerCase()];
}

const norm = (s: string) => ` ${s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()} `;

export function formatMatches(label: string, wanted: string): boolean {
  const hay = norm(label);
  return aliasesFor(wanted).some((a) => hay.includes(norm(a)) || (!/\d$/.test(a) && hay.replace(/ /g, "").includes(a.replace(/[^a-z0-9]/g, ""))));
}

export function showFormatLabel(format: string, screenAttr: string): string {
  return [format, screenAttr].filter(Boolean).join(" ");
}

/** Which format chips must be fetched. If every wanted format is itself a chip, only those;
 *  otherwise (screen labels like PXL live inside 2D/3D) every non-excluded chip. */
export function chipsToFetch<T extends { title: string }>(chips: T[], wanted: string[] = [], excluded: string[] = []): T[] {
  const notExcluded = chips.filter((c) => !excluded.some((x) => formatMatches(c.title, x) && norm(c.title).trim() === norm(x).trim()));
  if (!wanted.length) return notExcluded;
  const direct = notExcluded.filter((c) => wanted.some((w) => formatMatches(c.title, w)));
  const allDirect = wanted.every((w) => direct.some((c) => formatMatches(c.title, w))) && !wanted.some((w) => ["PXL", "INFINITY_VISION", "SCREENX", "INSIGNIA", "DOLBY", "EPIQ"].includes(w.toUpperCase().replace(/[\s-]+/g, "_")));
  return allDirect ? direct : notExcluded;
}
