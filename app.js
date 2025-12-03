// ================== CONFIG ==================
const API_URL = 'https://script.google.com/macros/s/AKfycbwZPCt39-pqFmpgiMwauMOotYYD_F_PoWiNDQZ0mVCjYAWDKyKcoPQN3D39Lt_n6OGu/exec';

// ================== GLOBAL STATE ==================
let appData = { tasks: [], lines: [] };  // loaded from backend
let binsMap = {}; // bin_id -> capacity
let skuMap = {};  // sku_id (UPPER) -> { name }

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

  if (data.tasks && data.lines) {
    appData = {
      tasks: data.tasks,
      lines: data.lines
    };
  } else {
    throw new Error('Unexpected backend response format');
  }
}

// POST: create task + all lines (called once at Finish Task)
async function createTaskWithLinesOnBackend(deviceId, createdAt, lines) {
  const payload = {
    action: 'createTaskWithLines',
    deviceId,
    createdAt,
    lines
  };
  const res = await fetch(API_URL, {
    method: 'POST',
    // no Content-Type header to avoid CORS preflight
    body: JSON.stringify(payload)
  });
  if (!res.ok) throw new Error('Failed to create task');
  const data = await res.json();
  if (data.success === false) throw new Error(data.error || 'Backend error');
  return data; // { success, taskId, code }
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
  return data;
}

// (Supervisor-only helpers; not used on scanner page, but kept for future)
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
        skuMap[skuId.toUpperCase()] = { name: skuName };
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

function getBinUsedUnitsRemote(binId) {
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

function diffInDays(a, b) {
  const one = new Date(a);
  const two = new Date(b);
  const ms = Math.abs(two - one);
  return Math.floor(ms / (1000 * 60 * 60 * 24));
}

// ================== SCANNER PAGE LOGIC ==================

let scannerDeviceId;
let currentBinId = null;
let html5QrCode = null;
let currentScanTarget = null; // 'bin' or 'sku'

// local-only draft task (fast scanning)
let localTaskId = null;
let localTaskCreatedAt = null;
let localLines = []; // [{id, binId, skuId, qty, remarks, scannedAt}]

function newLocalTask() {
  localTaskId = 'LOCAL-' + Date.now().toString(36);
  localTaskCreatedAt = new Date().toISOString();
  localLines = [];
}

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

    newLocalTask();
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
  const remarksInput = document.getElementById('remarksInput');
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
      const val = skuInput.value.trim().toUpperCase();
      updateSkuHint(val);
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
  resetBinBtn && resetBinBtn.addEventListener('click', () => resetBinSelection(false));

  // initial UI: only bin card active
  resetBinSelection(true);
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

function updateSkuHint(skuIdUpper) {
  const el = document.getElementById('skuNameHint');
  if (!el) return;
  if (!skuIdUpper) {
    el.innerHTML = '<small>SKU: -</small>';
    return;
  }
  const info = skuMap[skuIdUpper];
  if (info) {
    el.innerHTML = `<small>SKU: ${skuIdUpper} – ${info.name}</small>`;
  } else {
    el.innerHTML = `<small>SKU: ${skuIdUpper} (not in SKU master)</small>`;
  }
}

function refreshTaskSummary() {
  const lineCountEl = document.getElementById('taskLineCount');
  const unitCountEl = document.getElementById('taskUnitCount');
  if (!lineCountEl || !unitCountEl) return;

  const totalLines = localLines.length;
  const totalUnits = localLines.reduce((sum, l) => sum + (parseInt(l.qty, 10) || 0), 0);

  lineCountEl.textContent = totalLines;
  unitCountEl.textContent = totalUnits;
}

function getBinUsedUnitsLocal(binId) {
  return localLines
    .filter(l => l.binId === binId)
    .reduce((sum, l) => sum + (parseInt(l.qty, 10) || 0), 0);
}

function getBinUsedUnitsTotal(binId) {
  return getBinUsedUnitsRemote(binId) + getBinUsedUnitsLocal(binId);
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
  const used = getBinUsedUnitsTotal(currentBinId);
  const free = capacity - used;

  capEl.textContent = capacity;
  usedEl.textContent = used;
  freeEl.textContent = free >= 0 ? free : 0;
}

function refreshBinLinesTable() {
  const tbody = document.querySelector('#binLinesTable tbody');
  if (!tbody) return;
  tbody.innerHTML = '';

  if (!currentBinId) return;

  const lines = localLines.filter(l => l.binId === currentBinId);

  lines.forEach((line, index) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${index + 1}</td>
      <td>${line.skuId}</td>
      <td>${line.qty}</td>
      <td>${line.remarks || ''}</td>
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
  const skuInput = document.getElementById('skuInput');
  const qtyInput = document.getElementById('qtyInput');
  const remarksInput = document.getElementById('remarksInput');

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
  if (skuInput) skuInput.value = '';
  if (qtyInput) qtyInput.value = '';
  if (remarksInput) remarksInput.value = '';
  updateSkuHint('');

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
    await fetchAppData(); // to get latest remote usage for capacity
  } catch (e) {
    console.error(e);
    setBinStatus('Warning: data not refreshed (' + e.message + ')', true);
  }

  currentBinId = binId;
  setBinStatus('Current Bin: ' + currentBinId, false);
  refreshBinUsage();
  refreshBinLinesTable();

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
  const remarksInput = document.getElementById('remarksInput');

  const binId = currentBinId;
  const rawSku = (skuInput.value || '').trim();
  const skuId = rawSku.toUpperCase();
  const qtyVal = parseInt(qtyInput.value, 10);
  const remarks = (remarksInput.value || '').trim();

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
    await fetchAppData(); // refresh remote usage

    const capacity = binsMap[binId] || 0;
    const usedTotal = getBinUsedUnitsTotal(binId);

    if (usedTotal + qtyVal > capacity) {
      const free = capacity - usedTotal;
      showStatus(
        `Bin ${binId} capacity exceeded. Used=${usedTotal}, capacity=${capacity}, free=${free >= 0 ? free : 0}.`,
        true
      );
      return;
    }

    const nowIso = new Date().toISOString();
    const line = {
      id: 'LLOCAL-' + Date.now().toString(36) + '-' + Math.random().toString(36).substring(2, 6),
      binId,
      skuId,
      qty: qtyVal,
      remarks,
      scannedAt: nowIso
    };
    localLines.push(line);

    refreshTaskSummary();
    refreshBinUsage();
    refreshBinLinesTable();

    showStatus(`Saved locally: Bin ${binId}, SKU ${skuId}, Qty ${qtyVal}`, false);

    skuInput.value = '';
    qtyInput.value = '';
    remarksInput.value = '';
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
  resetBinSelection(true);
  setBinStatus(`Bin ${finishedBin} completed. Scan next bin.`, false);
}

async function onFinishTask() {
  if (!localLines.length) {
    showStatus('No lines scanned. Add at least one line before finishing.', true);
    return;
  }

  try {
    const createdAt = localTaskCreatedAt || new Date().toISOString();
    const payloadLines = localLines.map(l => ({
      binId: l.binId,
      skuId: l.skuId,
      qty: l.qty,
      remarks: l.remarks,
      scannedAt: l.scannedAt
    }));

    const resp = await createTaskWithLinesOnBackend(scannerDeviceId, createdAt, payloadLines);
    const taskCode = resp.code || '[code generated]';

    showStatus('Task submitted. Task Code: ' + taskCode, false);

    // reset local draft
    newLocalTask();
    refreshTaskSummary();
    resetBinSelection(false);

    // refresh backend snapshot for future capacity checks
    await fetchAppData();
  } catch (e) {
    console.error(e);
    showStatus('Error: ' + e.message, true);
  }
}

function editLinePrompt(lineId) {
  const line = localLines.find(l => l.id === lineId);
  if (!line) {
    alert('Line not found.');
    return;
  }

  const newSkuStr = prompt('Edit SKU ID', line.skuId) || '';
  const newSku = newSkuStr.trim().toUpperCase();
  if (!newSku) {
    alert('SKU ID cannot be empty.');
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

  const newRemarks = prompt('Edit remarks (optional)', line.remarks || '') || '';

  try {
    const binId = line.binId;
    const capacity = binsMap[binId] || 0;
    const remoteUsed = getBinUsedUnitsRemote(binId);
    const localUsedWithoutThis = localLines
      .filter(l => l.binId === binId && l.id !== lineId)
      .reduce((sum, l) => sum + (parseInt(l.qty, 10) || 0), 0);

    const totalIfUpdated = remoteUsed + localUsedWithoutThis + newQty;
    if (totalIfUpdated > capacity) {
      const free = capacity - remoteUsed - localUsedWithoutThis;
      alert(
        `Bin ${binId} capacity exceeded with this change. Used=${remoteUsed + localUsedWithoutThis}, capacity=${capacity}, free=${free >= 0 ? free : 0}.`
      );
      return;
    }

    line.skuId = newSku;
    line.qty = newQty;
    line.remarks = newRemarks.trim();

    refreshTaskSummary();
    refreshBinUsage();
    refreshBinLinesTable();
  } catch (e) {
    console.error(e);
    alert('Error: ' + e.message);
  }
}

function deleteLinePrompt(lineId) {
  if (!confirm('Delete this line?')) return;
  const before = localLines.length;
  localLines = localLines.filter(l => l.id !== lineId);
  if (localLines.length === before) {
    alert('Line not found.');
    return;
  }
  refreshTaskSummary();
  refreshBinUsage();
  refreshBinLinesTable();
}

// ===== CAMERA SCANNING (Scanner page) =====

function startScanner(target) {
  currentScanTarget = target;
  const qrDivId = "qrReader";

  if (!html5QrCode) {
    html5QrCode = new Html5Qrcode(qrDivId);
  }

  const config = { fps: 10, qrbox: 250 };

  const onScanSuccess = decodedText => {
    const text = decodedText.trim();

    if (currentScanTarget === 'bin') {
      const binInput = document.getElementById('binInput');
      if (binInput) {
        binInput.value = text;
        onBinScanned();
      }
    } else if (currentScanTarget === 'sku') {
      const skuInput = document.getElementById('skuInput');
      if (skuInput) {
        const upper = text.toUpperCase();
        skuInput.value = upper;
        updateSkuHint(upper);
        const qtyInput = document.getElementById('qtyInput');
        qtyInput && qtyInput.focus();
      }
    }

    stopScanner();
  };

  const onScanError = errorMessage => {
    // ignore per-frame errors
  };

  // Try environment/back camera first
  html5QrCode.start(
    { facingMode: "environment" },
    config,
    onScanSuccess,
    onScanError
  ).catch(err => {
    console.warn("Environment camera failed, falling back to device list:", err);

    Html5Qrcode.getCameras()
      .then(devices => {
        if (!devices || devices.length === 0) {
          showStatus("No camera found", true);
          return;
        }

        let preferred = devices.find(d =>
          /back|rear|environment/i.test(d.label || "")
        );

        const cameraToUse = preferred || devices[0];

        html5QrCode.start(
          cameraToUse.id,
          config,
          onScanSuccess,
          onScanError
        ).catch(err2 => {
          console.error(err2);
          showStatus("Unable to start camera: " + err2, true);
        });
      })
      .catch(err2 => {
        console.error(err2);
        showStatus("Unable to access camera: " + err2, true);
      });
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
    refreshAllOpenTasks();
    refreshPendingOldOpenTasks();
    refreshRecentClosedTasks();
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
  const bulkExportBtn = document.getElementById('bulkExportBtn');
  const bulkCloseBtn = document.getElementById('bulkCloseBtn');
  const selectAllOpen = document.getElementById('selectAllOpen');

  runReportBtn && runReportBtn.addEventListener('click', runReport);
  exportReportBtn && exportReportBtn.addEventListener('click', exportReportCsv);
  exportTaskBtn && exportTaskBtn.addEventListener('click', exportSelectedTask);
  closeTaskBtn && closeTaskBtn.addEventListener('click', closeSelectedTask);
  bulkExportBtn && bulkExportBtn.addEventListener('click', bulkExportSelectedTasks);
  bulkCloseBtn && bulkCloseBtn.addEventListener('click', bulkCloseSelectedTasks);

  if (selectAllOpen) {
    selectAllOpen.addEventListener('change', () => {
      const checkboxes = document.querySelectorAll('.taskSelectCheckbox');
      checkboxes.forEach(cb => {
        cb.checked = selectAllOpen.checked;
      });
    });
  }

  if (skuSearchInput) {
    const resultEl = document.getElementById('skuSearchResult');
    skuSearchInput.addEventListener('input', () => {
      const val = skuSearchInput.value.trim().toUpperCase();
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

function refreshAllOpenTasks() {
  const tbody = document.querySelector('#allOpenTable tbody');
  if (!tbody) return;
  tbody.innerHTML = '';

  const statusEl = document.getElementById('allOpenStatus');
  const openTasks = appData.tasks.filter(t => t.status === 'OPEN');

  if (statusEl) {
    if (openTasks.length === 0) {
      statusEl.textContent = 'No open tasks.';
      statusEl.classList.remove('error');
    } else {
      statusEl.textContent = `Total open tasks: ${openTasks.length}`;
      statusEl.classList.remove('error');
    }
  }

  const todayStr = formatDateOnly(new Date());

  openTasks.forEach(task => {
    const lines = getLinesForTask(task.id);
    const totalUnits = lines.reduce((sum, l) => sum + (parseInt(l.qty, 10) || 0), 0);
    const ageDays = task.createdAt ? diffInDays(task.createdAt, todayStr) : '';

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><input type="checkbox" class="taskSelectCheckbox" data-task-id="${task.id}"></td>
      <td>${task.code || '-'}</td>
      <td>${task.createdAt ? String(task.createdAt).replace('T', ' ').substring(0, 16) : ''}</td>
      <td>${ageDays}</td>
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

function refreshRecentClosedTasks() {
  const tbody = document.querySelector('#recentClosedTable tbody');
  if (!tbody) return;
  tbody.innerHTML = '';

  const statusEl = document.getElementById('recentClosedStatus');

  const closedTasks = appData.tasks
    .filter(t => t.status === 'CLOSED' && t.closedAt)
    .sort((a, b) => new Date(b.closedAt) - new Date(a.closedAt))
    .slice(0, 10);

  if (statusEl) {
    if (closedTasks.length === 0) {
      statusEl.textContent = 'No recently closed tasks.';
      statusEl.classList.remove('error');
    } else {
      statusEl.textContent = `Showing last ${closedTasks.length} closed tasks.`;
      statusEl.classList.remove('error');
    }
  }

  closedTasks.forEach(task => {
    const lines = getLinesForTask(task.id);
    const totalUnits = lines.reduce((sum, l) => sum + (parseInt(l.qty, 10) || 0), 0);

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${task.code || '-'}</td>
      <td>${task.createdAt ? String(task.createdAt).replace('T', ' ').substring(0, 16) : ''}</td>
      <td>${task.closedAt ? String(task.closedAt).replace('T', ' ').substring(0, 16) : ''}</td>
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
    refreshAllOpenTasks();
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
      <td>${line.remarks || ''}</td>
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
  rows.push(['task_code', 'bin_id', 'sku_id', 'qty', 'remarks', 'scanned_at']);
  lines.forEach(l => {
    rows.push([task.code, l.binId, l.skuId, l.qty, l.remarks || '', l.scannedAt]);
  });

  const filename = (task.code || 'task') + '.csv';
  downloadCsv(filename, rows);
}

async function closeSelectedTask() {
  if (!selectedTaskId) {
    alert('No task selected.');
    return;
  }
  if (!confirm('Mark this task as CLOSED? You will not see it again in open lists.')) {
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
    refreshAllOpenTasks();
    refreshPendingOldOpenTasks();
    refreshRecentClosedTasks();
    await runReport();
  } catch (e) {
    console.error(e);
    alert('Error: ' + e.message);
  }
}

function getSelectedOpenTaskIds() {
  const cbs = document.querySelectorAll('.taskSelectCheckbox');
  const ids = [];
  cbs.forEach(cb => {
    if (cb.checked) {
      ids.push(cb.getAttribute('data-task-id'));
    }
  });
  return ids;
}

function bulkExportSelectedTasks() {
  const ids = getSelectedOpenTaskIds();
  if (!ids.length) {
    alert('No tasks selected.');
    return;
  }

  const rows = [];
  rows.push(['task_code', 'task_created_at', 'bin_id', 'sku_id', 'qty', 'remarks', 'scanned_at']);

  ids.forEach(id => {
    const task = appData.tasks.find(t => t.id === id);
    if (!task) return;
    const lines = getLinesForTask(id);
    lines.forEach(l => {
      rows.push([
        task.code || '',
        task.createdAt || '',
        l.binId,
        l.skuId,
        l.qty,
        l.remarks || '',
        l.scannedAt
      ]);
    });
  });

  const filename = `putaway_selected_tasks_${formatDateOnly(new Date())}.csv`;
  downloadCsv(filename, rows);
}

async function bulkCloseSelectedTasks() {
  const ids = getSelectedOpenTaskIds();
  if (!ids.length) {
    alert('No tasks selected.');
    return;
  }
  if (!confirm(`Close ${ids.length} tasks? They will move from OPEN to CLOSED.`)) {
    return;
  }

  let successCount = 0;
  let failCount = 0;
  for (const id of ids) {
    try {
      await updateTaskStatusOnBackend(id, 'CLOSED');
      successCount++;
    } catch (e) {
      console.error('Failed to close task', id, e);
      failCount++;
    }
  }

  await fetchAppData();
  refreshOpenTaskListToday();
  refreshAllOpenTasks();
  refreshPendingOldOpenTasks();
  refreshRecentClosedTasks();
  await runReport();

  alert(`Bulk close completed. Success: ${successCount}, Failed: ${failCount}`);
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
  rows.push(['task_code', 'bin_id', 'sku_id', 'qty', 'remarks', 'scanned_at', 'closed_at']);
  relevantLines.forEach(l => {
    const task = appData.tasks.find(t => t.id === l.taskId);
    rows.push([
      task ? task.code : '',
      l.binId,
      l.skuId,
      l.qty,
      l.remarks || '',
      l.scannedAt,
      task ? task.closedAt : ''
    ]);
  });

  const filename = `daily_stock_${dateStr}.csv`;
  downloadCsv(filename, rows);
}
