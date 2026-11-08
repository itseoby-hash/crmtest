import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const LIMITS = {
  name: 80,
  description: 300,
};

export class AppError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function parseDay(value, field) {
  if (!DATE_RE.test(value ?? '')) {
    throw new AppError(400, 'INVALID_DATE', `Поле ${field} должно быть в формате YYYY-MM-DD`);
  }
  const date = new Date(`${value}T00:00:00`);
  if (Number.isNaN(date.getTime())) {
    throw new AppError(400, 'INVALID_DATE', `Поле ${field} содержит некорректную дату`);
  }
  return date;
}

function cleanText(value) {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
}

export class Store {
  constructor(filePath) {
    this.filePath = filePath;
    this.data = { employees: [], entries: [] };
    this.writeChain = Promise.resolve();
  }

  /** Читает состояние с диска. Если файла нет — создаёт пустое хранилище. */
  async init() {
    try {
      const raw = await readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw);
      this.data = {
        employees: Array.isArray(parsed.employees) ? parsed.employees : [],
        entries: Array.isArray(parsed.entries) ? parsed.entries : [],
      };
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw new Error(`Не удалось прочитать ${this.filePath}: ${error.message}`);
      }
      await this.flush();
    }
    return this;
  }

  /** Запись на диск атомарная: сначала временный файл, затем rename. */
  flush() {
    this.writeChain = this.writeChain.then(async () => {
      await mkdir(path.dirname(this.filePath), { recursive: true });
      const tmp = `${this.filePath}.tmp`;
      await writeFile(tmp, JSON.stringify(this.data, null, 2), 'utf8');
      await rename(tmp, this.filePath);
    });
    return this.writeChain;
  }

  listEmployees() {
    return [...this.data.employees];
  }

  async addEmployee(name) {
    const clean = cleanText(name);
    if (!clean) {
      throw new AppError(400, 'NAME_REQUIRED', 'Укажите имя сотрудника');
    }
    if (clean.length > LIMITS.name) {
      throw new AppError(400, 'NAME_TOO_LONG', `Имя длиннее ${LIMITS.name} символов`);
    }
    const employee = {
      id: randomUUID(),
      name: clean,
      createdAt: new Date().toISOString(),
    };
    this.data.employees.push(employee);
    await this.flush();
    return employee;
  }

  findEmployee(employeeId) {
    return this.data.employees.find((employee) => employee.id === employeeId) ?? null;
  }

  activeEntry(employeeId) {
    return (
      this.data.entries.find((entry) => entry.employeeId === employeeId && !entry.endedAt) ??
      null
    );
  }

  listActive() {
    return this.data.entries.filter((entry) => !entry.endedAt);
  }

  async startTimer(employeeId, description, now = new Date()) {
    const employee = this.findEmployee(employeeId);
    if (!employee) {
      throw new AppError(404, 'EMPLOYEE_NOT_FOUND', 'Сотрудник не найден');
    }
    const clean = cleanText(description);
    if (!clean) {
      throw new AppError(400, 'DESCRIPTION_REQUIRED', 'Опишите задачу, над которой работаете');
    }
    if (clean.length > LIMITS.description) {
      throw new AppError(400, 'DESCRIPTION_TOO_LONG', `Описание длиннее ${LIMITS.description} символов`);
    }
    const running = this.activeEntry(employeeId);
    if (running) {
      throw new AppError(409, 'TIMER_ALREADY_RUNNING', `У сотрудника ${employee.name} уже идёт таймер`, {
        entry: running,
      });
    }
    const entry = {
      id: randomUUID(),
      employeeId,
      description: clean,
      startedAt: now.toISOString(),
      endedAt: null,
    };
    this.data.entries.push(entry);
    await this.flush();
    return entry;
  }

  async stopTimer(employeeId, now = new Date()) {
    const running = this.activeEntry(employeeId);
    if (!running) {
      throw new AppError(409, 'TIMER_NOT_RUNNING', 'Таймер не запущен');
    }
    running.endedAt = now.toISOString();
    await this.flush();
    return running;
  }

  /**
   * Отчёт за период включительно. Учитываются только завершённые записи,
   * начатые внутри периода. Сотрудники без записей возвращаются с нулём.
   */
  report({ from, to } = {}) {
    const fromDate = parseDay(from, 'from');
    const toDate = parseDay(to, 'to');
    const fromTs = fromDate.getTime();
    const toTs = toDate.getTime() + 24 * 60 * 60 * 1000 - 1;
    if (fromTs > toTs) {
      throw new AppError(400, 'INVALID_RANGE', 'Дата начала позже даты окончания');
    }

    const entries = this.data.entries
      .filter((entry) => {
        if (!entry.endedAt) return false;
        const startedTs = new Date(entry.startedAt).getTime();
        return startedTs >= fromTs && startedTs <= toTs;
      })
      .map((entry) => ({
        ...entry,
        durationMs: Math.max(0, new Date(entry.endedAt).getTime() - new Date(entry.startedAt).getTime()),
      }))
      .sort((a, b) => new Date(a.startedAt) - new Date(b.startedAt));

    const byEmployee = new Map(
      this.data.employees.map((employee) => [
        employee.id,
        { id: employee.id, name: employee.name, totalMs: 0, entryCount: 0 },
      ]),
    );
    for (const entry of entries) {
      const row = byEmployee.get(entry.employeeId);
      if (!row) continue;
      row.totalMs += entry.durationMs;
      row.entryCount += 1;
    }

    const employees = [...byEmployee.values()].sort(
      (a, b) => b.totalMs - a.totalMs || a.name.localeCompare(b.name, 'ru'),
    );
    const totalMs = employees.reduce((sum, row) => sum + row.totalMs, 0);

    return { from, to, employees, entries, totalMs };
  }

  /** Состояние для интерфейса: сотрудники + активные таймеры. */
  snapshot() {
    return {
      employees: this.listEmployees(),
      active: this.listActive().map((entry) => ({ ...entry })),
      serverTime: new Date().toISOString(),
    };
  }
}
