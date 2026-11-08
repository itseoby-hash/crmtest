import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { buildServer } from '../src/server.js';

let tmpDir;
let server;
let base;

before(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), 'time-tracker-api-'));
  const app = await buildServer({ dataFile: path.join(tmpDir, 'db.json') });
  server = app.server;
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await rm(tmpDir, { recursive: true, force: true });
});

const post = (url, body) =>
  fetch(base + url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

describe('API', () => {
  it('отдаёт интерфейс на главной', async () => {
    const response = await fetch(base + '/');
    const html = await response.text();
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /text\/html/);
    assert.match(html, /Учёт времени/);
  });

  it('добавляет сотрудника', async () => {
    const response = await post('/api/employees', { name: 'Тестовый сотрудник' });
    const data = await response.json();
    assert.equal(response.status, 201);
    assert.equal(data.employee.name, 'Тестовый сотрудник');
  });

  it('отклоняет сотрудника без имени', async () => {
    const response = await post('/api/employees', { name: '  ' });
    const data = await response.json();
    assert.equal(response.status, 400);
    assert.equal(data.code, 'NAME_REQUIRED');
  });

  it('ведёт таймер и запрещает повторный запуск', async () => {
    const created = await (await post('/api/employees', { name: 'Таймер' })).json();
    const employeeId = created.employee.id;

    const started = await post('/api/timer/start', { employeeId, description: 'Задача' });
    assert.equal(started.status, 201);

    const again = await post('/api/timer/start', { employeeId, description: 'Ещё задача' });
    const conflict = await again.json();
    assert.equal(again.status, 409);
    assert.equal(conflict.code, 'TIMER_ALREADY_RUNNING');
    assert.ok(conflict.details.entry.id);

    const stopped = await post('/api/timer/stop', { employeeId });
    const result = await stopped.json();
    assert.equal(stopped.status, 200);
    assert.ok(result.durationMs >= 0);
    assert.ok(result.entry.endedAt);

    const stopAgain = await post('/api/timer/stop', { employeeId });
    assert.equal(stopAgain.status, 409);
    assert.equal((await stopAgain.json()).code, 'TIMER_NOT_RUNNING');
  });

  it('возвращает пустой отчёт за период без записей', async () => {
    const response = await fetch(`${base}/api/report?from=2020-01-01&to=2020-01-02`);
    const report = await response.json();
    assert.equal(response.status, 200);
    assert.deepEqual(report.entries, []);
    assert.equal(report.totalMs, 0);
    assert.ok(Array.isArray(report.employees));
  });

  it('возвращает 400 за перевёрнутый период', async () => {
    const response = await fetch(`${base}/api/report?from=2026-11-09&to=2026-11-08`);
    assert.equal(response.status, 400);
    assert.equal((await response.json()).code, 'INVALID_RANGE');
  });

  it('отдаёт состояние с сотрудниками', async () => {
    const response = await fetch(`${base}/api/state`);
    const state = await response.json();
    assert.equal(response.status, 200);
    assert.ok(state.employees.length >= 2);
    assert.ok(Array.isArray(state.active));
  });

  it('возвращает 404 для неизвестного метода API и 400 для битого JSON', async () => {
    const missing = await fetch(`${base}/api/unknown`);
    assert.equal(missing.status, 404);

    const broken = await fetch(`${base}/api/employees`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{oops',
    });
    assert.equal(broken.status, 400);
    assert.equal((await broken.json()).code, 'INVALID_JSON');
  });
});
