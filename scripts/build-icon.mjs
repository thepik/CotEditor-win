/**
 * Flatten the original macOS CotEditor AppIcon into a Windows app icon.
 *
 * The source icon is a multi-layer Apple `.icon` composition defined by
 * `CotEditor-main/.../AppIcon.icon/icon.json`:
 *   - Outline.svg  : rounded-square mask filled with a green linear gradient
 *                    (the app's brand colour) -> the icon background.
 *   - Gears_Fill   : two interlocking gears, white fill at ~0.14 alpha
 *                    (0.7 group * 0.2 layer).
 *   - Gears_Stroke : the same gears' outlines, white at ~0.7 alpha.
 *   - Shadow.png   : a pre-rendered soft drop shadow under the pen (0.4 alpha).
 *   - Pen.png      : the foreground pen glyph.
 *
 * The macOS spec applies "automatic" gradients/specular/translucency that we
 * can't reproduce 1:1 without the AssetCompositor runtime. We approximate the
 * light-appearance look: green rounded square -> faint white gears -> pen with
 * a soft shadow. The result is a flat 1024px PNG (`build/appicon.png`) plus a
 * multi-size `.ico` (`build/windows/icon.ico`) for the Windows exe resource.
 *
 * Run: `node scripts/build-icon.mjs`
 */

import { readFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Resvg } from "@resvg/resvg-js";
import sharp from "sharp";
import pngToIco from "png-to-ico";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const SRC = join(ROOT, "..", "CotEditor-main", "CotEditor", "Resources", "AppIcon.icon", "Assets");
const BUILD = join(ROOT, "build");

const SIZE = 1024;

/* --- green gradient on the rounded-square outline path ------------------- */

// The Outline.svg draws only the path (no fill). We inject a linear gradient
// matching the spec's display-p3 greens, approximated in sRGB:
//   start: display-p3(0.304, 0.600, 0.120) ≈ #4E9A1E-ish
//   end:   display-p3(0.602, 0.720, 0.216) ≈ #9BBA37-ish
// We use the sRGB clamped equivalents below.
const GREEN_START = "#3f9a1e";
const GREEN_END = "#8db52a";

async function renderGreenSquare() {
  const outlineSvg = readFileSync(join(SRC, "Outline.svg"), "utf8");
  // Reuse the original rounded-rect path, filled with a green linear gradient
  // approximating the spec's display-p3 brand greens in sRGB.
  const pathMatch = outlineSvg.match(/<path d="([^"]+)"/);
  if (!pathMatch) throw new Error("Outline.svg path not found");
  const d = pathMatch[1];
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">
       <defs>
         <linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
           <stop offset="0" stop-color="${GREEN_START}"/>
           <stop offset="1" stop-color="${GREEN_END}"/>
         </linearGradient>
       </defs>
       <path d="${d}" fill="url(#g)"/>
     </svg>`;
  const resvg = new Resvg(svg, { fitTo: { mode: "width", value: SIZE } });
  return resvg.render().asPng();
}

/* --- gears (white, clipped to the rounded square) ------------------------- */

// Gears_Fill.svg ships a <clipPath> (the rounded square) wrapping the gear
// paths with fill #ffffff. We want the gears clipped to the square and drawn
// white at ~0.14 alpha (group 0.7 * layer 0.2). The stroke variant is the same
// geometry drawn as outlines at ~0.7 alpha.
async function renderGears(svgFile, opacity) {
  const svg = readFileSync(join(SRC, svgFile), "utf8");
  const resvg = new Resvg(svg, { fitTo: { mode: "width", value: SIZE } });
  const png = resvg.render().asPng();
  // The SVG already uses fill:#ffffff / stroke, but no opacity. Apply alpha by
  // scaling the alpha channel to the given opacity, then return a PNG Buffer.
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  for (let i = 0; i < data.length; i += 4) {
    data[i + 3] = Math.round(data[i + 3] * opacity); // scale alpha
  }
  return sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } }).png().toBuffer();
}

/** Scale a PNG's alpha channel by `opacity` and return a PNG Buffer. */
async function withAlpha(pngBuf, opacity) {
  const { data, info } = await sharp(pngBuf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  for (let i = 0; i < data.length; i += 4) {
    data[i + 3] = Math.round(data[i + 3] * opacity);
  }
  return sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } }).png().toBuffer();
}

/* --- compose -------------------------------------------------------------- */

async function main() {
  console.log("Rendering green rounded-square background...");
  const bgPng = await renderGreenSquare();

  console.log("Rendering gear fill (alpha 0.14)...");
  const gearsFill = await renderGears("Gears_Fill.svg", 0.14);
  console.log("Rendering gear stroke (alpha 0.7)...");
  const gearsStroke = await renderGears("Gears_Stroke.svg", 0.7);

  console.log("Reading Pen.png and Shadow.png...");
  const penPng = readFileSync(join(SRC, "Pen.png"));
  const shadowPng = readFileSync(join(SRC, "Shadow.png"));

  // Compose bottom-up: background, gears-fill, gears-stroke, shadow(0.4), pen.
  console.log("Compositing layers...");
  const shadowLayer = await withAlpha(shadowPng, 0.4);
  const composited = await sharp(bgPng)
    .composite([
      { input: gearsFill, blend: "over" },
      { input: gearsStroke, blend: "over" },
      { input: shadowLayer, blend: "over" },
      { input: penPng, blend: "over" },
    ])
    .png()
    .toBuffer();

  // Write the flat 1024 PNG.
  mkdirSync(BUILD, { recursive: true });
  const appiconPath = join(BUILD, "appicon.png");
  await sharp(composited).resize(SIZE, SIZE).png().toFile(appiconPath);
  console.log(`Wrote ${appiconPath}`);

  // Build a multi-size .ico (sizes Wails/winres expects: 256,128,64,48,32,16).
  console.log("Generating multi-size icon.ico...");
  const icoSizes = [256, 128, 64, 48, 32, 16];
  const icoBuffers = await Promise.all(
    icoSizes.map((s) => sharp(composited).resize(s, s).png().toBuffer()),
  );
  const ico = await pngToIco(icoBuffers);
  const icoDir = join(BUILD, "windows");
  mkdirSync(icoDir, { recursive: true });
  const icoPath = join(icoDir, "icon.ico");
  await import("node:fs/promises").then(({ writeFile }) => writeFile(icoPath, ico));
  console.log(`Wrote ${icoPath}`);

  console.log("\nDone. Replaced build/appicon.png and build/windows/icon.ico with the CotEditor icon.");
}

main().catch((err) => {
  console.error("Icon build failed:", err);
  process.exit(1);
});
