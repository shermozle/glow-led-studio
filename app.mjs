import {
  SERVICE_UUID,
  COMMAND_UUID,
  NOTIFY_UUID,
  COLOR_DATA_UUID,
  PIXEL_COUNT,
  powerCommand,
  colorCommand,
  microphoneCommand,
  pixelTransaction,
  pixelUpdateCommands,
  versionCommand,
  encryptCommand,
  decryptNotification,
  responseText,
} from "./protocol.mjs";
import { normalizeHex, loadCustomColors, saveCustomColors } from "./color.mjs";
import { ColorWheel } from "./color-wheel.mjs";
import {
  BUILT_IN_ANIMATIONS,
  AnimationPlayer,
  cloneAnimation,
  normalizeAnimation,
  solidPixels,
  loadCustomAnimations,
  saveCustomAnimations,
} from "./animation.mjs";

const byId = (id) => document.getElementById(id);
const elements = {
  connect: byId("connect-button"),
  controls: byId("light-controls"),
  status: byId("connection-status"),
  statusDot: byId("status-dot"),
  support: byId("support-message"),
  deviceName: byId("device-name"),
  firmware: byId("firmware-version"),
  response: byId("last-response"),
  on: byId("on-button"),
  off: byId("off-button"),
  colorValue: byId("color-value"),
  colorHex: byId("color-hex"),
  brightness: byId("brightness"),
  brightnessValue: byId("brightness-value"),
  targetSolid: byId("target-solid"),
  targetFrame: byId("target-frame"),
  targetPixel: byId("target-pixel"),
  swatches: Array.from(document.querySelectorAll(".swatch")),
  customSwatches: byId("custom-swatches"),
  saveColor: byId("save-color"),
  colorSaveStatus: byId("color-save-status"),
  pixelGrid: byId("pixel-grid"),
  selectedPixelLabel: byId("selected-pixel-label"),
  fillPixels: byId("fill-pixels"),
  clearPixels: byId("clear-pixels"),
  applyPixels: byId("apply-pixels"),
  animationSelect: byId("animation-select"),
  newAnimation: byId("new-animation"),
  aiPrompt: byId("ai-prompt"),
  generateAnimation: byId("generate-animation"),
  useAiDraft: byId("use-ai-draft"),
  aiStatus: byId("ai-status"),
  preview: byId("animation-preview"),
  previewState: byId("preview-state"),
  previewName: byId("preview-animation-name"),
  previewFrame: byId("preview-frame"),
  previewPixels: byId("preview-pixels"),
  previewDots: byId("preview-dots"),
  play: byId("play-button"),
  next: byId("next-frame"),
  playbackNote: byId("playback-note"),
  frameList: byId("frame-list"),
  frameCount: byId("frame-count"),
  selectedFrameLabel: byId("selected-frame-label"),
  frameDuration: byId("frame-duration"),
  addFrame: byId("add-frame"),
  duplicateFrame: byId("duplicate-frame"),
  moveFrame: byId("move-frame"),
  deleteFrame: byId("delete-frame"),
  animationName: byId("animation-name"),
  animationTransition: byId("animation-transition"),
  animationSpeed: byId("animation-speed"),
  animationLoop: byId("animation-loop"),
  save: byId("save-animation"),
  deleteAnimation: byId("delete-animation"),
  saveStatus: byId("save-status"),
  soundButton: byId("sound-button"),
  soundStatus: byId("sound-status"),
  soundMode: byId("sound-mode"),
  sensitivity: byId("sound-sensitivity"),
  sensitivityValue: byId("sensitivity-value"),
};

let device;
let commandCharacteristic;
let notificationCharacteristic;
let colorDataCharacteristic;
let writeQueue = Promise.resolve();
let colorTimer;
let pixelTimer;
let saveTimer;
let pixelWritePending = false;
let lastSentPixels;
let versions = [];
let solidColor = "#ff5a5f";
let colorTarget = "solid";
let selectedFrame = 0;
let selectedPixel = 0;
let playbackFrame = 0;
let soundEnabled = false;
let customColors = [];
let animations = BUILT_IN_ANIMATIONS.map(cloneAnimation);
try {
  animations.push(...loadCustomAnimations(localStorage));
  customColors = loadCustomColors(localStorage);
} catch (error) {
  console.warn("Saved browser data is unavailable", error);
}
let currentAnimation = cloneAnimation(animations[0]);

function setStatus(message, state = "") {
  elements.status.textContent = message;
  elements.statusDot.className = `status-dot ${state}`.trim();
}

function reportError(error) {
  console.error(error);
  if (error.name === "NotFoundError") setStatus("No lights selected");
  else setStatus(error.message || "Bluetooth operation failed", "error");
}

function queue(operation) {
  const result = writeQueue.then(operation);
  writeQueue = result.catch(() => {});
  return result;
}

function requireConnection() {
  if (!commandCharacteristic || !device?.gatt?.connected) throw new Error("Lights are not connected");
}

async function writeValue(characteristic, value) {
  if (typeof characteristic.writeValueWithoutResponse === "function") await characteristic.writeValueWithoutResponse(value);
  else await characteristic.writeValue(value);
}

function enqueue(packet) {
  return queue(async () => {
    requireConnection();
    await writeValue(commandCharacteristic, await encryptCommand(packet));
  });
}

function enqueuePixels(pixels) {
  const transaction = pixelTransaction(pixels, Number(elements.brightness.value));
  return queue(async () => {
    requireConnection();
    if (!colorDataCharacteristic) throw new Error("Pixel data channel is unavailable");
    await writeValue(commandCharacteristic, await encryptCommand(transaction.start));
    for (const chunk of transaction.chunks) await writeValue(colorDataCharacteristic, chunk);
    await writeValue(commandCharacteristic, await encryptCommand(transaction.complete));
    await writeValue(commandCharacteristic, await encryptCommand(transaction.commit));
    lastSentPixels = [...pixels];
  });
}

function enqueuePixelUpdates(pixels) {
  if (!lastSentPixels) return enqueuePixels(pixels);
  const commands = pixelUpdateCommands(lastSentPixels, pixels, Number(elements.brightness.value));
  if (!commands.length) {
    lastSentPixels = [...pixels];
    return Promise.resolve();
  }
  return queue(async () => {
    requireConnection();
    for (const packet of commands) await writeValue(commandCharacteristic, await encryptCommand(packet));
    lastSentPixels = [...pixels];
  });
}

const player = new AnimationPlayer({
  onPixels(pixels) {
    renderPreviewPixels(pixels);
    if (player.playing && device?.gatt?.connected && !pixelWritePending) {
      pixelWritePending = true;
      enqueuePixelUpdates(pixels).catch(reportError).finally(() => { pixelWritePending = false; });
    }
  },
  onFrame(index) {
    playbackFrame = index;
    updatePlaybackFrame();
  },
  onState(playing) {
    elements.play.textContent = playing ? "Ⅱ Pause" : "▶ Play";
    elements.previewState.textContent = playing ? "Playing live" : "Ready";
  },
});

const wheel = new ColorWheel(byId("color-wheel"), solidColor, (color) => applyColor(color));

function currentPixels() {
  return currentAnimation.frames[selectedFrame].pixels;
}

function targetColor() {
  return colorTarget === "solid" ? solidColor : currentPixels()[selectedPixel];
}

function updateColorUI() {
  const color = targetColor();
  elements.colorValue.value = color.toUpperCase();
  if (document.activeElement !== elements.colorHex) elements.colorHex.value = color;
  elements.swatches.forEach((swatch) => {
    const selected = swatch.dataset.color === color;
    swatch.classList.toggle("selected", selected);
    swatch.setAttribute("aria-pressed", String(selected));
  });
}

function selectSwatch(color) {
  wheel.setColor(color);
  applyColor(color);
}

function renderCustomSwatches() {
  elements.customSwatches.replaceChildren();
  customColors.forEach((color) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "swatch";
    button.style.setProperty("--swatch", color);
    button.dataset.color = color;
    button.setAttribute("aria-label", `Custom color ${color}`);
    button.addEventListener("click", () => selectSwatch(color));
    elements.customSwatches.append(button);
  });
  elements.swatches = Array.from(document.querySelectorAll(".swatch"));
  updateColorUI();
}

function saveCurrentColor() {
  const color = targetColor();
  if (elements.swatches.some((swatch) => swatch.dataset.color === color)) {
    elements.colorSaveStatus.textContent = "Already in your swatches";
    return;
  }
  const updated = [...customColors, color];
  try {
    saveCustomColors(localStorage, updated);
    customColors = updated;
    renderCustomSwatches();
    elements.colorSaveStatus.textContent = `Saved ${color.toUpperCase()} on this device`;
  } catch (error) {
    elements.colorSaveStatus.textContent = `Could not save: ${error.message}`;
  }
}

function setTarget(target) {
  colorTarget = target;
  const targets = { solid: elements.targetSolid, frame: elements.targetFrame, pixel: elements.targetPixel };
  Object.entries(targets).forEach(([name, element]) => {
    element.classList.toggle("active", name === target);
    element.setAttribute("aria-pressed", String(name === target));
  });
  wheel.setColor(targetColor());
  updateColorUI();
}

function updateSoundUI() {
  elements.soundButton.textContent = soundEnabled ? "Disable sound mode" : "Enable sound mode";
  elements.soundStatus.textContent = soundEnabled ? `Controller microphone active · effect ${Number(elements.soundMode.value) + 1}` : "Hardware sound mode off";
}

function disableSound() {
  if (!soundEnabled) return;
  soundEnabled = false;
  updateSoundUI();
  if (device?.gatt?.connected) enqueue(microphoneCommand(false)).catch(reportError);
}

function stopPlayback() {
  player.pause();
  disableSound();
}

function sendSolidColor() {
  clearTimeout(colorTimer);
  lastSentPixels = undefined;
  if (!device?.gatt?.connected) return;
  colorTimer = setTimeout(() => enqueue(colorCommand(solidColor, Number(elements.brightness.value))).catch(reportError), 100);
}

function sendCurrentPixels() {
  clearTimeout(pixelTimer);
  if (!device?.gatt?.connected) return;
  pixelTimer = setTimeout(() => enqueuePixelUpdates(currentPixels()).catch(reportError), 140);
}

function syncPlayerToSelection() {
  player.load(currentAnimation);
  player.frameIndex = selectedFrame;
  player.emitFrame();
}

function applyColor(hex) {
  const color = normalizeHex(hex);
  if (colorTarget === "solid") {
    stopPlayback();
    solidColor = color;
    sendSolidColor();
  } else {
    stopPlayback();
    if (colorTarget === "frame") currentAnimation.frames[selectedFrame].pixels = solidPixels(color);
    else currentPixels()[selectedPixel] = color;
    syncPlayerToSelection();
    renderFrameList();
    renderPixelGrid();
    sendCurrentPixels();
    scheduleSave();
  }
  updateColorUI();
}

function setConnected(connected) {
  elements.controls.disabled = !connected;
  elements.applyPixels.disabled = !connected;
  elements.soundButton.disabled = !connected;
  elements.connect.textContent = connected ? "Disconnect" : "Connect lights";
  elements.deviceName.textContent = connected ? device?.name || "iDeal LED" : "—";
  elements.playbackNote.textContent = connected ? "Playing live on all 33 LEDs" : "Preview works without a connection";
  if (!connected) {
    elements.firmware.textContent = "—";
    elements.response.textContent = "—";
    versions = [];
  }
}

async function notificationReceived(event) {
  try {
    const value = event.target.value;
    const encrypted = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    const clear = await decryptNotification(encrypted);
    const text = responseText(clear);
    if (!text) return;
    elements.response.textContent = text;
    if (clear[0] === 0x0d && text.startsWith("V")) {
      if (!versions.includes(text)) versions.push(text);
      elements.firmware.textContent = versions.join(" / ");
    }
  } catch (error) {
    console.error("Could not decode notification", error);
  }
}

function disconnected() {
  clearTimeout(colorTimer);
  clearTimeout(pixelTimer);
  player.pause();
  soundEnabled = false;
  lastSentPixels = undefined;
  updateSoundUI();
  commandCharacteristic = undefined;
  notificationCharacteristic = undefined;
  colorDataCharacteristic = undefined;
  setConnected(false);
  setStatus("Disconnected");
}

async function connect() {
  if (!navigator.bluetooth) return;
  if (device?.gatt?.connected) {
    device.gatt.disconnect();
    return;
  }
  try {
    elements.connect.disabled = true;
    setStatus("Choose your lights…", "busy");
    device = await navigator.bluetooth.requestDevice({
      filters: [{ namePrefix: "ISP-" }, { namePrefix: "IDL-" }],
      optionalServices: [SERVICE_UUID],
    });
    device.addEventListener("gattserverdisconnected", disconnected);
    setStatus(`Connecting to ${device.name || "iDeal LED"}…`, "busy");
    const server = await device.gatt.connect();
    const service = await server.getPrimaryService(SERVICE_UUID);
    commandCharacteristic = await service.getCharacteristic(COMMAND_UUID);
    notificationCharacteristic = await service.getCharacteristic(NOTIFY_UUID);
    colorDataCharacteristic = await service.getCharacteristic(COLOR_DATA_UUID);
    await notificationCharacteristic.startNotifications();
    notificationCharacteristic.addEventListener("characteristicvaluechanged", notificationReceived);
    setConnected(true);
    setStatus(`Connected to ${device.name || "iDeal LED"}`, "connected");
    await enqueue(versionCommand(0));
    await enqueue(versionCommand(1));
  } catch (error) {
    if (device?.gatt?.connected) device.gatt.disconnect();
    setConnected(false);
    reportError(error);
  } finally {
    elements.connect.disabled = false;
  }
}

function updatePlaybackFrame() {
  Array.from(elements.previewDots.children).forEach((dot, index) => dot.classList.toggle("active", index === playbackFrame));
  const frame = currentAnimation.frames[playbackFrame] || currentAnimation.frames[0];
  elements.previewFrame.textContent = `Frame ${playbackFrame + 1} of ${currentAnimation.frames.length} · ${frame.duration} ms`;
}

function renderPreviewPixels(pixels) {
  Array.from(elements.previewPixels.children).forEach((pixel, index) => {
    pixel.style.backgroundColor = pixels[index];
    pixel.style.setProperty("--pixel-color", pixels[index]);
  });
}

function renderPixelGrid() {
  elements.pixelGrid.replaceChildren();
  currentPixels().forEach((color, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `pixel-button${index === selectedPixel ? " selected" : ""}`;
    button.style.setProperty("--pixel-color", color);
    button.dataset.number = String(index + 1);
    button.setAttribute("aria-label", `LED ${index + 1}, ${color}`);
    button.setAttribute("aria-pressed", String(index === selectedPixel));
    button.addEventListener("click", () => {
      selectedPixel = index;
      setTarget("pixel");
      renderPixelGrid();
      elements.selectedPixelLabel.textContent = `LED ${index + 1} of ${PIXEL_COUNT}`;
    });
    elements.pixelGrid.append(button);
  });
}

function renderPreviewDots() {
  elements.previewDots.replaceChildren();
  currentAnimation.frames.forEach(() => {
    const dot = document.createElement("span");
    dot.className = "preview-dot";
    elements.previewDots.append(dot);
  });
  updatePlaybackFrame();
}

function renderFrameList() {
  elements.frameList.replaceChildren();
  currentAnimation.frames.forEach((frame, index) => {
    const item = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.className = `frame-button${index === selectedFrame ? " selected" : ""}`;
    button.setAttribute("aria-label", `Edit frame ${index + 1}, ${frame.duration} milliseconds`);
    const number = document.createElement("span");
    number.className = "frame-number";
    number.textContent = String(index + 1).padStart(2, "0");
    const color = document.createElement("span");
    color.className = "frame-color";
    color.style.background = `linear-gradient(90deg, ${frame.pixels.join(",")})`;
    const name = document.createElement("span");
    name.className = "frame-name";
    name.textContent = `${PIXEL_COUNT} LEDs`;
    const duration = document.createElement("span");
    duration.className = "frame-duration-label";
    duration.textContent = `${frame.duration}ms`;
    button.append(number, color, name, duration);
    button.addEventListener("click", () => {
      selectedFrame = index;
      player.pause();
      syncPlayerToSelection();
      setTarget("pixel");
      renderEditor();
    });
    item.append(button);
    elements.frameList.append(item);
  });
}

function renderAnimationOptions() {
  elements.animationSelect.replaceChildren();
  for (const builtIn of [true, false]) {
    const group = document.createElement("optgroup");
    group.label = builtIn ? "Presets" : "My animations";
    const matches = animations.filter((animation) => animation.builtIn === builtIn);
    matches.forEach((animation) => {
      const option = document.createElement("option");
      option.value = animation.id;
      option.textContent = animation.name;
      group.append(option);
    });
    if (matches.length) elements.animationSelect.append(group);
  }
  if (!animations.some((animation) => animation.id === currentAnimation.id)) {
    const option = document.createElement("option");
    option.value = currentAnimation.id;
    option.textContent = currentAnimation.name;
    elements.animationSelect.append(option);
  }
  elements.animationSelect.value = currentAnimation.id;
}

function renderPreviewMeta() {
  elements.previewName.textContent = currentAnimation.name;
  elements.previewFrame.textContent = `${currentAnimation.frames.length} frames · ${currentAnimation.transition === "fade" ? "Fade" : "Step"}`;
}

function renderEditor() {
  elements.frameCount.textContent = String(currentAnimation.frames.length);
  elements.selectedFrameLabel.textContent = String(selectedFrame + 1);
  elements.selectedPixelLabel.textContent = `LED ${selectedPixel + 1} of ${PIXEL_COUNT}`;
  elements.frameDuration.value = String(currentAnimation.frames[selectedFrame].duration);
  elements.animationName.value = currentAnimation.name;
  elements.animationTransition.value = currentAnimation.transition;
  if (!Array.from(elements.animationSpeed.options).some((option) => Number(option.value) === currentAnimation.speed)) {
    elements.animationSpeed.add(new Option(`${currentAnimation.speed}×`, String(currentAnimation.speed)));
  }
  elements.animationSpeed.value = String(currentAnimation.speed);
  elements.animationLoop.checked = currentAnimation.loop;
  elements.deleteAnimation.disabled = currentAnimation.builtIn;
  elements.deleteFrame.disabled = currentAnimation.frames.length <= 2;
  elements.addFrame.disabled = currentAnimation.frames.length >= 32;
  elements.duplicateFrame.disabled = currentAnimation.frames.length >= 32;
  elements.moveFrame.disabled = selectedFrame === currentAnimation.frames.length - 1;
  renderFrameList();
  renderPixelGrid();
  renderPreviewDots();
  renderPreviewMeta();
  updateColorUI();
}

function persistCurrentAnimation() {
  clearTimeout(saveTimer);
  saveTimer = undefined;
  try {
    const id = currentAnimation.builtIn ? `custom-${crypto.randomUUID?.() || Date.now()}` : currentAnimation.id;
    const saved = normalizeAnimation({ ...currentAnimation, id, builtIn: false });
    const updated = [...animations];
    const index = updated.findIndex((animation) => animation.id === id);
    if (index === -1) updated.push(saved);
    else updated[index] = saved;
    saveCustomAnimations(localStorage, updated);
    animations = updated;
    currentAnimation = cloneAnimation(saved);
    renderAnimationOptions();
    elements.deleteAnimation.disabled = false;
    elements.saveStatus.textContent = "Saved on this device";
    return true;
  } catch (error) {
    elements.saveStatus.textContent = `Could not save: ${error.message}`;
    return false;
  }
}

function scheduleSave() {
  clearTimeout(saveTimer);
  elements.saveStatus.textContent = "Saving…";
  saveTimer = setTimeout(persistCurrentAnimation, 200);
}

function flushPendingSave() {
  if (saveTimer !== undefined) persistCurrentAnimation();
}

function animationEdited() {
  player.pause();
  currentAnimation = normalizeAnimation(currentAnimation);
  syncPlayerToSelection();
  wheel.setColor(targetColor());
  renderEditor();
  scheduleSave();
}

function loadAnimation(animation) {
  flushPendingSave();
  currentAnimation = cloneAnimation(animation);
  selectedFrame = 0;
  selectedPixel = 0;
  playbackFrame = 0;
  player.load(currentAnimation);
  renderAnimationOptions();
  renderEditor();
  setTarget("solid");
  elements.useAiDraft.hidden = true;
  elements.saveStatus.textContent = "";
}

function manualPower(on) {
  stopPlayback();
  lastSentPixels = undefined;
  enqueue(powerCommand(on)).catch(reportError);
}

async function generateDraft() {
  if (elements.generateAnimation.disabled) return;
  const prompt = elements.aiPrompt.value.trim();
  if (prompt.length < 3) {
    elements.aiStatus.textContent = "Describe the animation first.";
    elements.aiPrompt.focus();
    return;
  }
  stopPlayback();
  elements.generateAnimation.disabled = true;
  elements.generateAnimation.textContent = "Generating…";
  elements.useAiDraft.hidden = true;
  elements.aiStatus.textContent = "DeepSeek is designing your animation…";
  try {
    const response = await fetch("/api/generate-animation", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt }),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || "The AI service is unavailable.");
    if (!result.animation) throw new Error("The AI service returned an invalid response.");
    const animation = normalizeAnimation({ ...result.animation, builtIn: false });
    loadAnimation(animation);
    elements.useAiDraft.hidden = false;
    elements.aiStatus.textContent = `Created “${animation.name}”. Preview it, edit it, or add it to your animations.`;
  } catch (error) {
    elements.aiStatus.textContent = error.message || "Could not generate an animation. Please try again.";
  } finally {
    elements.generateAnimation.disabled = false;
    elements.generateAnimation.textContent = "✦ Generate draft";
  }
}

function toggleSound() {
  if (soundEnabled) {
    disableSound();
    return;
  }
  player.pause();
  lastSentPixels = undefined;
  soundEnabled = true;
  updateSoundUI();
  enqueue(microphoneCommand(true, Number(elements.soundMode.value), Number(elements.sensitivity.value))).catch((error) => {
    soundEnabled = false;
    updateSoundUI();
    reportError(error);
  });
}

elements.generateAnimation.addEventListener("click", generateDraft);
elements.useAiDraft.addEventListener("click", () => {
  if (persistCurrentAnimation()) {
    elements.useAiDraft.hidden = true;
    elements.aiStatus.textContent = "Added to My animations on this device.";
  } else {
    elements.aiStatus.textContent = elements.saveStatus.textContent;
  }
});
document.querySelectorAll(".ai-example").forEach((button) => {
  button.addEventListener("click", () => {
    elements.aiPrompt.value = button.dataset.prompt;
    elements.aiPrompt.focus();
  });
});
elements.aiPrompt.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) generateDraft();
});
elements.connect.addEventListener("click", connect);
elements.on.addEventListener("click", () => manualPower(true));
elements.off.addEventListener("click", () => manualPower(false));
elements.targetSolid.addEventListener("click", () => setTarget("solid"));
elements.targetFrame.addEventListener("click", () => setTarget("frame"));
elements.targetPixel.addEventListener("click", () => setTarget("pixel"));
elements.colorHex.addEventListener("change", () => {
  try {
    wheel.setColor(normalizeHex(elements.colorHex.value));
    applyColor(elements.colorHex.value);
  } catch {
    elements.colorHex.value = targetColor();
  }
});
elements.colorHex.addEventListener("keydown", (event) => {
  if (event.key === "Enter") elements.colorHex.blur();
});
elements.swatches.forEach((swatch) => {
  swatch.addEventListener("click", () => selectSwatch(swatch.dataset.color));
});
elements.saveColor.addEventListener("click", saveCurrentColor);
elements.brightness.addEventListener("input", () => {
  elements.brightnessValue.value = `${elements.brightness.value}%`;
  if (player.playing) return;
  if (colorTarget === "solid") sendSolidColor();
  else sendCurrentPixels();
});
elements.fillPixels.addEventListener("click", () => {
  const color = targetColor();
  wheel.setColor(color);
  setTarget("frame");
  applyColor(color);
});
elements.clearPixels.addEventListener("click", () => {
  wheel.setColor("#000000");
  setTarget("frame");
  applyColor("#000000");
});
elements.applyPixels.addEventListener("click", () => {
  stopPlayback();
  enqueuePixelUpdates(currentPixels()).catch(reportError);
});
elements.animationSelect.addEventListener("change", () => {
  stopPlayback();
  const animation = animations.find((item) => item.id === elements.animationSelect.value);
  if (animation) loadAnimation(animation);
});
elements.newAnimation.addEventListener("click", () => {
  stopPlayback();
  const animation = normalizeAnimation({
    id: `draft-${Date.now()}`,
    name: "My animation",
    builtIn: false,
    transition: "fade",
    speed: 1,
    loop: true,
    frames: [
      { pixels: solidPixels(solidColor), duration: 700 },
      { pixels: solidPixels("#ff2e88"), duration: 700 },
      { pixels: solidPixels("#22d3ee"), duration: 700 },
    ],
  });
  loadAnimation(animation);
  setTarget("pixel");
  persistCurrentAnimation();
});
elements.play.addEventListener("click", () => {
  disableSound();
  if (player.playing) player.pause();
  else {
    currentAnimation = normalizeAnimation(currentAnimation);
    player.load(currentAnimation);
    player.play();
  }
});
elements.next.addEventListener("click", () => player.next());
elements.frameDuration.addEventListener("change", () => {
  currentAnimation.frames[selectedFrame].duration = Number(elements.frameDuration.value);
  animationEdited();
});
elements.addFrame.addEventListener("click", () => {
  currentAnimation.frames.splice(selectedFrame + 1, 0, { pixels: [...currentPixels()], duration: Number(elements.frameDuration.value) });
  selectedFrame += 1;
  setTarget("pixel");
  animationEdited();
});
elements.duplicateFrame.addEventListener("click", () => {
  currentAnimation.frames.splice(selectedFrame + 1, 0, { pixels: [...currentPixels()], duration: currentAnimation.frames[selectedFrame].duration });
  selectedFrame += 1;
  setTarget("pixel");
  animationEdited();
});
elements.moveFrame.addEventListener("click", () => {
  if (selectedFrame >= currentAnimation.frames.length - 1) return;
  const [frame] = currentAnimation.frames.splice(selectedFrame, 1);
  currentAnimation.frames.splice(selectedFrame + 1, 0, frame);
  selectedFrame += 1;
  animationEdited();
});
elements.deleteFrame.addEventListener("click", () => {
  if (currentAnimation.frames.length <= 2) return;
  currentAnimation.frames.splice(selectedFrame, 1);
  selectedFrame = Math.min(selectedFrame, currentAnimation.frames.length - 1);
  animationEdited();
});
elements.animationName.addEventListener("input", () => {
  currentAnimation.name = elements.animationName.value;
  renderPreviewMeta();
  renderAnimationOptions();
  scheduleSave();
});
elements.animationTransition.addEventListener("change", () => {
  currentAnimation.transition = elements.animationTransition.value;
  animationEdited();
});
elements.animationSpeed.addEventListener("change", () => {
  currentAnimation.speed = Number(elements.animationSpeed.value);
  animationEdited();
});
elements.animationLoop.addEventListener("change", () => {
  currentAnimation.loop = elements.animationLoop.checked;
  animationEdited();
});
elements.save.addEventListener("click", persistCurrentAnimation);
elements.deleteAnimation.addEventListener("click", () => {
  if (currentAnimation.builtIn) return;
  stopPlayback();
  flushPendingSave();
  const updated = animations.filter((animation) => animation.id !== currentAnimation.id);
  try {
    saveCustomAnimations(localStorage, updated);
    animations = updated;
    loadAnimation(animations[0]);
  } catch (error) {
    elements.saveStatus.textContent = `Could not save: ${error.message}`;
  }
});
elements.soundButton.addEventListener("click", toggleSound);
elements.soundMode.addEventListener("change", () => {
  updateSoundUI();
  if (soundEnabled) enqueue(microphoneCommand(true, Number(elements.soundMode.value), Number(elements.sensitivity.value))).catch(reportError);
});
elements.sensitivity.addEventListener("input", () => {
  elements.sensitivityValue.value = elements.sensitivity.value;
  if (soundEnabled) enqueue(microphoneCommand(true, Number(elements.soundMode.value), Number(elements.sensitivity.value))).catch(reportError);
});
window.addEventListener("pagehide", () => {
  flushPendingSave();
  player.pause();
  if (device?.gatt?.connected) device.gatt.disconnect();
});

for (let index = 0; index < PIXEL_COUNT; index += 1) {
  const pixel = document.createElement("span");
  pixel.className = "preview-pixel";
  elements.previewPixels.append(pixel);
}
player.load(currentAnimation);
renderAnimationOptions();
renderCustomSwatches();
renderEditor();
setTarget("solid");
setConnected(false);
updateSoundUI();
if (!navigator.bluetooth) {
  elements.support.hidden = false;
  elements.connect.disabled = true;
  setStatus("Web Bluetooth unavailable", "error");
}
