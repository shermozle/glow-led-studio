import { hsvToRgb, rgbToHsv, rgbToHex, hexToRgb, clamp } from "./color.mjs";

export class ColorWheel {
  constructor(canvas, initialColor, onChange) {
    this.canvas = canvas;
    this.context = canvas.getContext("2d");
    this.onChange = onChange;
    this.hue = 0;
    this.saturation = 1;
    this.dragging = false;
    this.setColor(initialColor);
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(canvas);
    canvas.addEventListener("pointerdown", (event) => {
      this.dragging = true;
      canvas.setPointerCapture(event.pointerId);
      this.selectPointer(event);
    });
    canvas.addEventListener("pointermove", (event) => {
      if (this.dragging) this.selectPointer(event);
    });
    canvas.addEventListener("pointerup", () => { this.dragging = false; });
    canvas.addEventListener("pointercancel", () => { this.dragging = false; });
    canvas.addEventListener("keydown", (event) => this.keydown(event));
  }

  get color() {
    return rgbToHex(hsvToRgb(this.hue, this.saturation));
  }

  setColor(hex) {
    [this.hue, this.saturation] = rgbToHsv(...hexToRgb(hex));
    this.draw();
  }

  resize() {
    const size = Math.max(160, Math.round(this.canvas.getBoundingClientRect().width));
    const ratio = window.devicePixelRatio || 1;
    this.canvas.width = size * ratio;
    this.canvas.height = size * ratio;
    this.size = size * ratio;
    this.wheel = document.createElement("canvas");
    this.wheel.width = this.size;
    this.wheel.height = this.size;
    const context = this.wheel.getContext("2d");
    const image = context.createImageData(this.size, this.size);
    const center = this.size / 2;
    for (let y = 0; y < this.size; y += 1) {
      for (let x = 0; x < this.size; x += 1) {
        const dx = x - center;
        const dy = y - center;
        const radius = Math.hypot(dx, dy) / center;
        if (radius > 1) continue;
        const hue = (Math.atan2(dy, dx) * 180 / Math.PI + 360) % 360;
        const [red, green, blue] = hsvToRgb(hue, radius);
        const index = (y * this.size + x) * 4;
        image.data[index] = red;
        image.data[index + 1] = green;
        image.data[index + 2] = blue;
        image.data[index + 3] = 255;
      }
    }
    context.putImageData(image, 0, 0);
    this.draw();
  }

  draw() {
    if (!this.context || !this.wheel) return;
    this.context.clearRect(0, 0, this.size, this.size);
    this.context.drawImage(this.wheel, 0, 0);
    const center = this.size / 2;
    const angle = this.hue * Math.PI / 180;
    const x = center + Math.cos(angle) * this.saturation * center;
    const y = center + Math.sin(angle) * this.saturation * center;
    this.context.beginPath();
    this.context.arc(x, y, this.size * 0.035, 0, Math.PI * 2);
    this.context.strokeStyle = "rgba(0,0,0,.75)";
    this.context.lineWidth = this.size * 0.018;
    this.context.stroke();
    this.context.beginPath();
    this.context.arc(x, y, this.size * 0.035, 0, Math.PI * 2);
    this.context.strokeStyle = "white";
    this.context.lineWidth = this.size * 0.009;
    this.context.stroke();
    this.canvas.setAttribute("aria-valuenow", String(Math.round(this.saturation * 100)));
    this.canvas.setAttribute("aria-valuetext", `${this.color}, hue ${Math.round(this.hue)} degrees, saturation ${Math.round(this.saturation * 100)} percent`);
  }

  selectPointer(event) {
    const bounds = this.canvas.getBoundingClientRect();
    const x = (event.clientX - bounds.left) * this.canvas.width / bounds.width - this.size / 2;
    const y = (event.clientY - bounds.top) * this.canvas.height / bounds.height - this.size / 2;
    this.hue = (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
    this.saturation = clamp(Math.hypot(x, y) / (this.size / 2));
    this.draw();
    this.onChange(this.color);
  }

  keydown(event) {
    const keys = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"];
    if (!keys.includes(event.key)) return;
    event.preventDefault();
    if (event.key === "ArrowLeft") this.hue = (this.hue + 355) % 360;
    if (event.key === "ArrowRight") this.hue = (this.hue + 5) % 360;
    if (event.key === "ArrowUp") this.saturation = clamp(this.saturation + 0.05);
    if (event.key === "ArrowDown") this.saturation = clamp(this.saturation - 0.05);
    if (event.key === "Home") this.saturation = 0;
    if (event.key === "End") this.saturation = 1;
    this.draw();
    this.onChange(this.color);
  }
}
