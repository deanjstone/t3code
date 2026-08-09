import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import sharp from "sharp";

import {
  clipGeometryToCanvas,
  compositeIconComposerProject,
  computeLayerGeometry,
  decodeDisplayP3Color,
  type IconComposerProject,
  parseIconComposerProject,
  renderIconComposerProject,
} from "./icon-composite.ts";

describe("parseIconComposerProject", () => {
  it("parses a minimal project", () => {
    const project = parseIconComposerProject(
      JSON.stringify({ fill: { solid: "display-p3:0,0,0,1" }, groups: [] }),
    );
    assert.deepEqual(project.groups, []);
  });

  it("rejects a document with no 'groups'", () => {
    assert.throws(() => parseIconComposerProject(JSON.stringify({ fill: {} })), /groups/);
  });
});

describe("decodeDisplayP3Color", () => {
  it("decodes black", () => {
    assert.deepEqual(decodeDisplayP3Color("display-p3:0.00000,0.00000,0.00000,1.00000"), {
      r: 0,
      g: 0,
      b: 0,
      alpha: 1,
    });
  });

  it("decodes white", () => {
    assert.deepEqual(decodeDisplayP3Color("display-p3:1.00000,1.00000,1.00000,1.00000"), {
      r: 255,
      g: 255,
      b: 255,
      alpha: 1,
    });
  });

  it("rejects an unrecognized color string", () => {
    assert.throws(() => decodeDisplayP3Color("rgb(0,0,0)"), /Unrecognized Icon Composer color/);
  });
});

describe("computeLayerGeometry", () => {
  const layer = (scale: number, translation: readonly [number, number]) => ({
    "image-name": "x.svg",
    name: "x",
    position: { scale, "translation-in-points": translation },
  });

  it("scales a layer's own viewBox by 'scale', centered on the design canvas", () => {
    // 128×128 viewBox at scale 8 on a 1024 canvas fills the canvas exactly (128*8=1024).
    const geometry = computeLayerGeometry(layer(8, [0, 0]), 128, 128, 1024);
    assert.deepEqual(geometry, { width: 1024, height: 1024, left: 0, top: 0 });
  });

  it("scales geometry linearly with output size", () => {
    const geometry = computeLayerGeometry(layer(8, [0, 0]), 128, 128, 512);
    assert.deepEqual(geometry, { width: 512, height: 512, left: 0, top: 0 });
  });

  it("offsets from canvas center by translation-in-points, scaled with output size", () => {
    // A 0-size layer at output size 1024 sits at canvas center (512, 512);
    // translation moves it right/down from there.
    const geometry = computeLayerGeometry(layer(0, [100, -50]), 0, 0, 1024);
    assert.equal(geometry.left, 512 + 100);
    assert.equal(geometry.top, 512 - 50);
  });
});

describe("clipGeometryToCanvas", () => {
  it("passes through geometry that already fits the canvas", () => {
    const clipped = clipGeometryToCanvas({ width: 100, height: 100, left: 10, top: 10 }, 512);
    assert.deepEqual(clipped, {
      extract: { width: 100, height: 100, left: 0, top: 0 },
      place: { left: 10, top: 10 },
    });
  });

  it("crops a layer that bleeds past the top-left edge", () => {
    const clipped = clipGeometryToCanvas({ width: 100, height: 100, left: -10, top: -20 }, 512);
    assert.deepEqual(clipped, {
      extract: { width: 90, height: 80, left: 10, top: 20 },
      place: { left: 0, top: 0 },
    });
  });

  it("crops a layer that bleeds past the bottom-right edge", () => {
    const clipped = clipGeometryToCanvas({ width: 100, height: 100, left: 450, top: 480 }, 512);
    assert.deepEqual(clipped, {
      extract: { width: 62, height: 32, left: 0, top: 0 },
      place: { left: 450, top: 480 },
    });
  });

  it("returns null for a layer entirely off-canvas", () => {
    assert.isNull(clipGeometryToCanvas({ width: 50, height: 50, left: 600, top: 0 }, 512));
  });
});

function squareSvg(size: number, fill: string): string {
  return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" xmlns="http://www.w3.org/2000/svg"><rect width="${size}" height="${size}" fill="${fill}"/></svg>`;
}

async function pixelAt(png: Buffer, x: number, y: number): Promise<[number, number, number]> {
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const offset = (y * info.width + x) * info.channels;
  return [data.at(offset) ?? 0, data.at(offset + 1) ?? 0, data.at(offset + 2) ?? 0];
}

describe("compositeIconComposerProject", () => {
  const solidBlackProject: IconComposerProject = {
    fill: { solid: "display-p3:0.00000,0.00000,0.00000,1.00000" },
    groups: [
      {
        layers: [
          {
            "image-name": "mark.svg",
            name: "Mark",
            position: { scale: 4, "translation-in-points": [0, 0] },
          },
        ],
      },
    ],
  };

  it("composites a solid background under a centered layer at the requested size", async () => {
    const png = await compositeIconComposerProject(
      solidBlackProject,
      new Map([["mark.svg", squareSvg(64, "white")]]),
      256,
    );
    const { info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
    assert.equal(info.width, 256);
    assert.equal(info.height, 256);

    // Corner stays background black; a solid white mark scaled to fill the
    // canvas (64 * 4 = 256) should make the center white.
    assert.deepEqual(await pixelAt(png, 2, 2), [0, 0, 0]);
    assert.deepEqual(await pixelAt(png, 128, 128), [255, 255, 255]);
  });

  it("skips hidden layers", async () => {
    const project: IconComposerProject = {
      ...solidBlackProject,
      groups: [
        {
          layers: solidBlackProject.groups[0]!.layers.map((layer) => ({ ...layer, hidden: true })),
        },
      ],
    };
    const png = await compositeIconComposerProject(
      project,
      new Map([["mark.svg", squareSvg(64, "white")]]),
      256,
    );
    assert.deepEqual(await pixelAt(png, 128, 128), [0, 0, 0]);
  });

  it("throws when a layer references a source that wasn't loaded", async () => {
    try {
      await compositeIconComposerProject(solidBlackProject, new Map(), 256);
      assert.fail("expected compositeIconComposerProject to reject");
    } catch (error) {
      assert.match(String(error), /Missing layer source/);
    }
  });
});

describe("renderIconComposerProject", () => {
  it.layer(NodeServices.layer)("reads project files from disk and renders", (it) => {
    it.effect("renders the requested size from a real .icon project directory", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const projectDir = yield* fs.makeTempDirectoryScoped();
        yield* fs.makeDirectory(path.join(projectDir, "Assets"));
        yield* fs.writeFileString(
          path.join(projectDir, "icon.json"),
          `{
            "fill": { "solid": "display-p3:0.00000,0.00000,0.00000,1.00000" },
            "groups": [
              {
                "layers": [
                  {
                    "image-name": "mark.svg",
                    "name": "Mark",
                    "position": { "scale": 4, "translation-in-points": [0, 0] }
                  }
                ]
              }
            ]
          }`,
        );
        yield* fs.writeFileString(
          path.join(projectDir, "Assets", "mark.svg"),
          squareSvg(64, "white"),
        );

        const png = yield* renderIconComposerProject(projectDir, 128);
        const { info } = yield* Effect.promise(() =>
          sharp(png).raw().toBuffer({ resolveWithObject: true }),
        );
        assert.equal(info.width, 128);
        assert.equal(info.height, 128);
      }).pipe(Effect.scoped),
    );
  });
});
