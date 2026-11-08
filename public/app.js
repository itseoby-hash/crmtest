const state = {
  employees: [],
  active: new Map(),
  reportShown: false,
};

const els = {
  today: document.getElementById('today'),
  employeeForm: document.getElementById('employee-form'),
  employeeName: document.getElementById('employee-name'),
  employees: document.getElementById('employees'),
  employeesEmpty: document.getElementById('employees-empty'),
  reportForm: document.getElementById('report-form'),
  from: document.getElementById('from'),
  to: document.getElementById('to'),
  reportRange: document.getElementById('report-range'),
  reportTable: document.getElementById('report-table'),
  reportBody: document.getElementById('report-body'),
  reportTotal: document.getElementById('report-total'),
  reportEmpty: document.getElementById('report-empty'),
  entries: document.getElementById('entries'),
  toast: document.getElementById('toast'),
};

const pad = (value) => String(value).padStart(2, '0');

function isoDate(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function formatClock(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
}

function formatHuman(ms) {
  const total = Math.max(0, ms);
  if (total === 0) return '0 мин';
  if (total < 60000) return `${Math.round(total / 1000)} с`;
  const minutes = Math.round(total / 60000);
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours && rest) return `${hours} ч ${rest} мин`;
  if (hours) return `${hours} ч`;
  return `${rest} мин`;
}

function formatTime(iso) {
  return new Date(iso).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
}

function formatDate(iso) {
  return new Date(iso).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
}

function showToast(message) {
  els.toast.textContent = message;
  els.toast.hidden = false;
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => {
    els.toast.hidden = true;
  }, 3200);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
    ...options,
  });
  let data = null;
  try {
    data = await response.json();
  } catch {
    data = null;
  }
  if (!response.ok) {
    const error = new Error(data?.error || `Ошибка ${response.status}`);
    error.code = data?.code;
    throw error;
  }
  return data;
}

function renderEmployees() {
  els.employees.replaceChildren();
  els.employeesEmpty.hidden = state.employees.length > 0;

  for (const employee of state.employees) {
    const running = state.active.get(employee.id);
    const item = document.createElement('li');
    item.className = running ? 'emp running' : 'emp';
    item.dataset.employeeId = employee.id;

    const head = document.createElement('div');
    head.className = 'emp-head';
    const name = document.createElement('span');
    name.className = 'emp-name';
    name.textContent = employee.name;
    head.append(name);

    if (running) {
      const time = document.createElement('span');
      time.className = 'emp-time';
      time.dataset.start = running.startedAt;
      time.textContent = formatClock(Date.now() - new Date(running.startedAt).getTime());
      head.append(time);
      item.append(head);

      const task = document.createElement('div');
      task.className = 'emp-task';
      task.textContent = running.description;
      item.append(task);

      const stop = document.createElement('button');
      stop.type = 'button';
      stop.className = 'stop';
      stop.textContent = 'Остановить';
      stop.addEventListener('click', async () => {
        stop.disabled = true;
        try {
          const result = await api('/api/timer/stop', {
            method: 'POST',
            body: JSON.stringify({ employeeId: employee.id }),
          });
          showToast(`Записано: ${formatHuman(result.durationMs)}`);
          await refresh({ reloadReport: true });
        } catch (error) {
          showToast(error.message);
          stop.disabled = false;
        }
      });
      item.append(stop);
    } else {
      item.append(head);

      const form = document.createElement('form');
      form.className = 'row';
      const input = document.createElement('input');
      input.type = 'text';
      input.placeholder = 'Что делаете?';
      input.maxLength = 300;
      input.required = true;
      input.setAttribute('aria-label', `Описание задачи для ${employee.name}`);
      const start = document.createElement('button');
      start.type = 'submit';
      start.textContent = 'Старт';
      form.append(input, start);
      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        start.disabled = true;
        try {
          await api('/api/timer/start', {
            method: 'POST',
            body: JSON.stringify({ employeeId: employee.id, description: input.value }),
          });
          await refresh({ reloadReport: false });
        } catch (error) {
          showToast(error.message);
          start.disabled = false;
        }
      });
      item.append(form);
    }

    els.employees.append(item);
  }
}

function tick() {
  const now = Date.now();
  for (const node of document.querySelectorAll('.emp-time[data-start]')) {
    node.textContent = formatClock(now - new Date(node.dataset.start).getTime());
  }
}

async function refresh({ reloadReport = false } = {}) {
  const data = await api('/api/state');
  state.employees = data.employees;
  state.active = new Map(data.active.map((entry) => [entry.employeeId, entry]));
  renderEmployees();
  if (reloadReport || state.reportShown) {
    await loadReport();
  }
}

async function loadReport() {
  const from = els.from.value;
  const to = els.to.value;
  if (!from || !to) return;

  try {
    const report = await api(`/api/report?from=${from}&to=${to}`);
    state.reportShown = true;

    els.reportRange.textContent = `Период: ${formatDate(`${from}T00:00:00`)} — ${formatDate(`${to}T00:00:00`)}`;
    els.reportBody.replaceChildren();
    for (const row of report.employees) {
      const tr = document.createElement('tr');
      const name = document.createElement('td');
      name.textContent = row.name;
      if (state.active.has(row.id)) {
        const running = document.createElement('span');
        running.className = 'muted';
        running.textContent = ' · таймер идёт';
        name.append(running);
      }
      const count = document.createElement('td');
      count.className = 'num';
      count.textContent = String(row.entryCount);
      const time = document.createElement('td');
      time.className = 'num';
      time.textContent = formatHuman(row.totalMs);
      tr.append(name, count, time);
      els.reportBody.append(tr);
    }

    els.reportTotal.textContent = formatHuman(report.totalMs);
    els.reportTable.hidden = report.entries.length === 0;
    els.reportEmpty.hidden = report.entries.length > 0;

    els.entries.replaceChildren();
    for (const entry of report.entries) {
      const employee = state.employees.find((item) => item.id === entry.employeeId);
      const li = document.createElement('li');
      const description = document.createElement('span');
      description.textContent = entry.description;
      const meta = document.createElement('span');
      meta.className = 'meta';
      meta.textContent = `${employee?.name ?? 'Сотрудник'} · ${formatDate(entry.startedAt)}, ${formatTime(entry.startedAt)}–${formatTime(entry.endedAt)} · ${formatHuman(entry.durationMs)}`;
      li.append(description, meta);
      els.entries.append(li);
    }
  } catch (error) {
    showToast(error.message);
  }
}

els.employeeForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const name = els.employeeName.value.trim();
  if (!name) return;
  const button = els.employeeForm.querySelector('button');
  button.disabled = true;
  try {
    await api('/api/employees', { method: 'POST', body: JSON.stringify({ name }) });
    els.employeeName.value = '';
    await refresh();
  } catch (error) {
    showToast(error.message);
  } finally {
    button.disabled = false;
  }
});

els.reportForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  await loadReport();
});

const today = new Date();
els.from.value = isoDate(today);
els.to.value = isoDate(today);
els.today.textContent = today.toLocaleDateString('ru-RU', {
  day: 'numeric',
  month: 'long',
  year: 'numeric',
});

refresh({ reloadReport: true }).catch((error) => showToast(error.message));
setInterval(tick, 1000);
