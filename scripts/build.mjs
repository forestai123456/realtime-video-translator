import { build } from "esbuild";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const dist = join(root, "dist");

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

const common = {
  bundle: true,
  format: "esm",
  target: "chrome116",
  sourcemap: true,
  logLevel: "info",
};

await Promise.all([
  build({
    ...common,
    entryPoints: ["src/background.ts"],
    outfile: "dist/background.js",
  }),
  build({
    ...common,
    entryPoints: ["src/content/contentScript.ts"],
    outfile: "dist/content/contentScript.js",
  }),
  build({
    ...common,
    entryPoints: ["src/offscreen/offscreen.ts"],
    outfile: "dist/offscreen/offscreen.js",
  }),
	  build({
	    ...common,
	    entryPoints: ["src/popup/popup.ts"],
	    outfile: "dist/popup/popup.js",
	  }),
	  build({
	    ...common,
	    entryPoints: ["src/pdf/pdfTranslation.ts"],
	    outfile: "dist/pdf/pdfTranslation.js",
	  }),
	]);

const staticFiles = [
  ["src/manifest.json", "dist/manifest.json"],
  ["src/content/contentScript.css", "dist/content/contentScript.css"],
  ["src/offscreen/offscreen.html", "dist/offscreen/offscreen.html"],
  ["src/offscreen/audioWorkletProcessor.js", "dist/offscreen/audioWorkletProcessor.js"],
  ["src/popup/popup.html", "dist/popup/popup.html"],
  ["src/popup/popup.css", "dist/popup/popup.css"],
  ["src/pdf/pdfTranslation.html", "dist/pdf/pdfTranslation.html"],
  ["src/pdf/pdfTranslation.css", "dist/pdf/pdfTranslation.css"],
];

await Promise.all(
  staticFiles.map(async ([from, to]) => {
    const target = join(root, to);
    await mkdir(dirname(target), { recursive: true });
    await cp(join(root, from), target);
  }),
);

const manifestPath = join(dist, "manifest.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
manifest.version = JSON.parse(await readFile(join(root, "package.json"), "utf8")).version;
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

console.log("Built extension into dist/");
