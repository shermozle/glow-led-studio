import { mixColors, normalizeHex, hsvToRgb, rgbToHex } from "./color.mjs";
import { PIXEL_COUNT } from "./protocol.mjs";

export const STORAGE_KEY = "glow-pixel-animations-v2";

function uniformPixels(color) {
  return Array(PIXEL_COUNT).fill(color);
}

function paletteColor(palette, position) {
  const wrapped = ((position % 1) + 1) % 1;
  const scaled = wrapped * palette.length;
  const index = Math.floor(scaled) % palette.length;
  return mixColors(palette[index], palette[(index + 1) % palette.length], scaled - Math.floor(scaled));
}

function spatialAnimation(id, name, palette, duration, transition = "fade", speed = 1) {
  const frameCount = Math.max(8, palette.length * 2);
  return {
    id,
    name,
    builtIn: true,
    transition,
    speed,
    loop: true,
    frames: Array.from({ length: frameCount }, (_, frameIndex) => ({
      duration,
      pixels: Array.from({ length: PIXEL_COUNT }, (_, pixelIndex) => paletteColor(palette, pixelIndex / PIXEL_COUNT + frameIndex / frameCount)),
    })),
  };
}

const chaseFrames = Array.from({ length: 11 }, (_, frameIndex) => ({
  duration: 250,
  pixels: Array.from({ length: PIXEL_COUNT }, (_, pixelIndex) => {
    const active = (pixelIndex + 11 - frameIndex * 3 % 11) % 11;
    return active === 0 ? "#ffffff" : active === 1 ? "#ff2e88" : "#12051f";
  }),
}));

export const BUILT_IN_ANIMATIONS = [
  spatialAnimation("rainbow-flow", "Rainbow flow", ["#ff4545", "#ffb347", "#ffe66d", "#4ade80", "#22d3ee", "#818cf8", "#e879f9"], 700),
  spatialAnimation("pink-candy", "Pink candy", ["#ff2e88", "#ff8bd2", "#c084fc", "#ffffff", "#8b5cf6"], 650),
  spatialAnimation("sunset", "Sunset drift", ["#ff5a5f", "#ff8f3f", "#ffb347", "#e879f9", "#6d5ce7"], 900, "fade", 0.8),
  spatialAnimation("ocean", "Deep ocean", ["#03045e", "#0077b6", "#00b4d8", "#90e0ef", "#48bfe3"], 900, "fade", 0.75),
  {
    id: "disco-chase",
    name: "Disco chase",
    builtIn: true,
    transition: "step",
    speed: 1.25,
    loop: true,
    frames: chaseFrames,
  },
];

export function normalizeAnimation(input) {
  if (!input || !Array.isArray(input.frames) || input.frames.length < 2 || input.frames.length > 32) throw new Error("Animations need between 2 and 32 frames");
  const frames = input.frames.map((frame) => {
    const duration = Number(frame.duration);
    if (!Number.isFinite(duration) || duration < 250 || duration > 10000) throw new Error("Frame durations must be between 250 and 10000 ms");
    const source = frame.pixels || uniformPixels(frame.color);
    if (!Array.isArray(source) || source.length !== PIXEL_COUNT) throw new Error(`Each frame needs exactly ${PIXEL_COUNT} pixel colors`);
    return { pixels: source.map(normalizeHex), duration: Math.round(duration) };
  });
  const speed = Number(input.speed ?? 1);
  if (!Number.isFinite(speed) || speed < 0.25 || speed > 2) throw new Error("Animation speed must be between 0.25 and 2");
  return {
    id: String(input.id || `animation-${Date.now()}`),
    name: String(input.name || "Untitled animation").trim().slice(0, 48) || "Untitled animation",
    builtIn: Boolean(input.builtIn),
    transition: input.transition === "step" ? "step" : "fade",
    speed,
    loop: input.loop !== false,
    frames,
  };
}

export function cloneAnimation(animation) {
  return normalizeAnimation(JSON.parse(JSON.stringify(animation)));
}

export function loadCustomAnimations(storage) {
  try {
    const saved = JSON.parse(storage.getItem(STORAGE_KEY) || "[]");
    if (!Array.isArray(saved)) return [];
    return saved.map((animation) => normalizeAnimation({ ...animation, builtIn: false }));
  } catch {
    return [];
  }
}

export function saveCustomAnimations(storage, animations) {
  const custom = animations.filter((animation) => !animation.builtIn).map((animation) => normalizeAnimation(animation));
  storage.setItem(STORAGE_KEY, JSON.stringify(custom));
}

export function mixPixels(first, second, amount) {
  return first.map((color, index) => mixColors(color, second[index], amount));
}

export function solidPixels(color) {
  return uniformPixels(normalizeHex(color));
}

export function huePixels(offset = 0) {
  return Array.from({ length: PIXEL_COUNT }, (_, index) => rgbToHex(hsvToRgb(offset + index * 360 / PIXEL_COUNT, 1)));
}

export class AnimationPlayer {
  constructor({ onPixels, onFrame, onState }) {
    this.onPixels = onPixels;
    this.onFrame = onFrame;
    this.onState = onState;
    this.playing = false;
    this.frameIndex = 0;
  }

  load(animation) {
    this.pause();
    this.animation = normalizeAnimation(animation);
    this.frameIndex = 0;
    this.emitFrame();
  }

  play() {
    if (!this.animation) throw new Error("Choose an animation first");
    if (this.playing) return;
    this.playing = true;
    this.frameStartedAt = performance.now();
    this.emitFrame();
    this.timer = setInterval(() => this.tick(), 250);
    this.onState?.(true);
  }

  pause() {
    clearInterval(this.timer);
    if (!this.playing) return;
    this.playing = false;
    this.onState?.(false);
  }

  stop() {
    this.pause();
    this.frameIndex = 0;
    this.emitFrame();
  }

  next() {
    if (!this.animation) return;
    if (this.frameIndex === this.animation.frames.length - 1 && !this.animation.loop) {
      this.pause();
      return;
    }
    this.frameIndex = (this.frameIndex + 1) % this.animation.frames.length;
    this.frameStartedAt = performance.now();
    this.emitFrame();
  }

  tick() {
    if (!this.playing) return;
    const frame = this.animation.frames[this.frameIndex];
    const elapsed = (performance.now() - this.frameStartedAt) * this.animation.speed;
    const progress = elapsed / frame.duration;
    if (progress >= 1) {
      this.next();
      return;
    }
    const isLast = this.frameIndex === this.animation.frames.length - 1;
    if (this.animation.transition === "fade" && (!isLast || this.animation.loop)) {
      const nextFrame = this.animation.frames[(this.frameIndex + 1) % this.animation.frames.length];
      this.onPixels(mixPixels(frame.pixels, nextFrame.pixels, progress));
    }
  }

  emitFrame() {
    if (!this.animation) return;
    this.onPixels(this.animation.frames[this.frameIndex].pixels);
    this.onFrame?.(this.frameIndex);
  }
}
