// ================== CONFIG ==================
const API_URL = 'https://script.google.com/macros/s/AKfycbwZPCt39-pqFmpgiMwauMOotYYD_F_PoWiNDQZ0mVCjYAWDKyKcoPQN3D39Lt_n6OGu/exec';

// ================== GLOBAL STATE ==================
let appData = { tasks: [], lines: [] };  // loaded from backend
let binsMap = {}; // bin_id -> capacity
let skuMap = {};  // sku_id -> { name }

// ================== DEVICE ID (for scanner) ==================
const DEVICE_KEY = 'putaway_device_id';

function getDeviceId() {
  let id = localStorage.getItem(DEVICE_KEY);
  if (!id) {
    id = 'dev-' + Math.random().toString(36).substring(2, 10);
    localStorage.setItem(DEVICE_KEY, id);
  }
  return id;
}

// ================== BACKEND CALLS ==================

// GET tasks + lines
async function fetchAppData() {
  const res = await fetch(API_URL + '?action=getAppData');
  if (!res.ok) throw new Error('Failed to load app data');
  const data = await res.json();

  // Support response like {tasks,lines} OR {success,tasks,lines}
  if (data.tasks && data.lines) {
    appData = {
      tasks: data.tasks,
      lines: data.lines
    };
  } else {
    throw new Error('Unexpected backend response format');
  }
}

// POST: save line (create task if needed)
async function saveLineToBackend(deviceId, binId, skuId, qty) {
  const payload = {
    action: 'saveLine',
    deviceId,
    binId,
    skuId,
    qty
  };
  const res = await fetch(API_URL, {
    method: 'POST',
    // IMPORTANT: no Content-Type header (avoids CORS preflight issues)
    body: JSON.stringify(payload)
  });
  if (!res.ok) throw new Error('Failed to save line');
  const data = await res.json();
  if (data.success === false) throw new Error(data.error || 'Backend error');
  return data; // { success, taskId, lineId? }
}

// POST: update task status (OPEN / CLOSED)
async function updateTaskStatusOnBackend(taskId, newStatus) {
  const payload = {
    action: 'updateTaskStatus',
    taskId,
    newStatus
  };
  const res = await fetch(API_URL, {
    method: 'POST',
    body: JSON.stringify(payload)
  });
  if (!res.ok) throw new Error('Failed to update task status');
  const data = await res.json();
  if (data.success === false) throw new Error(data.error || 'Backend error');
  return data; // e.g. { success, code }
}

// POST: update line quantity
async function updateLineOnBackend(lineId, qty) {
  const payload = { action: 'updateLine', lineId, qty };
  const res = await fetch(API_URL, {
    method: 'POST',
    body: JSON.stringify(payload)
  });
  if (!res.ok) throw new Error('Failed to update line');
  const data = await res.json();
  if (data.success === false) throw new Error(data.error || 'Backend error');
  return data;
}

// POST: delete line
async function deleteLineOnBackend(lineId) {
  const payload = { action: 'deleteLine', lineId };
  const res = await fetch(API_URL, {
    method: 'POST',
    body: JSON.stringify(payload)
  });
  if (!res.ok) throw new Error('Failed to delete line');
  const data = await res.json();
  if (data.success === false) throw new Error(data.error || 'Backend error');
  return data;
}

// ================== BIN MASTER (bins.csv) ==================

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

// ================== SKU MASTER (sku_master.csv) ==================

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

// ================== COMMON HELPERS ==================

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

// ================== SCANNER PAGE LOGIC ==================

let scannerDeviceId;
let currentTaskId = null;
let currentBinId = null;
let html5QrCode = null;
let currentScanTarget = null; // 'bin' or 'sku'

// called from scanner.html <body> onload
async function initScanner() {
  const statusEl = document.getElementById('statusMessage');

  try {
    if (statusEl) statusEl.textContent = 'Loading bins & SKUs...';
    await loadBins();
    await loadSkuMaster();

    scannerDeviceId = getDeviceId();

    if (statusEl) statusEl.textContent = 'Loading data from backend...';
    await fetchAppData();

    // reuse existing IN_PROGRESS task for this device, if any
    const existing = appData.tasks.find(
      t => t.status === 'IN_PROGRESS' && t.scannerDeviceId === scannerDeviceId
    );
    currentTaskId = existing ? existing.id : null;

    refreshTaskSummary();
    setBinStatus('Scan Bin to start.', false);
    showStatus('Ready.', false);
  } catch (e) {
    console.error(e);
    if (statusEl) {
      statusEl.textContent = 'Error: ' + e.message;
      statusEl.classList.add('error');
    }
  }

  const binInput = document.getElementById('binInput');
  const skuInput = document.getElementById('skuInput');
  const qtyInput = document.getElementById('qtyInput');
  const saveLineBtn = document.getElementById('saveLineBtn');
  const binCompleteBtn = document.getElementById('binCompleteBtn');
  const finishTaskBtn = document.getElementById('finishTaskBtn');
  const scanBinBtn = document.getElementById('scanBinBtn');
  const scanSkuBtn = document.getElementById('scanSkuBtn');
  const resetBinBtn = document.getElementById('resetBinBtn');
  const setBinBtn = document.getElementById('setBinBtn');


  if (binInput) {
    binInput.focus();
    binInput.addEventListener('keydown', e => {
      if (e.key === 'Enter') onBinScanned();
    });
  }
  setBinBtn && setBinBtn.addEventListener('click', onBinScanned);
  saveLineBtn && saveLineBtn.addEventListener('click', onSaveLine);
  binCompleteBtn && binCompleteBtn.addEventListener('click', onBinComplete);
  finishTaskBtn && finishTaskBtn.addEventListener('click', onFinishTask);

  if (skuInput) {
    skuInput.addEventListener('input', () => {
      updateSkuHint(skuInput.value.trim());
    });
    skuInput.addEventListener('keydown', e => {
      if (e.key === 'Enter') qtyInput && qtyInput.focus();
    });
  }

  if (qtyInput) {
    qtyInput.addEventListener('keydown', e => {
      if (e.key === 'Enter') onSaveLine();
    });
  }

  scanBinBtn && scanBinBtn.addEventListener('click', () => startScanner('bin'));
  scanSkuBtn && scanSkuBtn.addEventListener('click', () => startScanner('sku'));
  resetBinBtn && resetBinBtn.addEventListener('click', resetBinSelection);

  // initial UI: only bin card active
  resetBinSelection(true); // true = don't override status text
}

function showStatus(msg, isError = false) {
  const statusEl = document.getElementById('statusMessage');
  if (!statusEl) return;
  statusEl.textContent = msg;
  statusEl.classList.remove('error', 'success');
  if (isError) statusEl.classList.add('error');
  else statusEl.classList.add('success');
}

function setBinStatus(msg, isError = false) {
  const el = document.getElementById('binStatus');
  if (!el) return;
  el.textContent = msg;
  el.classList.remove('error', 'success');
  if (isError) el.classList.add('error');
  else el.classList.add('success');
}

function updateSkuHint(skuId) {
  const el = document.getElementById('skuNameHint');
  if (!el) return;
  if (!skuId) {
    el.innerHTML = '<small>SKU: -</small>';
    return;
  }
  const info = skuMap[skuId];
  if (info) {
    el.innerHTML = `<small>SKU: ${skuId} – ${info.name}</small>`;
  } else {
    el.innerHTML = `<small>SKU: ${skuId} (not in SKU master)</small>`;
  }
}

function refreshTaskSummary() {
  const codeEl = document.getElementById('taskCodeLabel');
  const lineCountEl = document.getElementById('taskLineCount');
  const unitCountEl = document.getElementById('taskUnitCount');
  if (!codeEl) return;

  if (!currentTaskId) {
    codeEl.textContent = '[Not generated yet]';
    lineCountEl.textContent = '0';
    unitCountEl.textContent = '0';
    return;
  }
  const task = appData.tasks.find(t => t.id === currentTaskId);
  const lines = getLinesForTask(currentTaskId);
  const totalUnits = lines.reduce((sum, l) => sum + (parseInt(l.qty, 10) || 0), 0);

  codeEl.textContent = task && task.code ? task.code : '[Not generated yet]';
  lineCountEl.textContent = lines.length;
  unitCountEl.textContent = totalUnits;
}

function refreshBinUsage() {
  const capEl = document.getElementById('binCapacity');
  const usedEl = document.getElementById('binUsed');
  const freeEl = document.getElementById('binFree');
  if (!capEl) return;

  if (!currentBinId) {
    capEl.textContent = '0';
    usedEl.textContent = '0';
    freeEl.textContent = '0';
    return;
  }

  const capacity = binsMap[currentBinId] || 0;
  const used = getBinUsedUnits(currentBinId);
  const free = capacity - used;

  capEl.textContent = capacity;
  usedEl.textContent = used;
  freeEl.textContent = free >= 0 ? free : 0;
}

function refreshBinLinesTable() {
  const tbody = document.querySelector('#binLinesTable tbody');
  if (!tbody) return;
  tbody.innerHTML = '';

  if (!currentTaskId || !currentBinId) return;

  const lines = appData.lines.filter(
    l => l.taskId === currentTaskId && l.binId === currentBinId
  );

  lines.forEach((line, index) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${index + 1}</td>
      <td>${line.skuId}</td>
      <td>${line.qty}</td>
      <td>${String(line.scannedAt).replace('T', ' ').substring(0, 16)}</td>
      <td>
        <button class="secondary editLineBtn" data-line-id="${line.id}">Edit</button>
        <button class="secondary deleteLineBtn" data-line-id="${line.id}">Delete</button>
      </td>
    `;
    tbody.appendChild(tr);
  });

  tbody.querySelectorAll('.editLineBtn').forEach(btn => {
    btn.addEventListener('click', () => editLinePrompt(btn.getAttribute('data-line-id')));
  });
  tbody.querySelectorAll('.deleteLineBtn').forEach(btn => {
    btn.addEventListener('click', () => deleteLinePrompt(btn.getAttribute('data-line-id')));
  });
}

function resetBinSelection(keepStatus = false) {
  const binInput = document.getElementById('binInput');
  const resetBinBtn = document.getElementById('resetBinBtn');
  const scanStoreCard = document.getElementById('scanStoreCard');
  const reviewCard = document.getElementById('reviewCard');
  const tbody = document.querySelector('#binLinesTable tbody');

  currentBinId = null;

  if (binInput) {
    binInput.value = '';
    binInput.readOnly = false;
  }
  if (resetBinBtn) {
    resetBinBtn.style.display = 'none';
  }
  if (scanStoreCard) {
    scanStoreCard.style.display = 'none';
  }
  if (reviewCard) {
    reviewCard.style.display = 'none';
  }
  if (tbody) {
    tbody.innerHTML = '';
  }

  refreshBinUsage();
  if (!keepStatus) {
    setBinStatus('Scan Bin to start.', false);
  }
}

async function onBinScanned() {
  const binInput = document.getElementById('binInput');
  const scanStoreCard = document.getElementById('scanStoreCard');
  const reviewCard = document.getElementById('reviewCard');
  const resetBinBtn = document.getElementById('resetBinBtn');

  const binId = binInput.value.trim();

  if (!binId) {
    setBinStatus('Bin ID is required.', true);
    return;
  }
  if (!binsMap[binId]) {
    setBinStatus('Invalid Bin ID: ' + binId, true);
    return;
  }

  try {
    await fetchAppData();
  } catch (e) {
    console.error(e);
    setBinStatus('Warning: data not refreshed (' + e.message + ')', true);
  }

  currentBinId = binId;
  setBinStatus('Current Bin: ' + currentBinId, false);
  refreshBinUsage();
  refreshBinLinesTable();

  // lock bin & show other sections
  if (binInput) binInput.readOnly = true;
  if (resetBinBtn) resetBinBtn.style.display = 'inline-flex';
  if (scanStoreCard) scanStoreCard.style.display = 'block';
  if (reviewCard) reviewCard.style.display = 'block';

  const skuInput = document.getElementById('skuInput');
  skuInput && skuInput.focus();
}

async function onSaveLine() {
  if (!currentBinId) {
    setBinStatus('Scan a bin first.', true);
    const binInput = document.getElementById('binInput');
    binInput && binInput.focus();
    return;
  }

  const skuInput = document.getElementById('skuInput');
  const qtyInput = document.getElementById('qtyInput');
  const binId = currentBinId;
  const skuId = skuInput.value.trim();
  const qtyVal = parseInt(qtyInput.value, 10);

  if (!skuId) {
    showStatus('SKU ID is required.', true);
    skuInput.focus();
    return;
  }
  if (!qtyVal || qtyVal <= 0) {
    showStatus('Quantity must be greater than 0.', true);
    qtyInput.focus();
    return;
  }

  try {
    await fetchAppData();
    const capacity = binsMap[binId] || 0;
    const used = getBinUsedUnits(binId);
    if (used + qtyVal > capacity) {
      const free = capacity - used;
      showStatus(
        `Bin ${binId} capacity exceeded. Used=${used}, capacity=${capacity}, free=${free >= 0 ? free : 0}.`,
        true
      );
      return;
    }

    const resp = await saveLineToBackend(scannerDeviceId, binId, skuId, qtyVal);
    currentTaskId = resp.taskId;

    await fetchAppData();
    refreshTaskSummary();
    refreshBinUsage();
    refreshBinLinesTable();

    showStatus(`Saved: Bin ${binId}, SKU ${skuId}, Qty ${qtyVal}`, false);

    skuInput.value = '';
    qtyInput.value = '';
    updateSkuHint('');
    skuInput.focus();
  } catch (e) {
    console.error(e);
    showStatus('Error: ' + e.message, true);
  }
}

async function onBinComplete() {
  if (!currentBinId) {
    setBinStatus('No active bin to complete.', true);
    return;
  }
  const finishedBin = currentBinId;
  resetBinSelection(true); // keep status, override text below
  setBinStatus(`Bin ${finishedBin} completed. Scan next bin.`, false);
}

async function onFinishTask() {
  if (!currentTaskId) {
    showStatus('No active task to finish.', true);
    return;
  }
  try {
    await fetchAppData();
    const lines = getLinesForTask(currentTaskId);
    if (lines.length === 0) {
      showStatus('Cannot finish an empty task. Add at least one line.', true);
      return;
    }

    const resp = await updateTaskStatusOnBackend(currentTaskId, 'OPEN');
    const taskCode = resp.code || '[code generated]';
    showStatus('Task submitted. Task ID: ' + taskCode, false);

    currentTaskId = null;
    currentBinId = null;
    const binInput = document.getElementById('binInput');
    if (binInput) {
      binInput.value = '';
      binInput.readOnly = false;
    }
    refreshBinUsage();
    const tbody = document.querySelector('#binLinesTable tbody');
    if (tbody) tbody.innerHTML = '';
    await fetchAppData();
    refreshTaskSummary();
    resetBinSelection(false);
  } catch (e) {
    console.error(e);
    showStatus('Error: ' + e.message, true);
  }
}

async function editLinePrompt(lineId) {
  const line = appData.lines.find(l => l.id === lineId);
  if (!line) {
    alert('Line not found.');
    return;
  }
  const newQtyStr = prompt(
    `Edit quantity for SKU ${line.skuId} (current: ${line.qty})`,
    String(line.qty)
  );
  if (newQtyStr === null) return;
  const newQty = parseInt(newQtyStr, 10);
  if (!newQty || newQty <= 0) {
    alert('Invalid quantity.');
    return;
  }

  try {
    await fetchAppData();
    const capacity = binsMap[line.binId] || 0;
    const usedWithoutThis = appData.lines
      .filter(l => l.binId === line.binId && l.id !== lineId)
      .reduce((sum, l) => sum + (parseInt(l.qty, 10) || 0), 0);
    if (usedWithoutThis + newQty > capacity) {
      const free = capacity - usedWithoutThis;
      alert(
        `Bin ${line.binId} capacity exceeded with this change. Used=${usedWithoutThis}, capacity=${capacity}, free=${free >= 0 ? free : 0}.`
      );
      return;
    }

    await updateLineOnBackend(lineId, newQty);
    await fetchAppData();
    refreshTaskSummary();
    refreshBinUsage();
    refreshBinLinesTable();
  } catch (e) {
    console.error(e);
    alert('Error: ' + e.message);
  }
}

async function deleteLinePrompt(lineId) {
  if (!confirm('Delete this line?')) return;
  try {
    await deleteLineOnBackend(lineId);
    await fetchAppData();
    refreshTaskSummary();
    refreshBinUsage();
    refreshBinLinesTable();
  } catch (e) {
    console.error(e);
    alert('Error: ' + e.message);
  }
}

// ===== CAMERA SCANNING (Scanner page) =====

function startScanner(target) {
  currentScanTarget = target;
  const qrDivId = "qrReader";

  if (!html5QrCode) {
    html5QrCode = new Html5Qrcode(qrDivId);
  }

  Html5Qrcode.getCameras().then(devices => {
    if (!devices || devices.length === 0) {
      showStatus("No camera found", true);
      return;
    }
    const cameraId = devices[0].id;
    html5QrCode
      .start(
        cameraId,
        { fps: 10, qrbox: 250 },
        decodedText => {
          if (currentScanTarget === 'bin') {
            const binInput = document.getElementById('binInput');
            binInput.value = decodedText.trim();
            onBinScanned();
          } else if (currentScanTarget === 'sku') {
            const skuInput = document.getElementById('skuInput');
            skuInput.value = decodedText.trim();
            updateSkuHint(decodedText.trim());
            const qtyInput = document.getElementById('qtyInput');
            qtyInput && qtyInput.focus();
          }
          stopScanner();
        },
        errorMessage => {
          // ignore per-frame errors
        }
      )
      .catch(err => {
        console.error(err);
        showStatus("Error starting camera: " + err, true);
      });
  }).catch(err => {
    console.error(err);
    showStatus("Unable to access camera: " + err, true);
  });
}

function stopScanner() {
  if (html5QrCode) {
    html5QrCode.stop().catch(err => console.error('Stop error', err));
  }
  currentScanTarget = null;
}

// ================== ENTRY / SUPERVISOR PAGE LOGIC ==================

let selectedTaskId = null;

// called from entry.html onload
async function initEntry() {
  try {
    await loadSkuMaster();
    await fetchAppData();

    const todayStr = formatDateOnly(new Date());
    const reportDateInput = document.getElementById('reportDate');
    if (reportDateInput) reportDateInput.value = todayStr;

    refreshOpenTaskListToday();
    refreshPendingOldOpenTasks();
    attachEntryHandlers();
    if (reportDateInput) await runReport();
  } catch (e) {
    console.error(e);
    const el = document.getElementById('taskListStatus');
    if (el) {
      el.textContent = 'Error loading data: ' + e.message;
      el.classList.add('error');
    }
  }
}

function attachEntryHandlers() {
  const runReportBtn = document.getElementById('runReportBtn');
  const exportReportBtn = document.getElementById('exportReportBtn');
  const exportTaskBtn = document.getElementById('exportTaskBtn');
  const closeTaskBtn = document.getElementById('closeTaskBtn');
  const skuSearchInput = document.getElementById('skuSearchInput');

  runReportBtn && runReportBtn.addEventListener('click', runReport);
  exportReportBtn && exportReportBtn.addEventListener('click', exportReportCsv);
  exportTaskBtn && exportTaskBtn.addEventListener('click', exportSelectedTask);
  closeTaskBtn && closeTaskBtn.addEventListener('click', closeSelectedTask);

  if (skuSearchInput) {
    const resultEl = document.getElementById('skuSearchResult');
    skuSearchInput.addEventListener('input', () => {
      const val = skuSearchInput.value.trim();
      if (!val) {
        resultEl.textContent = '';
        resultEl.classList.remove('error');
        return;
      }
      const info = skuMap[val];
      if (info) {
        resultEl.textContent = `${val} – ${info.name}`;
        resultEl.classList.remove('error');
      } else {
        resultEl.textContent = `${val} not found in SKU master`;
        resultEl.classList.add('error');
      }
    });
  }
}

function refreshOpenTaskListToday() {
  const tbody = document.querySelector('#taskTable tbody');
  if (!tbody) return;
  tbody.innerHTML = '';

  const today = formatDateOnly(new Date());
  const openTasksToday = appData.tasks.filter(t =>
    t.status === 'OPEN' &&
    t.createdAt &&
    formatDateOnly(t.createdAt) === today
  );

  const statusEl = document.getElementById('taskListStatus');

  if (statusEl) {
    if (openTasksToday.length === 0) {
      statusEl.textContent = 'No open tasks for today.';
      statusEl.classList.remove('error');
    } else {
      statusEl.textContent = `Open tasks today: ${openTasksToday.length}`;
      statusEl.classList.remove('error');
    }
  }

  openTasksToday.forEach(task => {
    const lines = getLinesForTask(task.id);
    const totalUnits = lines.reduce((sum, l) => sum + (parseInt(l.qty, 10) || 0), 0);

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${task.code || '-'}</td>
      <td>${task.createdAt ? String(task.createdAt).replace('T', ' ').substring(0, 16) : ''}</td>
      <td>${lines.length}</td>
      <td>${totalUnits}</td>
      <td><button data-task-id="${task.id}" class="viewTaskBtn secondary">View</button></td>
    `;
    tbody.appendChild(tr);
  });

  tbody.querySelectorAll('.viewTaskBtn').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-task-id');
      showTaskDetails(id);
    });
  });

  if (selectedTaskId) {
    const stillOpen = openTasksToday.find(t => t.id === selectedTaskId);
    if (!stillOpen) hideTaskDetails();
  }
}

function refreshPendingOldOpenTasks() {
  const tbody = document.querySelector('#pendingOldTable tbody');
  if (!tbody) return;
  tbody.innerHTML = '';

  const today = formatDateOnly(new Date());
  const pendingOld = appData.tasks.filter(t =>
    t.status === 'OPEN' &&
    t.createdAt &&
    formatDateOnly(t.createdAt) < today
  );

  const statusEl = document.getElementById('pendingOldStatus');
  if (statusEl) {
    if (pendingOld.length === 0) {
      statusEl.textContent = 'No pending open tasks from previous days.';
      statusEl.classList.remove('error');
    } else {
      statusEl.textContent = `Pending open tasks from previous days: ${pendingOld.length}`;
      statusEl.classList.remove('error');
    }
  }

  pendingOld.forEach(task => {
    const lines = getLinesForTask(task.id);
    const totalUnits = lines.reduce((sum, l) => sum + (parseInt(l.qty, 10) || 0), 0);

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${task.code || '-'}</td>
      <td>${task.createdAt ? String(task.createdAt).replace('T', ' ').substring(0, 16) : ''}</td>
      <td>${lines.length}</td>
      <td>${totalUnits}</td>
    `;
    tbody.appendChild(tr);
  });
}

function showTaskDetails(taskId) {
  selectedTaskId = taskId;
  const card = document.getElementById('taskDetailsCard');
  const codeEl = document.getElementById('detailsTaskCode');
  const tbody = document.querySelector('#taskLinesTable tbody');
  if (!card || !tbody) return;

  const task = appData.tasks.find(t => t.id === taskId);
  if (!task || task.status !== 'OPEN') {
    alert('Task is not open or not found.');
    hideTaskDetails();
    refreshOpenTaskListToday();
    return;
  }

  const lines = getLinesForTask(task.id);

  card.style.display = 'block';
  codeEl.textContent = task.code || '-';

  tbody.innerHTML = '';
  lines.forEach(line => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${line.binId}</td>
      <td>${line.skuId}</td>
      <td>${line.qty}</td>
      <td>${String(line.scannedAt).replace('T', ' ').substring(0, 16)}</td>
    `;
    tbody.appendChild(tr);
  });
}

function hideTaskDetails() {
  selectedTaskId = null;
  const card = document.getElementById('taskDetailsCard');
  if (card) card.style.display = 'none';
}

function exportSelectedTask() {
  if (!selectedTaskId) {
    alert('No task selected.');
    return;
  }
  const task = appData.tasks.find(t => t.id === selectedTaskId);
  if (!task) {
    alert('Task not found.');
    return;
  }
  const lines = getLinesForTask(task.id);

  const rows = [];
  rows.push(['task_code', 'bin_id', 'sku_id', 'qty', 'scanned_at']);
  lines.forEach(l => {
    rows.push([task.code, l.binId, l.skuId, l.qty, l.scannedAt]);
  });

  const filename = (task.code || 'task') + '.csv';
  downloadCsv(filename, rows);
}

async function closeSelectedTask() {
  if (!selectedTaskId) {
    alert('No task selected.');
    return;
  }
  if (!confirm('Mark this task as CLOSED? You will not see it again.')) {
    return;
  }
  const task = appData.tasks.find(t => t.id === selectedTaskId);
  if (!task) {
    alert('Task not found.');
    return;
  }
  if (task.status !== 'OPEN') {
    alert('Task is not OPEN.');
    return;
  }

  try {
    await updateTaskStatusOnBackend(task.id, 'CLOSED');
    await fetchAppData();
    hideTaskDetails();
    refreshOpenTaskListToday();
    refreshPendingOldOpenTasks();
    await runReport();
  } catch (e) {
    console.error(e);
    alert('Error: ' + e.message);
  }
}

async function runReport() {
  const dateInput = document.getElementById('reportDate');
  if (!dateInput) return;
  const dateStr = dateInput.value;
  const statusEl = document.getElementById('reportStatus');
  const bySkuBody = document.querySelector('#reportBySkuTable tbody');
  const totalEl = document.getElementById('reportTotalUnits');

  if (bySkuBody) bySkuBody.innerHTML = '';
  if (totalEl) totalEl.textContent = '0';

  if (!dateStr) {
    if (statusEl) {
      statusEl.textContent = 'Select a date.';
      statusEl.classList.add('error');
    }
    return;
  }

  await fetchAppData();

  const closedTasks = appData.tasks.filter(
    t =>
      t.status === 'CLOSED' &&
      t.closedAt &&
      formatDateOnly(t.closedAt) === dateStr
  );

  if (closedTasks.length === 0) {
    if (statusEl) {
      statusEl.textContent = 'No CLOSED tasks for this date.';
      statusEl.classList.remove('error');
    }
    if (totalEl) totalEl.textContent = '0';
    return;
  }

  const closedTaskIds = new Set(closedTasks.map(t => t.id));
  const relevantLines = appData.lines.filter(l =>
    closedTaskIds.has(l.taskId)
  );

  const totalUnits = relevantLines.reduce(
    (sum, l) => sum + (parseInt(l.qty, 10) || 0),
    0
  );
  if (totalEl) totalEl.textContent = totalUnits;

  const bySku = {};
  relevantLines.forEach(l => {
    const qty = parseInt(l.qty, 10) || 0;
    if (!bySku[l.skuId]) bySku[l.skuId] = 0;
    bySku[l.skuId] += qty;
  });

  if (bySkuBody) {
    Object.entries(bySku).forEach(([sku, units]) => {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td>${sku}</td><td>${units}</td>`;
      bySkuBody.appendChild(tr);
    });
  }

  if (statusEl) {
    statusEl.textContent = `Closed tasks: ${closedTasks.length}. Total units: ${totalUnits}`;
    statusEl.classList.remove('error');
  }
}

async function exportReportCsv() {
  const dateInput = document.getElementById('reportDate');
  if (!dateInput) return;
  const dateStr = dateInput.value;
  if (!dateStr) {
    alert('Select a date first.');
    return;
  }

  await fetchAppData();

  const closedTasks = appData.tasks.filter(
    t =>
      t.status === 'CLOSED' &&
      t.closedAt &&
      formatDateOnly(t.closedAt) === dateStr
  );
  if (closedTasks.length === 0) {
    alert('No CLOSED tasks for this date.');
    return;
  }

  const closedTaskIds = new Set(closedTasks.map(t => t.id));
  const relevantLines = appData.lines.filter(l =>
    closedTaskIds.has(l.taskId)
  );

  const rows = [];
  rows.push(['task_code', 'bin_id', 'sku_id', 'qty', 'scanned_at', 'closed_at']);
  relevantLines.forEach(l => {
    const task = appData.tasks.find(t => t.id === l.taskId);
    rows.push([
      task ? task.code : '',
      l.binId,
      l.skuId,
      l.qty,
      l.scannedAt,
      task ? task.closedAt : ''
    ]);
  });

  const filename = `daily_stock_${dateStr}.csv`;
  downloadCsv(filename, rows);
}

