import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import sharp from "sharp";

/**
 * Renders Icon Composer `.icon` projects to flat PNGs without Icon Composer.
 *
 * Icon Composer (`ictool`) only ships as macOS software, so every automated
 * icon export previously required a Mac. This renders the same `.icon`
 * project sources (layered SVGs + `icon.json` layout) directly, which is
 * sufficient for the static, single-frame outputs this repo actually ships
 * (favicons, PWA icons, the Windows .ico, the Linux/universal icon) — none
 * of those consume Icon Composer's dynamic "glass" material at runtime, so a
 * flattened composite is the correct target, not a lossy approximation of one.
 *
 * Known gaps versus a real Icon Composer export: no drop shadow, layers
 * render fully opaque rather than reproducing the "glass" translucency
 * material, and `"automatic-gradient"` fills are approximated with a plain
 * two-stop vertical gradient rather than Icon Composer's own gradient
 * algorithm. A flat alpha blend of a translucent layer against a plain
 * background (no glass refraction/highlight to compensate) reads as a
 * washed-out, lower-contrast icon rather than anything resembling frosted
 * glass, so it was tried and dropped — geometry (layer scale/position) is
 * reproduced from `icon.json` directly, but content renders opaque.
 */

/** Icon Composer lays out every project on a fixed 1024×1024pt canvas. */
const DESIGN_CANVAS_SIZE = 1024;

interface IconLayerPosition {
  readonly scale: number;
  readonly "translation-in-points": readonly [number, number];
}

interface IconLayer {
  readonly "image-name": string;
  readonly name: string;
  readonly position: IconLayerPosition;
  readonly hidden?: boolean;
}

interface IconGroup {
  readonly layers: ReadonlyArray<IconLayer>;
}

interface IconFill {
  readonly solid?: string;
  readonly "automatic-gradient"?: string;
}

export interface IconComposerProject {
  readonly fill: IconFill;
  readonly groups: ReadonlyArray<IconGroup>;
}

export class IconCompositeError extends Schema.TaggedErrorClass<IconCompositeError>()(
  "IconCompositeError",
  {
    projectDir: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to render Icon Composer project: ${this.projectDir}`;
  }
}

export function parseIconComposerProject(json: string): IconComposerProject {
  const parsed: unknown = JSON.parse(json);
  if (typeof parsed !== "object" || parsed === null || !("groups" in parsed)) {
    throw new Error("Not an Icon Composer project: missing 'groups'.");
  }
  return parsed as IconComposerProject;
}

/**
 * Decodes an Icon Composer `display-p3:r,g,b,a` color string into 0-255 sRGB
 * channels. Treats P3 primaries as sRGB — a visible difference only for
 * highly saturated colors, and every project currently in this repo uses
 * black or white.
 */
export function decodeDisplayP3Color(value: string): {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly alpha: number;
} {
  const match = /^display-p3:([\d.]+),([\d.]+),([\d.]+),([\d.]+)$/.exec(value);
  if (!match || match.length !== 5) {
    throw new Error(`Unrecognized Icon Composer color: ${value}`);
  }
  const [r, g, b, a] = match.slice(1) as [string, string, string, string];
  const channel = (component: string) => Math.round(Number.parseFloat(component) * 255);
  return { r: channel(r), g: channel(g), b: channel(b), alpha: Number.parseFloat(a) };
}

export interface LayerGeometry {
  readonly width: number;
  readonly height: number;
  readonly left: number;
  readonly top: number;
}

/**
 * Clips a rendered layer's geometry to the canvas bounds. Layers are
 * routinely designed to bleed past the canvas edge (e.g. a background scaled
 * slightly larger than 1024pt), and `sharp`'s `composite` rejects an overlay
 * that doesn't fit entirely inside the base image, so overflow must be
 * cropped before compositing rather than left to `sharp` to clip.
 */
export function clipGeometryToCanvas(
  geometry: LayerGeometry,
  canvasSize: number,
): { readonly extract: LayerGeometry; readonly place: { left: number; top: number } } | null {
  const cropLeft = Math.max(0, -geometry.left);
  const cropTop = Math.max(0, -geometry.top);
  const placeLeft = Math.max(0, geometry.left);
  const placeTop = Math.max(0, geometry.top);
  const visibleWidth = Math.min(geometry.width - cropLeft, canvasSize - placeLeft);
  const visibleHeight = Math.min(geometry.height - cropTop, canvasSize - placeTop);
  if (visibleWidth <= 0 || visibleHeight <= 0) return null;
  return {
    extract: { width: visibleWidth, height: visibleHeight, left: cropLeft, top: cropTop },
    place: { left: placeLeft, top: placeTop },
  };
}

/**
 * Computes a layer's pixel geometry at a given output size. Icon Composer
 * scales a layer's own SVG viewBox by `position.scale` on the 1024×1024pt
 * design canvas, then offsets it from canvas center by
 * `position.translation-in-points`; both are expressed in the same points
 * as the canvas, so both scale linearly with the output size.
 */
export function computeLayerGeometry(
  layer: IconLayer,
  svgWidth: number,
  svgHeight: number,
  outputSize: number,
): LayerGeometry {
  const k = outputSize / DESIGN_CANVAS_SIZE;
  const width = Math.max(1, Math.round(svgWidth * layer.position.scale * k));
  const height = Math.max(1, Math.round(svgHeight * layer.position.scale * k));
  const [translateX, translateY] = layer.position["translation-in-points"];
  const left = Math.round((outputSize - width) / 2 + translateX * k);
  const top = Math.round((outputSize - height) / 2 + translateY * k);
  return { width, height, left, top };
}

function readSvgViewportSize(svg: string): { readonly width: number; readonly height: number } {
  const root = /<svg\b[^>]*>/.exec(svg)?.[0];
  if (!root) throw new Error("Layer file has no root <svg> element.");
  const width = /\bwidth="([\d.]+)"/.exec(root)?.[1];
  const height = /\bheight="([\d.]+)"/.exec(root)?.[1];
  if (!width || !height) throw new Error("Layer <svg> is missing an explicit width/height.");
  return { width: Number.parseFloat(width), height: Number.parseFloat(height) };
}

async function renderBackground(fill: IconFill, size: number): Promise<sharp.Sharp> {
  const colorSource = fill.solid ?? fill["automatic-gradient"];
  if (!colorSource) throw new Error("Icon Composer project has no usable 'fill'.");
  const { r, g, b } = decodeDisplayP3Color(colorSource);

  if (fill.solid) {
    return sharp({
      create: { width: size, height: size, channels: 4, background: { r, g, b, alpha: 1 } },
    });
  }

  // "automatic-gradient" fills (Icon Composer generates a gradient from one
  // base color): approximate with a plain vertical gradient from the base
  // color to a darkened variant, rather than reproducing Icon Composer's own
  // gradient algorithm.
  const darker = { r: Math.round(r * 0.55), g: Math.round(g * 0.55), b: Math.round(b * 0.55) };
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">
    <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="rgb(${r},${g},${b})"/>
      <stop offset="1" stop-color="rgb(${darker.r},${darker.g},${darker.b})"/>
    </linearGradient></defs>
    <rect width="${size}" height="${size}" fill="url(#g)"/>
  </svg>`;
  return sharp(Buffer.from(svg)).ensureAlpha();
}

/**
 * Composites an already-loaded Icon Composer project to a flat PNG. Pure
 * apart from `sharp`'s own rendering — every SVG source is passed in rather
 * than read from disk, so this needs no filesystem access and no Effect
 * context, which keeps it directly unit-testable.
 */
export async function compositeIconComposerProject(
  project: IconComposerProject,
  layerSvgs: ReadonlyMap<string, string>,
  size: number,
): Promise<Buffer> {
  const background = await renderBackground(project.fill, size);
  const overlays: Array<sharp.OverlayOptions> = [];

  for (const group of project.groups) {
    // Layers are listed front-to-back; composite back-to-front.
    for (const layer of [...group.layers].reverse()) {
      if (layer.hidden) continue;

      const svg = layerSvgs.get(layer["image-name"]);
      if (svg === undefined) {
        throw new Error(`Missing layer source for '${layer["image-name"]}'.`);
      }
      const { width: svgWidth, height: svgHeight } = readSvgViewportSize(svg);
      const geometry = computeLayerGeometry(layer, svgWidth, svgHeight, size);
      const clipped = clipGeometryToCanvas(geometry, size);
      if (!clipped) continue;

      const rendered = await sharp(Buffer.from(svg))
        .resize(geometry.width, geometry.height, { fit: "fill" })
        .extract(clipped.extract)
        .png()
        .toBuffer();

      overlays.push({ input: rendered, left: clipped.place.left, top: clipped.place.top });
    }
  }

  return background.composite(overlays).png().toBuffer();
}

/** Renders one Icon Composer `.icon` project to a flat, single-frame PNG at `size`×`size`. */
export const renderIconComposerProject = Effect.fn("renderIconComposerProject")(function* (
  projectDir: string,
  size: number,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const project = parseIconComposerProject(
    yield* fs.readFileString(path.join(projectDir, "icon.json")),
  );
  const layerNames = new Set(
    project.groups.flatMap((group) => group.layers.map((layer) => layer["image-name"])),
  );
  const layerSvgs = new Map<string, string>(
    yield* Effect.forEach(
      [...layerNames],
      (imageName) =>
        fs
          .readFileString(path.join(projectDir, "Assets", imageName))
          .pipe(Effect.map((svg) => [imageName, svg] as const)),
      { concurrency: "unbounded" },
    ),
  );

  return yield* Effect.tryPromise({
    try: () => compositeIconComposerProject(project, layerSvgs, size),
    catch: (cause) => new IconCompositeError({ projectDir, cause }),
  });
});
