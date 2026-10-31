import { hsvToRgb, mixColors, normalizeHex, rgbToHex } from "./color.mjs";
import { normalizeAnimation } from "./animation.mjs";
import { PIXEL_COUNT } from "./protocol.mjs";

const EFFECTS = new Set(["solid", "alternating", "chase", "rainbow", "wave", "breathe", "sparkle", "scanner", "keyframes"]);
const DEFAULT_RAINBOW = Array.from({ length: 7 }, (_, index) => rgbToHex(hsvToRgb(index * 360 / 7, 1)));

function integer(value, fallback, minimum, maximum, label) {
  const result = Number(value ?? fallback);
  if (!Number.isInteger(result) || result < minimum || result > maximum) throw new Error(`${label} must be an integer from ${minimum} to ${maximum}`);
  return result;
}

function decimal(value, fallback, minimum, maximum, label) {
  const result = Number(value ?? fallback);
  if (!Number.isFinite(result) || result < minimum || result > maximum) throw new Error(`${label} must be from ${minimum} to ${maximum}`);
  return result;
}

function normalizeKeyframes(input) {
  if (!Array.isArray(input) || input.length < 2 || input.length > 8) throw new Error("Keyframes animations need between 2 and 8 keyframes");
  return input.map((frame) => {
    if (!frame || !Array.isArray(frame.segments) || !frame.segments.length || frame.segments.length > 16) throw new Error("Each keyframe needs between 1 and 16 segments");
    return frame.segments.map((segment) => ({
      start: integer(segment?.start, undefined, 1, PIXEL_COUNT, "Segment start"),
      end: integer(segment?.end, undefined, 1, PIXEL_COUNT, "Segment end"),
      color: normalizeHex(segment?.color),
    }));
  });
}

export function normalizeRecipe(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("The AI response must be an animation recipe");
  const name = String(input.name || "").trim().slice(0, 48);
  if (!name) throw new Error("The animation needs a draft name");
  if (!EFFECTS.has(input.effect)) throw new Error("The AI response uses an unsupported effect");
  if (input.direction !== undefined && !["forward", "reverse"].includes(input.direction)) throw new Error("Direction must be forward or reverse");
  if (input.transition !== undefined && !["fade", "step"].includes(input.transition)) throw new Error("Transition must be fade or step");
  if (input.loop !== undefined && typeof input.loop !== "boolean") throw new Error("Loop must be true or false");
  const sourcePalette = input.palette ?? (input.effect === "rainbow" ? DEFAULT_RAINBOW : undefined);
  if (!Array.isArray(sourcePalette) || !sourcePalette.length || sourcePalette.length > 7) throw new Error("Palette must contain between 1 and 7 colors");
  return {
    name,
    effect: input.effect,
    palette: sourcePalette.map(normalizeHex),
    background: normalizeHex(input.background || "#000000"),
    direction: input.direction || "forward",
    frameCount: integer(input.frameCount, input.effect === "alternating" || input.effect === "solid" ? 2 : 12, 2, 32, "Frame count"),
    duration: integer(input.duration, 500, 250, 10000, "Duration"),
    transition: input.transition || "fade",
    speed: decimal(input.speed, 1, 0.25, 2, "Speed"),
    loop: input.loop !== false,
    tailLength: integer(input.tailLength, 5, 1, PIXEL_COUNT, "Tail length"),
    density: decimal(input.density, 0.18, 0.05, 0.75, "Density"),
    keyframes: input.effect === "keyframes" ? normalizeKeyframes(input.keyframes) : undefined,
  };
}

function samplePalette(palette, position) {
  const wrapped = ((position % 1) + 1) % 1;
  const scaled = wrapped * palette.length;
  const index = Math.floor(scaled) % palette.length;
  return mixColors(palette[index], palette[(index + 1) % palette.length], scaled - Math.floor(scaled));
}

function uniform(color) {
  return Array(PIXEL_COUNT).fill(color);
}

function cometPixels(recipe, frameIndex, scanner = false) {
  const phase = frameIndex / recipe.frameCount;
  const head = scanner
    ? Math.round((1 - Math.cos(phase * Math.PI * 2)) / 2 * (PIXEL_COUNT - 1))
    : Math.floor(phase * PIXEL_COUNT) % PIXEL_COUNT;
  const scanDirection = Math.sin(phase * Math.PI * 2) >= 0 ? 1 : -1;
  const direction = scanner ? scanDirection : recipe.direction === "reverse" ? -1 : 1;
  const tailColor = recipe.palette[1] || recipe.palette[0];
  return Array.from({ length: PIXEL_COUNT }, (_, pixelIndex) => {
    let distance = (head - pixelIndex) * direction;
    if (!scanner) distance = (distance + PIXEL_COUNT) % PIXEL_COUNT;
    if (distance < 0 || distance >= recipe.tailLength) return recipe.background;
    if (distance === 0) return recipe.palette[0];
    return mixColors(recipe.background, tailColor, (recipe.tailLength - distance) / recipe.tailLength);
  });
}

function sparkleValue(pixelIndex, frameIndex, salt = 0) {
  let value = Math.imul(pixelIndex + 1 + salt, 0x45d9f3b) ^ Math.imul(frameIndex + 1, 0x27d4eb2d);
  value = Math.imul(value ^ (value >>> 16), 0x45d9f3b);
  value ^= value >>> 16;
  return (value >>> 0) / 4294967296;
}

function keyframePixels(recipe, segments) {
  const pixels = uniform(recipe.background);
  segments.forEach((segment) => {
    const start = Math.min(segment.start, segment.end) - 1;
    const end = Math.max(segment.start, segment.end);
    for (let index = start; index < end; index += 1) pixels[index] = segment.color;
  });
  return pixels;
}

function buildPixels(recipe, frameIndex) {
  const phase = frameIndex / recipe.frameCount;
  const direction = recipe.direction === "reverse" ? -1 : 1;
  switch (recipe.effect) {
    case "solid":
      return uniform(recipe.palette[0]);
    case "alternating": {
      const colors = recipe.palette.length > 1 ? recipe.palette : [recipe.palette[0], recipe.background];
      return Array.from({ length: PIXEL_COUNT }, (_, index) => colors[(index + frameIndex) % colors.length]);
    }
    case "chase":
      return cometPixels(recipe, frameIndex);
    case "scanner":
      return cometPixels(recipe, frameIndex, true);
    case "rainbow":
      return Array.from({ length: PIXEL_COUNT }, (_, index) => samplePalette(recipe.palette, index / PIXEL_COUNT + phase * direction));
    case "wave":
      return Array.from({ length: PIXEL_COUNT }, (_, index) => {
        const color = samplePalette(recipe.palette, index / PIXEL_COUNT);
        const amount = (Math.sin((index / PIXEL_COUNT - phase * direction) * Math.PI * 2) + 1) / 2;
        return mixColors(recipe.background, color, amount);
      });
    case "breathe": {
      const amount = (1 - Math.cos(phase * Math.PI * 2)) / 2;
      return uniform(mixColors(recipe.background, recipe.palette[0], amount));
    }
    case "sparkle":
      return Array.from({ length: PIXEL_COUNT }, (_, index) => {
        if (sparkleValue(index, frameIndex) >= recipe.density) return recipe.background;
        const colorIndex = Math.floor(sparkleValue(index, frameIndex, 31) * recipe.palette.length) % recipe.palette.length;
        return recipe.palette[colorIndex];
      });
    default:
      return uniform(recipe.background);
  }
}

export function compileAnimation(input) {
  const recipe = normalizeRecipe(input);
  const frames = recipe.effect === "keyframes"
    ? recipe.keyframes.map((segments) => ({ pixels: keyframePixels(recipe, segments), duration: recipe.duration }))
    : Array.from({ length: recipe.frameCount }, (_, frameIndex) => ({ pixels: buildPixels(recipe, frameIndex), duration: recipe.duration }));
  return normalizeAnimation({
    id: `draft-${Date.now()}`,
    name: recipe.name,
    builtIn: false,
    transition: recipe.transition,
    speed: recipe.speed,
    loop: recipe.loop,
    frames,
  });
}
