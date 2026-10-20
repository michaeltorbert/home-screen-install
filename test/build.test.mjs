// Distribution tests: exact format, API and version parity between the source,
// the ES module and the classic script, deterministic output, drift guards and
// the generated demo icons.
// Read-only: nothing here writes generated files (run `npm run build` first).

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import vm from "node:vm";

import { inflateSync } from "node:zlib";

import {
  CHECKSUMS_PATH,
  CLASSIC_PATH,
  DEMO_ICONS,
  ESM_PATH,
  GLOBAL_NAME,
  ICON_SIZES,
  PUBLIC_API,
  ROOT,
  SOURCE_PATH,
  VERSION_PLACEHOLDER,
  buildArtifacts,
  iconPalette,
  readPackage,
  staleArtifacts,
  transform,
} from "../scripts/build.mjs";

const pkg = readPackage();
const read = (path) => readFileSync(join(ROOT, path), "utf8");
const iconPaths = DEMO_ICONS.flatMap(({ dir }) => [`${dir}/icon.svg`, ...ICON_SIZES.map((size) => `${dir}/icon-${size}.png`)]);
const generated = [CLASSIC_PATH, ESM_PATH, CHECKSUMS_PATH, ...iconPaths];

for (const path of generated) {
  if (!existsSync(join(ROOT, path))) throw new Error(`${path} is missing; run npm run build first`);
}

test("package is a private 0.1.0 package with no dependencies", () => {
  assert.equal(pkg.name, "home-screen-install");
  assert.equal(pkg.version, "0.1.0");
  assert.equal(pkg.private, true);
  for (const key of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies", "bundleDependencies"]) {
    assert.equal(pkg[key], undefined, `${key} must be absent`);
  }
  assert.equal(pkg.exports["."].import, `./${ESM_PATH}`);
  assert.equal(pkg.exports["./classic"], `./${CLASSIC_PATH}`);
});

test("build output is deterministic and building does not write", () => {
  const before = generated.map((path) => [statSync(join(ROOT, path)).mtimeMs, read(path)]);
  const first = buildArtifacts();
  const second = buildArtifacts();
  assert.deepEqual([...first.keys()].sort(), [...generated].sort());
  for (const [path, content] of first) assert.ok(content.equals(second.get(path)), path);
  const after = generated.map((path) => [statSync(join(ROOT, path)).mtimeMs, read(path)]);
  assert.deepEqual(after, before);
  for (const [path, content] of first) {
    if (path.endsWith(".png")) continue;
    const text = content.toString("utf8");
    assert.ok(!text.includes("\r"), `${path}: LF line endings only`);
    assert.doesNotMatch(text, /\b20\d\d-\d\d-\d\d/, `${path}: no build timestamps`);
  }
});

function readPng(buffer) {
  assert.deepEqual([...buffer.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], "PNG signature");
  const chunks = [];
  let offset = 8;
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    const crc = buffer.readUInt32BE(offset + 8 + length);
    assert.equal(crc, zlibCrc32(buffer.subarray(offset + 4, offset + 8 + length)), `${type} CRC`);
    chunks.push({ type, data });
    offset += 12 + length;
  }
  assert.equal(offset, buffer.length, "no trailing bytes");
  return chunks;
}

// Independent CRC-32 so the test does not reuse the build's implementation.
function zlibCrc32(buffer) {
  let crc = ~0;
  for (const byte of buffer) {
    crc ^= byte;
    for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return ~crc >>> 0;
}

test("demo icons are valid PNG and SVG files with the expected pixels", () => {
  for (const { dir, background } of DEMO_ICONS) {
    const svg = read(`${dir}/icon.svg`);
    assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 100 100">/);
    assert.ok(svg.includes(`fill="${background}"`));

    for (const size of ICON_SIZES) {
      const path = `${dir}/icon-${size}.png`;
      const chunks = readPng(readFileSync(join(ROOT, path)));
      assert.deepEqual(chunks.map((chunk) => chunk.type), ["IHDR", "PLTE", "IDAT", "IEND"], path);
      const header = chunks[0].data;
      assert.equal(header.readUInt32BE(0), size, `${path} width`);
      assert.equal(header.readUInt32BE(4), size, `${path} height`);
      assert.deepEqual([...header.subarray(8)], [8, 3, 0, 0, 0], `${path} 8-bit palette, no interlace`);
      const palette = [...chunks[1].data];
      assert.deepEqual(palette, iconPalette(background), `${path} palette`);

      // node:zlib is only used here, to independently decode the build's deflate stream.
      const raw = inflateSync(chunks[2].data);
      assert.equal(raw.length, size * (size + 1), `${path} decoded size`);
      const pixels = new Uint8Array(size * size);
      for (let y = 0; y < size; y++) {
        const filter = raw[y * (size + 1)];
        assert.ok(filter === 0 || filter === 2, `${path} row ${y} filter ${filter}`);
        for (let x = 0; x < size; x++) {
          const value = raw[y * (size + 1) + 1 + x];
          pixels[y * size + x] = filter === 2 && y > 0 ? (value + pixels[(y - 1) * size + x]) & 255 : value;
        }
      }
      const at = (fx, fy) => pixels[Math.floor(fy * size) * size + Math.floor(fx * size)];
      const levels = palette.length / 3 - 1;
      assert.equal(at(0.02, 0.02), 0, `${path} corner is background`);
      assert.equal(at(0.5, 0.4), levels, `${path} house body is foreground`);
      assert.equal(at(0.5, 0.72), 0, `${path} door is background`);
      assert.equal(at(0.5, 0.92), 0, `${path} below the house is background`);
      assert.ok(pixels.every((index) => index <= levels), `${path} indices within palette`);
    }
  }
});

test("dist on disk matches a fresh build of the source", () => {
  assert.deepEqual(staleArtifacts(), [], "dist is stale; run npm run build");
  const check = spawnSync(process.execPath, [join(ROOT, "scripts/build.mjs"), "--check"], { encoding: "utf8" });
  assert.equal(check.status, 0, check.stderr);
});

test("SHA256SUMS lists both scripts with correct hashes in shasum -c format", () => {
  const lines = read(CHECKSUMS_PATH).split("\n");
  assert.equal(lines.pop(), "", "ends with a newline");
  assert.deepEqual(
    lines.map((line) => line.slice(66)),
    ["home-screen-install.js", "home-screen-install.mjs"]
  );
  for (const line of lines) {
    const match = /^([0-9a-f]{64}) {2}(home-screen-install\.m?js)$/.exec(line);
    assert.ok(match, line);
    const actual = createHash("sha256").update(readFileSync(join(ROOT, "dist", match[2]))).digest("hex");
    assert.equal(match[1], actual, match[2]);
  }
});

test("ES module exports exactly the public API with the package version", async () => {
  const esm = await import(pathToFileURL(join(ROOT, ESM_PATH)).href);
  assert.deepEqual(Object.keys(esm).sort(), [...PUBLIC_API].sort());
  assert.equal(esm.VERSION, pkg.version);
  const text = read(ESM_PATH);
  assert.equal(text.match(/^export\b/gm).length, 1);
  assert.match(text, new RegExp(`\\nexport \\{ ${PUBLIC_API.join(", ")} \\};\\n$`));
  assert.doesNotMatch(text, /^\s*import\b/m);
});

test("classic script parses as a script and defines only the frozen global", () => {
  const code = read(CLASSIC_PATH);
  const script = new vm.Script(code, { filename: CLASSIC_PATH });
  const context = vm.createContext({});
  script.runInContext(context);
  assert.deepEqual(Object.keys(context), [GLOBAL_NAME]);
  const api = context[GLOBAL_NAME];
  assert.deepEqual(Object.keys(api), [...PUBLIC_API]);
  assert.ok(Object.isFrozen(api));
  assert.equal(api.VERSION, pkg.version);
  for (const name of PUBLIC_API.slice(1)) assert.equal(typeof api[name], "function", name);
});

test("loading either build reads no browser globals", async () => {
  const touched = [];
  const context = {};
  for (const name of ["window", "document", "navigator", "matchMedia", "self", "location", "customElements"]) {
    Object.defineProperty(context, name, {
      configurable: true,
      get() {
        touched.push(name);
        return undefined;
      },
    });
  }
  vm.runInContext(read(CLASSIC_PATH), vm.createContext(context));
  assert.deepEqual(touched, []);

  // Node itself has no window; importing the ES module must still succeed.
  assert.equal(typeof globalThis.window, "undefined");
  const esm = await import(pathToFileURL(join(ROOT, ESM_PATH)).href);
  assert.equal(esm.isStandaloneDisplay(), false);
});

test("both builds embed the same transformed source body", () => {
  const source = read(SOURCE_PATH);
  assert.equal(source.split(VERSION_PLACEHOLDER).length - 1, 1, "source keeps one version placeholder");
  const { body } = transform(source, pkg.version);
  assert.ok(body.includes(`const VERSION = ${JSON.stringify(pkg.version)};`));
  for (const path of [ESM_PATH, CLASSIC_PATH]) {
    const text = read(path);
    assert.ok(text.includes(body), `${path} contains the source body`);
    assert.ok(!text.includes(VERSION_PLACEHOLDER), `${path} has no placeholder`);
    assert.ok(text.startsWith(`/*! home-screen-install v${pkg.version} |`), `${path} banner`);
  }
});

test("shipped code has no network, storage, audio, telemetry or host-event interference", () => {
  const forbidden = [
    /\bfetch\s*\(/,
    /XMLHttpRequest/,
    /WebSocket/,
    /EventSource/,
    /sendBeacon/,
    /localStorage/,
    /sessionStorage/,
    /indexedDB/,
    /document\.cookie/,
    /caches\./,
    /serviceWorker/,
    /\bAudio\b/,
    /AudioContext/,
    /speechSynthesis/,
    /\bvibrate\b/,
    /stopPropagation/,
    /stopImmediatePropagation/,
    /innerHTML/,
    /outerHTML/,
    /insertAdjacentHTML/,
    /document\.write/,
    /\beval\s*\(/,
    /new Function/,
    /userAgent/,
    /referrer/,
    /fullscreen/i,
    /beforeinstallprompt/,
    /customElements/,
    /https?:\/\/(?!www\.w3\.org\/2000\/svg")/,
  ];
  for (const path of [SOURCE_PATH, ESM_PATH, CLASSIC_PATH]) {
    const text = read(path);
    for (const pattern of forbidden) assert.doesNotMatch(text, pattern, `${path}: ${pattern}`);
  }
});

const minimalSource = [
  `const VERSION = "${VERSION_PLACEHOLDER}";`,
  "function isStandaloneDisplay() {}",
  "function watchDisplayMode() {}",
  "function mount() {}",
  "",
  "export { VERSION, isStandaloneDisplay, watchDisplayMode, mount };",
  "",
].join("\n");

test("transform accepts the expected source shape", () => {
  const { esm, classic } = transform(minimalSource, "1.2.3");
  assert.match(esm, /const VERSION = "1\.2\.3";/);
  assert.match(classic, /const VERSION = "1\.2\.3";/);
  assert.match(classic, /root\.HomeScreenInstall = Object\.freeze\(\{ VERSION: VERSION, isStandaloneDisplay: isStandaloneDisplay, watchDisplayMode: watchDisplayMode, mount: mount \}\);/);
  assert.deepEqual(transform(minimalSource.replace(/\n/g, "\r\n"), "1.2.3"), transform(minimalSource, "1.2.3"));
});

test("transform rejects source drift and unsafe versions", () => {
  const exportLine = "export { VERSION, isStandaloneDisplay, watchDisplayMode, mount };";
  const drifted = {
    "missing placeholder": minimalSource.replace(`"${VERSION_PLACEHOLDER}"`, '"0.0.0"'),
    "duplicate placeholder": minimalSource + `// ${VERSION_PLACEHOLDER}\n`,
    "unquoted placeholder": minimalSource.replace(`"${VERSION_PLACEHOLDER}"`, VERSION_PLACEHOLDER),
    "missing export": minimalSource.replace(exportLine, ""),
    "missing name": minimalSource.replace(exportLine, "export { VERSION, isStandaloneDisplay, mount };"),
    "extra name": minimalSource.replace(exportLine, "export { VERSION, isStandaloneDisplay, watchDisplayMode, mount, extra };"),
    "reordered names": minimalSource.replace(exportLine, "export { mount, VERSION, isStandaloneDisplay, watchDisplayMode };"),
    "second export statement": minimalSource.replace("function mount() {}", "export function mount() {}"),
    "default export": minimalSource + "export default mount;\n",
    "code after export": minimalSource + "mount();\n",
    "static import": "import x from './x.js';\n" + minimalSource,
    "dynamic import": minimalSource.replace("function mount() {}", "function mount() { return import('./x.js'); }"),
    "import.meta": minimalSource.replace("function mount() {}", "function mount() { return import.meta.url; }"),
  };
  for (const [name, source] of Object.entries(drifted)) {
    assert.throws(() => transform(source, "1.2.3"), /^Error: build:/, name);
  }
  for (const version of ["1.0", "v1.0.0", '0.1.0"; alert(1); "', "", undefined]) {
    assert.throws(() => transform(minimalSource, version), /^Error: build:/, String(version));
  }
});
