#!/usr/bin/env node
// Static server for the demos. Serves only demo/ and dist/ from the package
// root, with a fixed file-type allowlist.
//
//   node demo/serve.mjs                  http://localhost:8796/ (127.0.0.1 and ::1)
//   node demo/serve.mjs --port 9000      another port
//   node demo/serve.mjs --host 0.0.0.0   another interface (e.g. a physical device on the LAN)
//
// Keep the default port for native Home Screen testing: an installed icon
// remembers the exact origin, including the port.

import { createServer } from "node:http";
import { readFile, realpath, stat } from "node:fs/promises";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const DEFAULT_PORT = 8796;
const DEFAULT_HOSTS = ["127.0.0.1", "::1"];

const TYPES = {
  demo: {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".webmanifest": "application/manifest+json",
    ".png": "image/png",
    ".svg": "image/svg+xml",
  },
  dist: {
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
  },
};

function send(res, status, message, headers = {}) {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", ...headers });
  res.end(`${message}\n`);
}

async function handle(root, req, res) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    send(res, 405, "Method not allowed", { Allow: "GET, HEAD" });
    return;
  }
  let rawPath;
  let pathname;
  try {
    rawPath = new URL(req.url, "http://localhost").pathname;
    pathname = decodeURIComponent(rawPath);
  } catch {
    send(res, 400, "Bad request");
    return;
  }
  if (pathname === "/") {
    send(res, 302, "Found", { Location: "/demo/" });
    return;
  }
  if (pathname.includes("\0") || pathname.includes("\\")) {
    send(res, 400, "Bad request");
    return;
  }

  const segments = pathname.split("/").slice(1);
  const trailingSlash = segments[segments.length - 1] === "";
  if (trailingSlash) segments.pop();
  const types = TYPES[segments[0]];
  // Rejects "..", ".", empty segments and dotfiles after decoding.
  if (!types || segments.some((segment) => segment === "" || segment.startsWith("."))) {
    send(res, 404, "Not found");
    return;
  }

  let file = join(root, ...segments);
  let info;
  try {
    info = await stat(file);
    if (info.isDirectory()) {
      if (!trailingSlash) {
        send(res, 301, "Moved", { Location: `${rawPath}/` });
        return;
      }
      file = join(file, "index.html");
      info = await stat(file);
    } else if (trailingSlash) {
      throw new Error("not a directory");
    }
  } catch {
    send(res, 404, "Not found");
    return;
  }

  const type = types[extname(file)];
  const realRoot = await realpath(root);
  const realFile = await realpath(file);
  if (!info.isFile() || !type || !realFile.startsWith(realRoot + sep)) {
    send(res, 404, "Not found");
    return;
  }

  const body = await readFile(realFile);
  res.writeHead(200, {
    "Content-Type": type,
    "Content-Length": body.length,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
  });
  res.end(req.method === "HEAD" ? undefined : body);
}

/** An http.Server for the demos; the caller chooses where it listens. */
export function createDemoServer({ root = ROOT } = {}) {
  return createServer((req, res) => {
    handle(root, req, res).catch(() => {
      if (!res.headersSent) send(res, 500, "Server error");
      else res.destroy();
    });
  });
}

function listen(server, port, host) {
  return new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolvePromise(server);
    });
  });
}

function parseArgs(args) {
  const options = { port: DEFAULT_PORT, hosts: DEFAULT_HOSTS };
  for (let i = 0; i < args.length; i++) {
    const value = args[i + 1];
    if (args[i] === "--port" && /^\d+$/.test(value ?? "") && Number(value) < 65536) {
      options.port = Number(value);
      i++;
    } else if (args[i] === "--host" && value) {
      options.hosts = [value];
      i++;
    } else {
      throw new Error(`unknown or incomplete argument: ${args[i]}`);
    }
  }
  return options;
}

async function main(args) {
  let options;
  try {
    options = parseArgs(args);
  } catch (error) {
    console.error(`serve: ${error.message}\nusage: node demo/serve.mjs [--port 8796] [--host 127.0.0.1]`);
    process.exitCode = 2;
    return;
  }

  const servers = [];
  for (const [index, host] of options.hosts.entries()) {
    const server = createDemoServer();
    try {
      servers.push(await listen(server, options.port, host));
    } catch (error) {
      // ::1 is optional when IPv6 loopback is unavailable; anything else is fatal.
      const optional = index > 0 && ["EADDRNOTAVAIL", "EAFNOSUPPORT"].includes(error.code);
      if (!optional) {
        for (const open of servers) open.close();
        console.error(`serve: cannot listen on ${host}:${options.port}: ${error.message}`);
        process.exitCode = 1;
        return;
      }
    }
  }

  const name = options.hosts.length === 1 && !DEFAULT_HOSTS.includes(options.hosts[0]) ? options.hosts[0] : "localhost";
  const base = `http://${name.includes(":") ? `[${name}]` : name}:${options.port}`;
  console.log(`Home Screen Install demos (serving demo/ and dist/ from ${ROOT})`);
  console.log(`  Classic script: ${base}/demo/classic/`);
  console.log(`  ES module:      ${base}/demo/esm/`);
  console.log("Press Ctrl+C to stop.");

  const stop = () => {
    for (const server of servers) server.close();
    process.exit(0);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main(process.argv.slice(2));
}
