export function clamp(value, minimum = 0, maximum = 1) {
  return Math.min(maximum, Math.max(minimum, value));
}

export function normalizeHex(hex) {
  if (typeof hex !== "string" || !/^#[0-9a-f]{6}$/i.test(hex)) throw new Error("Color must use #RRGGBB format");
  return hex.toLowerCase();
}

export const COLOR_STORAGE_KEY = "glow-custom-colors-v1";

export function loadCustomColors(storage) {
  try {
    const saved = JSON.parse(storage.getItem(COLOR_STORAGE_KEY) || "[]");
    if (!Array.isArray(saved)) return [];
    return [...new Set(saved.map(normalizeHex))];
  } catch {
    return [];
  }
}

export function saveCustomColors(storage, colors) {
  storage.setItem(COLOR_STORAGE_KEY, JSON.stringify([...new Set(colors.map(normalizeHex))]));
}

export function hexToRgb(hex) {
  const normalized = normalizeHex(hex);
  return [1, 3, 5].map((offset) => parseInt(normalized.slice(offset, offset + 2), 16));
}

export function rgbToHex(rgb) {
  return `#${rgb.map((channel) => Math.round(clamp(channel, 0, 255)).toString(16).padStart(2, "0")).join("")}`;
}

export function hsvToRgb(hue, saturation, value = 1) {
  const h = ((hue % 360) + 360) % 360;
  const s = clamp(saturation);
  const v = clamp(value);
  const chroma = v * s;
  const x = chroma * (1 - Math.abs((h / 60) % 2 - 1));
  const m = v - chroma;
  const sector = Math.floor(h / 60);
  const bases = [[chroma, x, 0], [x, chroma, 0], [0, chroma, x], [0, x, chroma], [x, 0, chroma], [chroma, 0, x]];
  return bases[sector].map((channel) => Math.round((channel + m) * 255));
}

export function rgbToHsv(red, green, blue) {
  const r = red / 255;
  const g = green / 255;
  const b = blue / 255;
  const maximum = Math.max(r, g, b);
  const minimum = Math.min(r, g, b);
  const delta = maximum - minimum;
  let hue = 0;
  if (delta) {
    if (maximum === r) hue = 60 * (((g - b) / delta) % 6);
    else if (maximum === g) hue = 60 * ((b - r) / delta + 2);
    else hue = 60 * ((r - g) / delta + 4);
  }
  return [(hue + 360) % 360, maximum ? delta / maximum : 0, maximum];
}

export function mixColors(first, second, amount) {
  const a = hexToRgb(first);
  const b = hexToRgb(second);
  const t = clamp(amount);
  return rgbToHex(a.map((channel, index) => channel + (b[index] - channel) * t));
}
