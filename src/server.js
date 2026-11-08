import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { AppError, Store } from './store.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(here, '..', 'public');
const projectRoot = path.join(here, '..');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
};

const MAX_BODY = 100_000;

function todayIso(date = new Date()) {
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 10);
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function sendError(res, error) {
  if (error instanceof AppError) {
    sendJson(res, error.status, { error: error.message, code: error.code, details: error.details });
    return;
  }
  console.error(error);
  sendJson(res, 500, { error: 'Внутренняя ошибка сервера', code: 'INTERNAL_ERROR' });
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > MAX_BODY) {
        reject(new AppError(413, 'PAYLOAD_TOO_LARGE', 'Слишком большой запрос'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!raw.trim()) return resolve({});
      try {
        const parsed = JSON.parse(raw);
        resolve(parsed && typeof parsed === 'object' ? parsed : {});
      } catch {
        reject(new AppError(400, 'INVALID_JSON', 'Тело запроса не является корректным JSON'));
      }
    });
    req.on('error', reject);
  });
}

async function serveStatic(pathname, res) {
  const relative = pathname === '/' ? 'index.html' : decodeURIComponent(pathname.slice(1));
  const filePath = path.join(publicDir, relative);
  if (filePath !== publicDir && !filePath.startsWith(publicDir + path.sep)) {
    return false;
  }
  try {
    const body = await readFile(filePath);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath)] ?? 'application/octet-stream',
      'Content-Length': body.length,
      'Cache-Control': 'no-cache',
    });
    res.end(body);
    return true;
  } catch {
    return false;
  }
}

export async function buildServer({ dataFile }) {
  const store = await new Store(dataFile).init();

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const { pathname } = url;

    try {
      if (pathname === '/api/state' && req.method === 'GET') {
        sendJson(res, 200, store.snapshot());
        return;
      }

      if (pathname === '/api/employees' && req.method === 'GET') {
        sendJson(res, 200, { employees: store.listEmployees() });
        return;
      }

      if (pathname === '/api/employees' && req.method === 'POST') {
        const body = await readJson(req);
        const employee = await store.addEmployee(body.name);
        sendJson(res, 201, { employee });
        return;
      }

      if (pathname === '/api/timer/start' && req.method === 'POST') {
        const body = await readJson(req);
        const entry = await store.startTimer(body.employeeId, body.description);
        sendJson(res, 201, { entry });
        return;
      }

      if (pathname === '/api/timer/stop' && req.method === 'POST') {
        const body = await readJson(req);
        const entry = await store.stopTimer(body.employeeId);
        sendJson(res, 200, {
          entry,
          durationMs: new Date(entry.endedAt).getTime() - new Date(entry.startedAt).getTime(),
        });
        return;
      }

      if (pathname === '/api/report' && req.method === 'GET') {
        const today = todayIso();
        const report = store.report({
          from: url.searchParams.get('from') || today,
          to: url.searchParams.get('to') || today,
        });
        sendJson(res, 200, report);
        return;
      }

      if (pathname.startsWith('/api/')) {
        throw new AppError(404, 'NOT_FOUND', 'Такого метода API нет');
      }

      if (req.method === 'GET' || req.method === 'HEAD') {
        const served = await serveStatic(pathname, res);
        if (served) return;
      }

      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Не найдено');
    } catch (error) {
      sendError(res, error);
    }
  });

  return { server, store };
}

const isEntryPoint =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isEntryPoint) {
  const dataFile = process.env.DATA_FILE || path.join(projectRoot, 'data', 'db.json');
  const port = Number(process.env.PORT || 3000);
  const { server } = await buildServer({ dataFile });
  server.listen(port, () => {
    console.log(`Учёт рабочего времени: http://localhost:${port}`);
    console.log(`Данные: ${dataFile}`);
  });
}
