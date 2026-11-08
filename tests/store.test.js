import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { AppError, Store } from '../src/store.js';

let tmpDir;
let store;

const at = (iso) => new Date(iso);

before(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), 'time-tracker-'));
});

after(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

// Каждый тест работает со своим файлом, иначе записи перетекают между сценариями.
async function freshStore(name = `${randomUUID()}.json`) {
  store = new Store(path.join(tmpDir, name));
  await store.init();
  return store;
}

describe('сотрудники', () => {
  it('добавляет сотрудника и обрезает пробелы', async () => {
    await freshStore();
    const employee = await store.addEmployee('  Анна   Петрова ');
    assert.equal(employee.name, 'Анна Петрова');
    assert.ok(employee.id);
    assert.equal(store.listEmployees().length, 1);
  });

  it('не принимает пустое имя', async () => {
    await freshStore();
    await assert.rejects(() => store.addEmployee('   '), (error) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.status, 400);
      assert.equal(error.code, 'NAME_REQUIRED');
      return true;
    });
  });
});

describe('таймер', () => {
  it('запускается и останавливается, сохраняя длительность', async () => {
    await freshStore();
    const employee = await store.addEmployee('Иван');

    const entry = await store.startTimer(employee.id, 'Разбор заявок', at('2026-11-08T09:00:00'));
    assert.equal(entry.endedAt, null);
    assert.equal(store.activeEntry(employee.id)?.id, entry.id);

    const stopped = await store.stopTimer(employee.id, at('2026-11-08T10:30:00'));
    assert.ok(stopped.endedAt);
    assert.equal(store.activeEntry(employee.id), null);
    assert.equal(new Date(stopped.endedAt) - new Date(stopped.startedAt), 90 * 60 * 1000);
  });

  it('не даёт запустить второй таймер тому же сотруднику', async () => {
    await freshStore();
    const employee = await store.addEmployee('Мария');
    await store.startTimer(employee.id, 'Первая задача');

    await assert.rejects(
      () => store.startTimer(employee.id, 'Вторая задача'),
      (error) => {
        assert.equal(error.status, 409);
        assert.equal(error.code, 'TIMER_ALREADY_RUNNING');
        return true;
      },
    );

    assert.equal(store.data.entries.length, 1);
  });

  it('не даёт остановить незапущенный таймер', async () => {
    await freshStore();
    const employee = await store.addEmployee('Пётр');
    await assert.rejects(
      () => store.stopTimer(employee.id),
      (error) => error.code === 'TIMER_NOT_RUNNING',
    );
  });

  it('требует описание задачи', async () => {
    await freshStore();
    const employee = await store.addEmployee('Ольга');
    await assert.rejects(
      () => store.startTimer(employee.id, '  '),
      (error) => error.code === 'DESCRIPTION_REQUIRED',
    );
  });

  it('не запускает таймер для несуществующего сотрудника', async () => {
    await freshStore();
    await assert.rejects(
      () => store.startTimer('nope', 'Задача'),
      (error) => error.code === 'EMPLOYEE_NOT_FOUND',
    );
  });
});

describe('отчёт', () => {
  it('суммирует время по сотрудникам внутри периода включительно', async () => {
    await freshStore();
    const anna = await store.addEmployee('Анна');
    const ivan = await store.addEmployee('Иван');

    await store.startTimer(anna.id, 'A1', at('2026-11-08T09:00:00'));
    await store.stopTimer(anna.id, at('2026-11-08T10:00:00'));
    await store.startTimer(anna.id, 'A2', at('2026-11-08T23:30:00'));
    await store.stopTimer(anna.id, at('2026-11-08T23:59:59'));
    await store.startTimer(ivan.id, 'I1', at('2026-11-08T12:00:00'));
    await store.stopTimer(ivan.id, at('2026-11-08T12:15:00'));
    // Эта запись вне периода — не должна попасть в отчёт за 8 ноября.
    await store.startTimer(ivan.id, 'I2', at('2026-11-09T00:00:00'));
    await store.stopTimer(ivan.id, at('2026-11-09T01:00:00'));

    const report = store.report({ from: '2026-11-08', to: '2026-11-08' });
    assert.equal(report.entries.length, 3);
    const byName = Object.fromEntries(report.employees.map((row) => [row.name, row]));
    assert.equal(byName['Анна'].totalMs, 60 * 60 * 1000 + 29 * 60 * 1000 + 59 * 1000);
    assert.equal(byName['Иван'].totalMs, 15 * 60 * 1000);
    assert.equal(report.totalMs, byName['Анна'].totalMs + byName['Иван'].totalMs);
  });

  it('не включает незавершённые записи в суммы', async () => {
    await freshStore();
    const employee = await store.addEmployee('Анна');
    await store.startTimer(employee.id, 'В работе', at('2026-11-08T09:00:00'));

    const report = store.report({ from: '2026-11-08', to: '2026-11-08' });
    assert.equal(report.entries.length, 0);
    assert.equal(report.totalMs, 0);
    assert.equal(report.employees[0].totalMs, 0);
  });

  it('возвращает пустой отчёт, если записей нет', async () => {
    await freshStore();
    await store.addEmployee('Анна');
    const report = store.report({ from: '2026-01-01', to: '2026-01-31' });

    assert.deepEqual(report.entries, []);
    assert.equal(report.totalMs, 0);
    assert.equal(report.employees.length, 1);
    assert.equal(report.employees[0].totalMs, 0);
    assert.equal(report.employees[0].entryCount, 0);
  });

  it('отклоняет некорректные даты и перевёрнутый период', async () => {
    await freshStore();
    assert.throws(() => store.report({ from: '08.11.2026', to: '2026-11-08' }), (error) => {
      assert.equal(error.code, 'INVALID_DATE');
      return true;
    });
    assert.throws(() => store.report({ from: '2026-11-09', to: '2026-11-08' }), (error) => {
      assert.equal(error.code, 'INVALID_RANGE');
      return true;
    });
  });
});

describe('сохранение на диск', () => {
  it('читает данные после перезапуска', async () => {
    const file = path.join(tmpDir, 'persist.json');
    const first = new Store(file);
    await first.init();
    const employee = await first.addEmployee('Сотрудник');
    await first.startTimer(employee.id, 'Задача', at('2026-11-08T09:00:00'));
    await first.stopTimer(employee.id, at('2026-11-08T09:20:00'));

    const second = new Store(file);
    await second.init();

    assert.equal(second.listEmployees().length, 1);
    assert.equal(second.listEmployees()[0].name, 'Сотрудник');
    assert.equal(second.data.entries.length, 1);

    const report = second.report({ from: '2026-11-08', to: '2026-11-08' });
    assert.equal(report.totalMs, 20 * 60 * 1000);
  });
});
