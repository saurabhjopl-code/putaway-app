// ===== CONFIG =====
const API_URL = 'https://script.google.com/macros/s/AKfycbwZPCt39-pqFmpgiMwauMOotYYD_F_PoWiNDQZ0mVCjYAWDKyKcoPQN3D39Lt_n6OGu/exec';

// ===== GLOBAL STATE =====
let appData = { success: true, tasks: [], lines: [] };
let binsMap = {}; // bin_id -> capacity
let skuMap = {};  // sku_id -> { name }

// ===== DEVICE ID (for scanner) =====
const DEVICE_KEY = 'putaway_device_id';
function getDeviceId() {
  let id = localStorage.getItem(DEVICE_KEY);
  if (!id) {
    id = 'dev-' + Math.random().toString(36).substring(2, 10);
    localStorage.setItem(DEVICE_KEY, id);
  }
  return id;
}

// ===== USER (PIN login) =====
const USER_KEY = 'putaway_current_user';

function setCurrentUser(user) {
  if (user) {
    localStorage.setItem(USER_KEY, JSON.stringify(user));
  } else {
    localStorage.removeItem(USER_KEY);
  }
}

function getCurrentUser() {
  const raw = localStorage.getItem(USER_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (e) {
    console.error('Failed to parse user', e);
    return null;
  }
}

// ===== BACKEND CALLS =====

async function loginUser(pin) {
  const payload = { action: 'login', pin };
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  if (!res.ok) throw new Error('Login request failed');
  const data = await res.json();
  return data;
}

async function fetchAppData() {
  const res = await fetch(API_URL + '?action=getAppData');
  if (!res.ok) throw new Error('Failed to load app data');
  const data = await res.json();

  // Support both shapes:
  // 1) {tasks, lines}
  // 2) {success, tasks, lines}
  if (data.tasks && data.lines) {
    appData = {
      success: data.success !== false, // default true
      tasks: data.tasks,
      lines: data.lines
    };
  } else {
    throw new Error('Unexpected backend response format');
  }
}


async function saveLineToBackend(deviceId, userId, binId, skuId, qty) {
  const payload = {
    action: 'saveLine',
    deviceId,
    userId,
    binId,
    skuId,
    qty
  };
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  if (!res.ok) throw new Error('Failed to save line');
  const data = await res.json();
  if (!data.success) throw new Error(data.error || 'Backend error');
  return data; // { success, taskId, lineId }
}

async function updateTaskStatusOnBackend(taskId, newStatus, closedBy) {
  const payload = {
    action: 'updateTaskStatus',
    taskId,
    newStatus,
    closedBy: closedBy || ''
  };
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  if (!res.ok) throw new Error('Failed to update task status');
  const data = await res.json();
  if (!data.success) throw new Error(data.error || 'Backend error');
  return data; // { success, code }
}

async function updateLineOnBackend(lineId, qty) {
  const payload = { action: 'updateLine', lineId, qty };
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  if (!res.ok) throw new Error('Failed to update line');
  const data = await res.json();
  if (!data.success) throw new Error(data.error || 'Backend error');
  return data;
}

async function deleteLineOnBackend(lineId) {
  const payload = { action: 'deleteLine', lineId };
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  if (!res.ok) throw new Error('Failed to delete line');
  const data = await res.json();
  if (!data.success) throw new Error(data.error || 'Backend error');
  return data;
}

// ===== BIN MASTER (bins.csv) =====

async function loadBins() {
  const res = await fetch('bins.csv');
  if (!res.ok) throw new Error('Unable to load bins.csv');
  const text = await res.text();

  const lines = text
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(l => l.length > 0);

  if (lines.length === 0) {
    throw new Error('bins.csv is empty');
  }

  const rawHeader = lines[0].split(/,|\t/).map(h =>
    h.replace(/^\uFEFF/, '').trim().toLowerCase()
  );

  const binIdx = rawHeader.indexOf('bin_id');
  const capIdx = rawHeader.indexOf('capacity');

  if (binIdx === -1 || capIdx === -1) {
    console.error('Header parsed as:', rawHeader);
    throw new Error('bins.csv must have bin_id,capacity headers');
  }

  binsMap = {};
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(/,|\t/).map(c => c.trim());
    if (!cols[binIdx]) continue;
    const binId = cols[binIdx];
    const cap = parseInt(cols[capIdx] || '0', 10) || 0;
    binsMap[binId] = cap;
  }
  console.log('Loaded bins:', binsMap);
}

// ===== SKU MASTER (sku_master.csv) =====

async function loadSkuMaster() {
  try {
    const res = await fetch('sku_master.csv');
    if (!res.ok) {
      console.warn('No sku_master.csv found (optional)');
      skuMap = {};
      return;
    }
    const text = await res.text();
    const lines = text
      .split(/\r?\n/)
      .map(l => l.trim())
      .filter(l => l.length > 0);

    if (lines.length === 0) {
      skuMap = {};
      return;
    }

    const rawHeader = lines[0].split(/,|\t/).map(h =>
      h.replace(/^\uFEFF/, '').trim().toLowerCase()
    );
    const skuIdx = rawHeader.indexOf('sku_id');
    const nameIdx = rawHeader.indexOf('sku_name');

    if (skuIdx === -1 || nameIdx === -1) {
      console.warn('sku_master.csv missing sku_id,sku_name headers');
      skuMap = {};
      return;
    }

    skuMap = {};
    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split(/,|\t/).map(c => c.trim());
      const skuId = cols[skuIdx];
      const skuName = cols[nameIdx] || '';
      if (skuId) {
        skuMap[skuId] = { name: skuName };
      }
    }
    console.log('Loaded SKUs:', skuMap);
  } catch (e) {
    console.warn('Error loading sku_master.csv', e);
    skuMap = {};
  }
}

// ===== APP DATA HELPERS =====

function getLinesForTask(taskId) {
  return appData.lines.filter(l => l.taskId === taskId);
}

function getBinUsedUnits(binId) {
  return appData.lines
    .filter(l => l.binId === binId)
    .reduce((sum, l) => sum + (parseInt(l.qty, 10) || 0), 0);
}

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

function formatDateOnly(d) {
  const dt = new Date(d);
  const yyyy = dt.getFullYear();
  const mm = String(dt.getMonth() + 1).padStart(2, '0');
  const dd = String(dt.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

