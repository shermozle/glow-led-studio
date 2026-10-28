export const SERVICE_UUID = "0000fff0-0000-1000-8000-00805f9b34fb";
export const COMMAND_UUID = "d44bc439-abfd-45a2-b575-925416129600";
export const NOTIFY_UUID = "d44bc439-abfd-45a2-b575-925416129601";
export const COLOR_DATA_UUID = "d44bc439-abfd-45a2-b575-92541612960a";
export const PIXEL_COUNT = 33;

const KEY = Uint8Array.from([
  0x34, 0x52, 0x2a, 0x5b, 0x7a, 0x6e, 0x49, 0x2c,
  0x08, 0x09, 0x0a, 0x9d, 0x8d, 0x2a, 0x23, 0xf8,
]);
const ZERO_IV = new Uint8Array(16);
let keyPromise;

function getKey() {
  keyPromise ??= crypto.subtle.importKey("raw", KEY, { name: "AES-CBC" }, false, ["encrypt", "decrypt"]);
  return keyPromise;
}

function command(values) {
  const packet = new Uint8Array(16);
  packet.set(values);
  return packet;
}

function channels(hex, brightness) {
  if (!/^#[0-9a-f]{6}$/i.test(hex)) throw new Error("Color must use #RRGGBB format");
  if (!Number.isFinite(brightness) || brightness < 0 || brightness > 100) throw new Error("Brightness must be between 0 and 100");
  return [1, 3, 5].map((offset) => Math.round(parseInt(hex.slice(offset, offset + 2), 16) * brightness / 100) >> 3);
}

export function powerCommand(on) {
  return command([0x05, 0x54, 0x55, 0x52, 0x4e, on ? 1 : 0]);
}

export function colorCommand(hex, brightness = 100) {
  const [red, green, blue] = channels(hex, brightness);
  return Uint8Array.from([
    0x0f, 0x53, 0x47, 0x4c, 0x53, 0x00, 0x00, 0x64,
    0x50, red, green, blue, red, green, blue, 0x32,
  ]);
}

export function microphoneCommand(enabled, mode = 0, sensitivity = 100) {
  if (!Number.isInteger(mode) || mode < 0 || mode > 9) throw new Error("Microphone mode must be between 0 and 9");
  if (!Number.isInteger(sensitivity) || sensitivity < 10 || sensitivity > 109) throw new Error("Microphone sensitivity must be between 10 and 109");
  return enabled ? command([0x06, 0x4d, 0x49, 0x43, 1, sensitivity, mode]) : command([0x04, 0x4d, 0x49, 0x43]);
}

export function pixelTransaction(colors, brightness = 100) {
  if (!Array.isArray(colors) || colors.length !== PIXEL_COUNT) throw new Error(`Exactly ${PIXEL_COUNT} pixel colors are required`);
  const runs = [];
  colors.forEach((color) => {
    const rgb = channels(color, brightness);
    const previous = runs.at(-1);
    if (previous && previous.rgb.every((channel, index) => channel === rgb[index])) previous.count += 1;
    else runs.push({ count: 1, rgb });
  });
  const chunks = [];
  for (let offset = 0; offset < runs.length; offset += 14) {
    const group = runs.slice(offset, offset + 14);
    const data = new Uint8Array(2 + group.length * 7);
    data[0] = data.length - 1;
    data[1] = chunks.length;
    group.forEach((run, index) => data.set([0, run.count, ...run.rgb, 2, 100], 2 + index * 7));
    chunks.push(data);
  }
  return {
    start: command([0x04, 0x44, 0x4f, 0x4f, 0x54, chunks.length]),
    chunks,
    complete: command([0x06, 0x44, 0x4f, 0x4f, 0x54, 0x43, 0x50]),
    commit: command([0x08, 0x44, 0x54, 0x41, 0x52, 0x54, 0x43, 0x59, 1]),
  };
}

export function pixelCommand(index, color, brightness = 100) {
  if (!Number.isInteger(index) || index < 0 || index >= PIXEL_COUNT) throw new Error(`Pixel index must be between 0 and ${PIXEL_COUNT - 1}`);
  const [red, green, blue] = channels(color, brightness);
  return command([0x0d, 0x44, 0x4f, 0x4f, 0x44, 1, 0, index, 2, 100, red, green, blue, 100]);
}

export function pixelUpdateCommands(previous, next, brightness = 100) {
  if (!Array.isArray(next) || next.length !== PIXEL_COUNT) throw new Error(`Exactly ${PIXEL_COUNT} pixel colors are required`);
  return next.flatMap((color, index) => {
    const packet = pixelCommand(index, color, brightness);
    if (previous?.[index]) {
      const before = channels(previous[index], brightness);
      const after = packet.slice(10, 13);
      if (before.every((channel, channelIndex) => channel === after[channelIndex])) return [];
    }
    return [packet];
  });
}

export function versionCommand(index) {
  if (index !== 0 && index !== 1) throw new Error("Version index must be 0 or 1");
  return command([0x03, 0x56, 0x45, index]);
}

async function encryptBlock(block, key) {
  const input = new Uint8Array(32);
  input.set(block);
  const result = await crypto.subtle.encrypt({ name: "AES-CBC", iv: ZERO_IV }, key, input);
  return new Uint8Array(result).slice(0, 16);
}

async function decryptBlock(block, key) {
  const paddingBlock = await encryptBlock(block.map((byte) => byte ^ 0x10), key);
  const input = new Uint8Array(32);
  input.set(block);
  input.set(paddingBlock, 16);
  const result = await crypto.subtle.decrypt({ name: "AES-CBC", iv: ZERO_IV }, key, input);
  return new Uint8Array(result);
}

async function transform(data, operation) {
  if (data.length === 0 || data.length % 16 !== 0) throw new Error("AES data must contain complete 16-byte blocks");
  const key = await getKey();
  const output = new Uint8Array(data.length);
  for (let offset = 0; offset < data.length; offset += 16) {
    const block = data.slice(offset, offset + 16);
    const transformed = operation === "encrypt" ? await encryptBlock(block, key) : await decryptBlock(block, key);
    output.set(transformed, offset);
  }
  return output;
}

export function encryptCommand(packet) {
  return transform(packet, "encrypt");
}

export function decryptNotification(data) {
  return transform(data, "decrypt");
}

export function toHex(data) {
  return Array.from(data, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function responseText(data) {
  return Array.from(data)
    .filter((byte) => byte >= 0x20 && byte <= 0x7e)
    .map((byte) => String.fromCharCode(byte))
    .join("");
}
