#!/usr/bin/env node

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Command, Flag } from "effect/unstable/cli";

import { BRAND_ASSET_PATHS, DEVELOPMENT_PUBLIC_ICON_OVERRIDES } from "./lib/brand-assets.ts";
import { renderIconComposerProject } from "./lib/icon-composite.ts";
import { encodePngIco, WINDOWS_ICON_SIZES } from "./lib/icon-export.ts";

interface VariantOutputs {
  readonly ios: string;
  readonly macos: string;
  readonly universal: string;
  readonly appleTouch: string;
  readonly favicon16: string;
  readonly favicon32: string;
  readonly faviconIco: string;
  readonly windowsIco: string;
  readonly pwaIcon192: string;
  readonly pwaIcon512: string;
  readonly maskableIcon512: string;
}

interface IconVariant {
  readonly label: string;
  readonly source: string;
  readonly outputs: VariantOutputs;
}

export class IconExportFileSystemError extends Schema.TaggedErrorClass<IconExportFileSystemError>()(
  "IconExportFileSystemError",
  {
    operation: Schema.Literals([
      "resolve-repository-root",
      "check-path",
      "read-file",
      "make-directory",
      "make-temp-directory",
      "make-temp-file",
      "write-file",
      "rename-file",
    ]),
    path: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Icon export file-system operation '${this.operation}' failed for ${this.path}.`;
  }
}

export class IconExportSourceMissingError extends Schema.TaggedErrorClass<IconExportSourceMissingError>()(
  "IconExportSourceMissingError",
  {
    sourcePath: Schema.String,
  },
) {
  override get message(): string {
    return `Missing Icon Composer source project: ${this.sourcePath}`;
  }
}

export class IconExportEncodingError extends Schema.TaggedErrorClass<IconExportEncodingError>()(
  "IconExportEncodingError",
  {
    variant: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to encode ICO renditions for the ${this.variant} icon.`;
  }
}

export class IconExportAssetsStaleError extends Schema.TaggedErrorClass<IconExportAssetsStaleError>()(
  "IconExportAssetsStaleError",
  {
    paths: Schema.Array(Schema.String),
  },
) {
  override get message(): string {
    return `Generated icon assets are stale:\n${this.paths.map((path) => `- ${path}`).join("\n")}`;
  }
}

const ICON_VARIANTS = [
  {
    label: "development",
    source: BRAND_ASSET_PATHS.developmentIconComposerProject,
    outputs: {
      ios: BRAND_ASSET_PATHS.developmentIosIconPng,
      macos: BRAND_ASSET_PATHS.developmentDesktopIconPng,
      universal: BRAND_ASSET_PATHS.developmentUniversalIconPng,
      appleTouch: BRAND_ASSET_PATHS.developmentWebAppleTouchIconPng,
      favicon16: BRAND_ASSET_PATHS.developmentWebFavicon16Png,
      favicon32: BRAND_ASSET_PATHS.developmentWebFavicon32Png,
      faviconIco: BRAND_ASSET_PATHS.developmentWebFaviconIco,
      windowsIco: BRAND_ASSET_PATHS.developmentWindowsIconIco,
      pwaIcon192: BRAND_ASSET_PATHS.developmentWebPwaIcon192Png,
      pwaIcon512: BRAND_ASSET_PATHS.developmentWebPwaIcon512Png,
      maskableIcon512: BRAND_ASSET_PATHS.developmentWebMaskableIcon512Png,
    },
  },
  {
    label: "preview",
    source: BRAND_ASSET_PATHS.nightlyIconComposerProject,
    outputs: {
      ios: BRAND_ASSET_PATHS.nightlyIosIconPng,
      macos: BRAND_ASSET_PATHS.nightlyMacIconPng,
      universal: BRAND_ASSET_PATHS.nightlyLinuxIconPng,
      appleTouch: BRAND_ASSET_PATHS.nightlyWebAppleTouchIconPng,
      favicon16: BRAND_ASSET_PATHS.nightlyWebFavicon16Png,
      favicon32: BRAND_ASSET_PATHS.nightlyWebFavicon32Png,
      faviconIco: BRAND_ASSET_PATHS.nightlyWebFaviconIco,
      windowsIco: BRAND_ASSET_PATHS.nightlyWindowsIconIco,
      pwaIcon192: BRAND_ASSET_PATHS.nightlyWebPwaIcon192Png,
      pwaIcon512: BRAND_ASSET_PATHS.nightlyWebPwaIcon512Png,
      maskableIcon512: BRAND_ASSET_PATHS.nightlyWebMaskableIcon512Png,
    },
  },
  {
    label: "production",
    source: BRAND_ASSET_PATHS.productionIconComposerProject,
    outputs: {
      ios: BRAND_ASSET_PATHS.productionIosIconPng,
      macos: BRAND_ASSET_PATHS.productionMacIconPng,
      universal: BRAND_ASSET_PATHS.productionLinuxIconPng,
      appleTouch: BRAND_ASSET_PATHS.productionWebAppleTouchIconPng,
      favicon16: BRAND_ASSET_PATHS.productionWebFavicon16Png,
      favicon32: BRAND_ASSET_PATHS.productionWebFavicon32Png,
      faviconIco: BRAND_ASSET_PATHS.productionWebFaviconIco,
      windowsIco: BRAND_ASSET_PATHS.productionWindowsIconIco,
      pwaIcon192: BRAND_ASSET_PATHS.productionWebPwaIcon192Png,
      pwaIcon512: BRAND_ASSET_PATHS.productionWebPwaIcon512Png,
      maskableIcon512: BRAND_ASSET_PATHS.productionWebMaskableIcon512Png,
    },
  },
] as const satisfies ReadonlyArray<IconVariant>;

const MACOS_EXPORT_CODEX_PROMPT = [
  "Use [@Computer](plugin://computer-use@openai-bundled) and the Icon Composer app to export the three macOS app icons in this repository.",
  "For each project below, use Platform: macOS pre-Tahoe, Appearance: Default, Size: 1024pt, and Scale: 1×, then save the PNG to the exact destination:",
  ...ICON_VARIANTS.map((variant) => `- ${variant.source} -> ${variant.outputs.macos}`),
  "Do not resize, composite, or otherwise post-process the exported PNGs.",
  "Verify every result is 1024×1024 and has the classic macOS safe area: an 824×824 opaque body inset 100px on every side, with only Icon Composer's native shadow extending beyond it.",
];

const RepositoryRoot = Effect.service(Path.Path).pipe(
  Effect.flatMap((path) => path.fromFileUrl(new URL("..", import.meta.url))),
  Effect.mapError(
    (cause) =>
      new IconExportFileSystemError({
        operation: "resolve-repository-root",
        path: new URL("..", import.meta.url).pathname,
        cause,
      }),
  ),
);

const renderVariant = Effect.fn("iconExport.renderVariant")(function* (
  repositoryRoot: string,
  variant: IconVariant,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const sourcePath = path.join(repositoryRoot, variant.source);
  const sourceExists = yield* fs.exists(sourcePath).pipe(
    Effect.mapError(
      (cause) =>
        new IconExportFileSystemError({
          operation: "check-path",
          path: sourcePath,
          cause,
        }),
    ),
  );
  if (!sourceExists) {
    return yield* new IconExportSourceMissingError({ sourcePath: variant.source });
  }

  const renditionCache = new Map<number, Buffer>();
  const render = Effect.fn("iconExport.renderVariant.rendition")(function* (size: number) {
    const cached = renditionCache.get(size);
    if (cached) return cached;

    const contents = yield* renderIconComposerProject(sourcePath, size);
    renditionCache.set(size, contents);
    return contents;
  });

  const ios = yield* render(1024);
  const icoRenditions = yield* Effect.forEach(
    WINDOWS_ICON_SIZES,
    (size) => render(size).pipe(Effect.map((contents) => ({ size, contents }))),
    { concurrency: 1 },
  );
  const ico = yield* Effect.try({
    try: () => encodePngIco(icoRenditions),
    catch: (cause) => new IconExportEncodingError({ variant: variant.label, cause }),
  });
  const pwaIcon512 = yield* render(512);

  return new Map<string, Buffer>([
    [variant.outputs.ios, ios],
    [variant.outputs.universal, ios],
    [variant.outputs.appleTouch, yield* render(180)],
    [variant.outputs.favicon16, yield* render(16)],
    [variant.outputs.favicon32, yield* render(32)],
    [variant.outputs.faviconIco, ico],
    [variant.outputs.windowsIco, ico],
    [variant.outputs.pwaIcon192, yield* render(192)],
    [variant.outputs.pwaIcon512, pwaIcon512],
    [variant.outputs.maskableIcon512, pwaIcon512],
  ]);
});

const logManualMacOsExportInstructions = Effect.fn("iconExport.logManualMacOsExportInstructions")(
  function* () {
    yield* Console.warn(
      [
        "macOS icons require Icon Composer's GUI-only pre-Tahoe preset and were not changed.",
        "Export each source with Platform: macOS pre-Tahoe, Appearance: Default, Size: 1024pt, Scale: 1×:",
        ...ICON_VARIANTS.map((variant) => `- ${variant.source} -> ${variant.outputs.macos}`),
        "See assets/README.md for the complete workflow.",
        "",
        "Copy/paste this prompt into Codex to perform the native exports:",
        "---",
        ...MACOS_EXPORT_CODEX_PROMPT,
        "---",
      ].join("\n"),
    );
  },
);

const writeAtomically = Effect.fn("iconExport.writeAtomically")(function* (
  repositoryRoot: string,
  relativePath: string,
  contents: Buffer,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const targetPath = path.join(repositoryRoot, relativePath);
  const targetDirectory = path.dirname(targetPath);
  yield* fs.makeDirectory(targetDirectory, { recursive: true }).pipe(
    Effect.mapError(
      (cause) =>
        new IconExportFileSystemError({
          operation: "make-directory",
          path: targetDirectory,
          cause,
        }),
    ),
  );
  const temporaryPath = yield* fs
    .makeTempFileScoped({
      directory: targetDirectory,
      prefix: ".t3-icon-export-",
      suffix: ".tmp",
    })
    .pipe(
      Effect.mapError(
        (cause) =>
          new IconExportFileSystemError({
            operation: "make-temp-file",
            path: targetDirectory,
            cause,
          }),
      ),
    );
  yield* fs.writeFile(temporaryPath, contents).pipe(
    Effect.mapError(
      (cause) =>
        new IconExportFileSystemError({
          operation: "write-file",
          path: temporaryPath,
          cause,
        }),
    ),
  );
  yield* fs.rename(temporaryPath, targetPath).pipe(
    Effect.mapError(
      (cause) =>
        new IconExportFileSystemError({
          operation: "rename-file",
          path: targetPath,
          cause,
        }),
    ),
  );
});

const isCurrent = Effect.fn("iconExport.isCurrent")(function* (
  repositoryRoot: string,
  relativePath: string,
  expected: Buffer,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const targetPath = path.join(repositoryRoot, relativePath);
  const exists = yield* fs.exists(targetPath).pipe(
    Effect.mapError(
      (cause) =>
        new IconExportFileSystemError({
          operation: "check-path",
          path: targetPath,
          cause,
        }),
    ),
  );
  if (!exists) return false;

  const actual = yield* fs.readFile(targetPath).pipe(
    Effect.mapError(
      (cause) =>
        new IconExportFileSystemError({
          operation: "read-file",
          path: targetPath,
          cause,
        }),
    ),
  );
  return Buffer.from(actual).equals(expected);
});

export const exportBrandIcons = Effect.fn("exportBrandIcons")(function* (checkOnly: boolean) {
  const repositoryRoot = yield* RepositoryRoot;

  const generated = new Map<string, Buffer>();
  for (const variant of ICON_VARIANTS) {
    yield* Console.log(`Rendering ${variant.label} from ${variant.source}...`);
    const variantAssets = yield* renderVariant(repositoryRoot, variant);
    for (const [relativePath, contents] of variantAssets) {
      generated.set(relativePath, contents);
    }
  }

  for (const override of DEVELOPMENT_PUBLIC_ICON_OVERRIDES) {
    const sourceContents = generated.get(override.sourceRelativePath);
    if (sourceContents === undefined) {
      return yield* Effect.die(
        new Error(`Generated development web icon is missing: ${override.sourceRelativePath}`),
      );
    }
    generated.set(override.targetRelativePath, sourceContents);
  }

  if (checkOnly) {
    const stale = yield* Effect.filter(
      [...generated.entries()],
      ([relativePath, contents]) =>
        isCurrent(repositoryRoot, relativePath, contents).pipe(Effect.map((current) => !current)),
      { concurrency: "unbounded" },
    );
    if (stale.length > 0) {
      return yield* new IconExportAssetsStaleError({
        paths: stale.map(([relativePath]) => relativePath),
      });
    }
    yield* Console.log(`All ${generated.size} generated icon assets are current.`);
    yield* logManualMacOsExportInstructions();
    return;
  }

  yield* Effect.forEach(
    generated,
    ([relativePath, contents]) => writeAtomically(repositoryRoot, relativePath, contents),
    { concurrency: 1, discard: true },
  );
  yield* Console.log(`Updated ${generated.size} generated icon assets.`);
  yield* logManualMacOsExportInstructions();
});

export const exportBrandIconsCommand = Command.make(
  "export-brand-icons",
  {
    check: Flag.boolean("check").pipe(
      Flag.withDescription("Verify generated icon assets without modifying files."),
      Flag.withDefault(false),
    ),
  },
  ({ check }) => exportBrandIcons(check).pipe(Effect.scoped),
).pipe(
  Command.withDescription(
    "Render development, preview, and production web/desktop icon assets from their .icon project sources (macOS's own app icon stays a manual Icon Composer export — see the logged instructions).",
  ),
);

if (import.meta.main) {
  Command.run(exportBrandIconsCommand, { version: "0.0.0" }).pipe(
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
}
