// Copyright 2026 The SafetyCatch Authors
// SPDX-License-Identifier: Apache-2.0
//
// Tiny local web server for the harmless test pages in test/pages/.
//   npm run serve            -> http://localhost:8377/
// It listens on 127.0.0.1 only and never contacts the internet. The smoke
// test starts it on a free port.

import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { basename, dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const PAGES = join(here, '..', 'test', 'pages');

const TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

/** Paths that stand in for real sign-in or platform pages when a host name is mapped to this server. */
const ROUTES: Readonly<Record<string, string>> = {
  '/': 'index.html',
  '/devicelogin': 'device-code.html',
  '/activate': 'device-code.html',
  '/start': 'device-code.html',
  '/help/fix-update': 'shared-page.html',
};

export interface PageServer {
  port: number;
  close(): Promise<void>;
}

export function startPages(port: number): Promise<PageServer> {
  const server = createServer((req, res) => {
    const path = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname);
    const headers: Record<string, string> = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
    if (path.startsWith('/download/')) {
      // Made-up files with risky-looking names. The content is always this one harmless line.
      const name = basename(path).replace(/[^A-Za-z0-9._ -]/g, '_');
      res.writeHead(200, { ...headers, 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename="${name}"` });
      res.end('// Harmless SafetyCatch test file. It does nothing.\n');
      return;
    }
    const file = ROUTES[path] ?? basename(path);
    const type = TYPES[extname(file)];
    if (!type) {
      res.writeHead(404, headers);
      res.end('Not found');
      return;
    }
    readFile(join(PAGES, file)).then(
      (body) => {
        res.writeHead(200, { ...headers, 'Content-Type': type });
        res.end(body);
      },
      () => {
        res.writeHead(404, headers);
        res.end('Not found');
      },
    );
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const address = server.address();
      resolve({
        port: typeof address === 'object' && address ? address.port : port,
        close: () =>
          new Promise((done) => {
            server.closeAllConnections();
            server.close(() => done());
          }),
      });
    });
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const wanted = Number(process.argv[2] ?? process.env['PORT'] ?? 8377);
  const server = await startPages(Number.isInteger(wanted) ? wanted : 8377);
  console.log(`SafetyCatch test pages: http://localhost:${server.port}/  (Ctrl+C to stop)`);
}
