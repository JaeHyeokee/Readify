const esbuild = require("esbuild");
const fs = require("fs");
const path = require("path");

const isWatch = process.argv.includes("--watch");

const outdir = "dist";

// dist 디렉토리 초기화
if (!fs.existsSync(outdir)) fs.mkdirSync(outdir, { recursive: true });

// 정적 파일 복사
const staticFiles = ["manifest.json", "src/popup/popup.html", "src/popup/popup.css", "src/offscreen/offscreen.html"];
for (const file of staticFiles) {
  const dest = path.join(outdir, path.basename(file));
  fs.copyFileSync(file, dest);
}

// icons 복사
const iconsDir = path.join(outdir, "icons");
if (!fs.existsSync(iconsDir)) fs.mkdirSync(iconsDir, { recursive: true });
for (const file of fs.readdirSync("icons")) {
  fs.copyFileSync(path.join("icons", file), path.join(iconsDir, file));
}

// tesseract worker 파일 복사 (WASM 기반)
// pnpm strict 구조에서는 tesseract.js 경로를 통해 core를 찾는다
const tesseractPath = path.dirname(require.resolve("tesseract.js/package.json"));
const corePath = path.join(tesseractPath, "node_modules", "tesseract.js-core");
const fallbackCorePath = path.resolve("node_modules/.pnpm");
let tesseractCorePath = corePath;

if (!fs.existsSync(corePath)) {
  // pnpm hoisted 구조에서 탐색
  const found = findInDir(fallbackCorePath, "tesseract-core-lstm.wasm.js");
  tesseractCorePath = found ? path.dirname(found) : null;
}

if (tesseractCorePath) {
  const wasmFile = path.join(tesseractCorePath, "tesseract-core-lstm.wasm.js");
  if (fs.existsSync(wasmFile)) {
    fs.copyFileSync(wasmFile, path.join(outdir, "tesseract-core-lstm.wasm.js"));
  }
}

// tesseract worker.min.js 복사
const workerFile = path.join(tesseractPath, "dist", "worker.min.js");
if (fs.existsSync(workerFile)) {
  fs.copyFileSync(workerFile, path.join(outdir, "tesseract-worker.min.js"));
}

/** 디렉토리 내에서 파일명으로 재귀 탐색 */
function findInDir(dir, filename) {
  if (!fs.existsSync(dir)) return null;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const result = findInDir(full, filename);
      if (result) return result;
    } else if (entry.name === filename) {
      return full;
    }
  }
  return null;
}

// esbuild 번들링
const buildOptions = {
  bundle: true,
  format: "iife",
  target: "chrome120",
  outdir,
  logLevel: "info",
};

const entries = [
  { entryPoints: ["src/background.js"], outdir, ...buildOptions },
  { entryPoints: ["src/content.js"], outdir, ...buildOptions },
  {
    entryPoints: ["src/popup/popup.js"],
    outfile: path.join(outdir, "popup.js"),
    bundle: true,
    format: "iife",
    target: "chrome120",
    logLevel: "info",
  },
  {
    entryPoints: ["src/offscreen/offscreen.js"],
    outfile: path.join(outdir, "offscreen.js"),
    bundle: true,
    format: "iife",
    target: "chrome120",
    logLevel: "info",
    define: { "process.env.NODE_ENV": '"production"' },
  },
];

(async () => {
  for (const entry of entries) {
    if (isWatch) {
      const ctx = await esbuild.context(entry);
      await ctx.watch();
    } else {
      await esbuild.build(entry);
    }
  }
  if (!isWatch) console.log("Build complete → dist/");
})();
