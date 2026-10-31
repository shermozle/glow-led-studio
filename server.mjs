import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { compileAnimation } from "./recipe.mjs";

const root = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT) || 3000;
const apiKey = process.env.DEEPSEEK_API_KEY;
const model = process.env.DEEPSEEK_MODEL || "deepseek-chat";
const baseUrl = (process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com").replace(/\/$/, "");
const rateLimit = Number(process.env.RATE_LIMIT_MAX) || 10;
const rateWindow = Number(process.env.RATE_LIMIT_WINDOW_MS) || 60 * 60 * 1000;
const requests = new Map();
const publicFiles = new Map([
  ["/", "index.html"],
  ["/index.html", "index.html"],
  ["/styles.css", "styles.css"],
  ["/app.mjs", "app.mjs"],
  ["/protocol.mjs", "protocol.mjs"],
  ["/color.mjs", "color.mjs"],
  ["/color-wheel.mjs", "color-wheel.mjs"],
  ["/animation.mjs", "animation.mjs"],
]);
const mimeTypes = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".mjs": "text/javascript; charset=utf-8" };
const systemPrompt = `You design animations for a 33-pixel addressable LED strip. Return only one JSON object matching this recipe schema:
{
  "name": "short creative draft name, maximum 48 characters",
  "effect": "solid | alternating | chase | rainbow | wave | breathe | sparkle | scanner | keyframes",
  "palette": ["#RRGGBB"],
  "background": "#RRGGBB",
  "direction": "forward | reverse",
  "frameCount": 12,
  "duration": 500,
  "transition": "fade | step",
  "speed": 1,
  "loop": true,
  "tailLength": 5,
  "density": 0.18,
  "keyframes": [{"segments": [{"start": 1, "end": 11, "color": "#RRGGBB"}]}]
}
Rules:
- Use 1-7 palette colors. palette[0] is the main or head color and palette[1] is the tail color for chase and scanner.
- background is normally #000000 so unlit LEDs are off.
- frameCount is 2-32, duration is milliseconds per frame from 250-10000, speed is 0.25-2, tailLength is 1-33, density is 0.05-0.75.
- Use keyframes only for explicit static LED arrangements that other effects cannot express. Provide 2-8 keyframes, each with 1-16 segments. LED positions are inclusive and numbered 1-33.
- Choose frameCount, duration, transition, and speed to match the requested mood and motion. Use fade for smooth motion and step for crisp flashes.
- Omit keyframes for other effects. Do not output individual arrays of 33 colors.
- Interpret the user's colors and intent accurately. Never include markdown or explanatory text.`;

function sendJson(response, status, body) {
  const data = JSON.stringify(body);
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(data) });
  response.end(data);
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 8192) throw new Error("Request is too large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function clientAddress(request) {
  return request.headers["x-forwarded-for"]?.split(",")[0].trim() || request.socket.remoteAddress || "unknown";
}

function checkRateLimit(request) {
  const now = Date.now();
  const address = clientAddress(request);
  const current = requests.get(address);
  if (!current || now - current.startedAt >= rateWindow) {
    requests.set(address, { startedAt: now, count: 1 });
    return true;
  }
  if (current.count >= rateLimit) return false;
  current.count += 1;
  return true;
}

async function fetchRecipe(prompt) {
  let lastError;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model,
          messages: [{ role: "system", content: systemPrompt }, { role: "user", content: prompt }],
          response_format: { type: "json_object" },
          temperature: 0.7,
          max_tokens: 4000,
          stream: false,
        }),
        signal: AbortSignal.timeout(45000),
      });
      if (!response.ok) {
        const error = new Error(`DeepSeek returned HTTP ${response.status}`);
        error.retryable = response.status >= 500;
        throw error;
      }
      const result = await response.json();
      const content = result.choices?.[0]?.message?.content;
      if (typeof content !== "string") throw new Error("DeepSeek returned no animation recipe");
      return JSON.parse(content.replace(/^```(?:json)?\s*|\s*```$/g, ""));
    } catch (error) {
      lastError = error;
      if (attempt === 0 && (error.retryable || error.name === "TimeoutError" || error.name === "AbortError" || error instanceof TypeError)) {
        await new Promise((resolve) => setTimeout(resolve, 300));
        continue;
      }
      break;
    }
  }
  throw lastError;
}

async function generate(request, response) {
  if (!apiKey) return sendJson(response, 503, { error: "AI generation is not configured on the server yet." });
  let body;
  try {
    body = await readJson(request);
  } catch {
    return sendJson(response, 400, { error: "Send a valid JSON request smaller than 8 KB." });
  }
  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
  if (prompt.length < 3 || prompt.length > 500) return sendJson(response, 400, { error: "Describe the animation in 3 to 500 characters." });
  if (!checkRateLimit(request)) return sendJson(response, 429, { error: "Generation limit reached. Please try again later." });
  try {
    const recipe = await fetchRecipe(prompt);
    const animation = compileAnimation(recipe);
    animation.id = `draft-${crypto.randomUUID()}`;
    return sendJson(response, 200, { animation });
  } catch (error) {
    console.error("Animation generation failed:", error.message);
    return sendJson(response, 502, { error: "The AI could not build a valid animation. Try rewording your request or try again." });
  }
}

function serveStatic(request, response, pathname) {
  const filename = publicFiles.get(pathname);
  if (!filename) return sendJson(response, 404, { error: "Not found" });
  const filePath = path.join(root, filename);
  const stat = fs.statSync(filePath);
  response.writeHead(200, {
    "Content-Type": mimeTypes[path.extname(filename)],
    "Content-Length": stat.size,
    "Cache-Control": filename === "index.html" ? "no-cache" : "public, max-age=300, must-revalidate",
  });
  if (request.method === "HEAD") return response.end();
  fs.createReadStream(filePath).pipe(response);
}

const server = http.createServer(async (request, response) => {
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("X-Frame-Options", "DENY");
  const pathname = new URL(request.url, "http://localhost").pathname;
  if (pathname === "/api/health" && request.method === "GET") return sendJson(response, 200, { ok: true, aiConfigured: Boolean(apiKey) });
  if (pathname === "/api/generate-animation" && request.method === "POST") return generate(request, response);
  if ((request.method === "GET" || request.method === "HEAD") && !pathname.startsWith("/api/")) return serveStatic(request, response, pathname);
  return sendJson(response, 404, { error: "Not found" });
});

server.listen(port, "0.0.0.0", () => console.log(`Glow listening on port ${port}`));
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => server.close(() => process.exit(0)));
