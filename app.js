// app.js

// ---- Storage helpers ----
const STORAGE_KEY = 'putaway_app_v1';

function loadAppData() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) {
    return {
      tasks: [],
      lines: [],
      sequence: { lastDate: null, lastNumber: 0 } // for task_code
    };
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    console.error('Failed to parse app data, resetting', e);
    return {
      tasks: [],
      lines: [],
      sequence: { lastDate: null, lastNumber: 0 }
    };
  }
}

function saveAppData(data) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
}

// ---- Device / scanner identity ----
const DEVICE_KEY = 'putaway_device_id';

function getDeviceId() {
  let id = localStorage.getItem(DEVICE_KEY);
  if (!id) {
    id = 'dev-' + Math.random().toString(36).substring(2, 10);
    localStorage.setItem(DEVICE_KEY, id);
  }
  return id;
}

// ---- BIN master (from bins.csv) ----
let binsMap = {}; // bin_id -> capacity

async function loadBins() {
  const res = await fetch('bins.csv');
  if (!res.ok) throw new Error('Unable to load bins.csv');
  const text = await res.text();
  const lines = text.trim().split('\n');
  const header = lines[0].split(',');
  const binIdx = header.indexOf('bin_id');
  const capIdx = header.indexOf('capacity');
  if (binIdx === -1 || capIdx === -1) {
    throw new Error('bins.csv must have bin_id,capacity headers');
  }
  binsMap = {};
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',');
    const binId = cols[binIdx].trim();
    const cap = parseInt(cols[capIdx].trim(), 10) || 0;
    if (binId) {
      binsMap[binId] = cap;
    }
  }
}

// ---- Task helpers ----

function getOrCreateInProgressTask(appData, deviceId) {
  // Existing IN_PROGRESS for this device?
  let task = appData.tasks.find(
    t => t.status === 'IN_PROGRESS' && t.scannerDeviceId === deviceId
  );
  if (task) return task;

  const now = new Date().toISOString();
  task = {
    id: 'task-' + Math.random().toString(36).substring(2, 10),
    code: null,              // will be set when finished
    status: 'IN_PROGRESS',   // IN_PROGRESS | OPEN | CLOSED
    createdAt: now,
    createdBy: deviceId,
    closedAt: null,
    closedBy: null,
    scannerDeviceId: deviceId,
    lastActivityAt: now
  };
  appData.tasks.push(task);
  saveAppData(appData);
  return task;
}

function generateTaskCode(appData) {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  const todayStr = `${yyyy}${mm}${dd}`;
  if (appData.sequence.lastDate !== todayStr) {
    appData.sequence.lastDate = todayStr;
    appData.sequence.lastNumber = 0;
  }
  appData.sequence.lastNumber += 1;
  const seq = String(appData.sequence.lastNumber).padStart(4, '0');
  saveAppData(appData);
  return `PUT-${todayStr}-${seq}`;
}

function getLinesForTask(appData, taskId) {
  return appData.lines.filter(l => l.taskId === taskId);
}

function getBinUsedUnits(appData, binId) {
  return appData.lines
    .filter(l => l.binId === binId)
    .reduce((sum, l) => sum + (parseInt(l.qty, 10) || 0), 0);
}

// ---- CSV export helper ----

function downloadCsv(filename, rows) {
  const csvContent =
    rows
      .map(row =>
        row
          .map(v => {
            if (v == null) return '';
            const s = String(v);
            if (s.includes(',') || s.includes('"') || s.includes('\n')) {
              return '"' + s.replace(/"/g, '""') + '"';
            }
            return s;
          })
          .join(',')
      )
      .join('\n');

  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ---- Date helper for reports ----

function formatDateOnly(d) {
  const dt = new Date(d);
  const yyyy = dt.getFullYear();
  const mm = String(dt.getMonth() + 1).padStart(2, '0');
  const dd = String(dt.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}
