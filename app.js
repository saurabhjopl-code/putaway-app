// ===================== GLOBAL STATE =====================

// Backend Apps Script deployment URL:
const BACKEND_URL = "https://script.google.com/macros/s/AKfycbwZPCt39-pqFmpgiMwauMOotYYD_F_PoWiNDQZ0mVCjYAWDKyKcoPQN3D39Lt_n6OGu/exec";

// Local state for Scanner app
let currentBinId = "";
let currentBinCapacity = 0;
let currentBinUsedRemote = 0;
let currentBinUsedLocal = 0;

let localLines = [];   // {id, binId, skuId, qty, remarks, scannedAt}
let localTaskStartTime = "";
let scannerDeviceId = "";
let html5QrCode = null;
let currentScanTarget = null;

// Data loaded from backend
let backendTasks = [];
let backendLines = [];

// Cached sku/sheet data if needed later
let skuMaster = {}; // reserved for SKU master integration

// ===================== DEVICE ID GENERATION =====================

function getDeviceId() {
  const key = "PUTAWAY_DEVICE_ID";
  let id = localStorage.getItem(key);
  if (!id) {
    id = "D" + Date.now() + "-" + Math.floor(Math.random() * 999999);
    localStorage.setItem(key, id);
  }
  return id;
}

// ===================== INIT LOADERS =====================

function initScanner() {
  scannerDeviceId = getDeviceId();
  loadBackendData().then(() => {
    updateTaskSummaryDisplay();
  });

  const binInput = document.getElementById("binInput");
  const setBinBtn = document.getElementById("setBinBtn");
  const scanBinBtn = document.getElementById("scanBinBtn");
  const resetBinBtn = document.getElementById("resetBinBtn");
  const scanSkuBtn = document.getElementById("scanSkuBtn");
  const saveLineBtn = document.getElementById("saveLineBtn");
  const binCompleteBtn = document.getElementById("binCompleteBtn");
  const finishTaskBtn = document.getElementById("finishTaskBtn");
  const finishTaskHeaderBtn = document.getElementById("finishTaskHeaderBtn");
  const qtyInput = document.getElementById("qtyInput");
  const skuInput = document.getElementById("skuInput");
  const closeCameraBtn = document.getElementById("closeCameraBtn");

  binInput && binInput.addEventListener("keydown", e => {
    if (e.key === "Enter") onBinScanned();
  });

  setBinBtn && setBinBtn.addEventListener("click", onBinScanned);
  scanBinBtn && scanBinBtn.addEventListener("click", () => startScanner("bin"));
  scanSkuBtn && scanSkuBtn.addEventListener("click", () => startScanner("sku"));
  resetBinBtn && resetBinBtn.addEventListener("click", resetBin);

  saveLineBtn && saveLineBtn.addEventListener("click", onSaveLine);
  binCompleteBtn && binCompleteBtn.addEventListener("click", onBinComplete);

  finishTaskBtn && finishTaskBtn.addEventListener("click", onFinishTask);
  finishTaskHeaderBtn && finishTaskHeaderBtn.addEventListener("click", onFinishTask);

  closeCameraBtn && closeCameraBtn.addEventListener("click", stopScanner);

  qtyInput && qtyInput.addEventListener("keydown", e => {
    if (e.key === "Enter") onSaveLine();
  });

  skuInput && skuInput.addEventListener("keyup", e => {
    updateSkuHint(e.target.value);
  });
}

function initEntry() {
  loadBackendData().then(() => {
    buildSupervisorTables();
  });

  const closedSearchBtn = document.getElementById("closedSearchBtn");
  const closedExportBtn = document.getElementById("closedExportBtn");
  const runReportBtn = document.getElementById("runReportBtn");
  const exportReportBtn = document.getElementById("exportReportBtn");
  const exportTodayAllBtn = document.getElementById("exportTodayAllBtn");
  const closeTodayAllBtn = document.getElementById("closeTodayAllBtn");
  const selectTodayAll = document.getElementById("selectTodayAll");

  const bulkExportBtn = document.getElementById("bulkExportBtn");
  const bulkCloseBtn = document.getElementById("bulkCloseBtn");
  const selectAllOpen = document.getElementById("selectAllOpen");
  const exportPendingAllBtn = document.getElementById("exportPendingAllBtn");
  const closePendingAllBtn = document.getElementById("closePendingAllBtn");

  closedSearchBtn && closedSearchBtn.addEventListener("click", onClosedSearch);
  closedExportBtn && closedExportBtn.addEventListener("click", exportClosedRangeCSV);
  runReportBtn && runReportBtn.addEventListener("click", runDailyReport);
  exportReportBtn && exportReportBtn.addEventListener("click", exportDailyReportCSV);

  exportTodayAllBtn && exportTodayAllBtn.addEventListener("click", onExportTodaySelected);
  closeTodayAllBtn && closeTodayAllBtn.addEventListener("click", onCloseTodaySelected);
  selectTodayAll && selectTodayAll.addEventListener("change", toggleSelectTodayAll);

  bulkExportBtn && bulkExportBtn.addEventListener("click", onExportSelectedOpen);
  bulkCloseBtn && bulkCloseBtn.addEventListener("click", onCloseSelectedOpen);
  selectAllOpen && selectAllOpen.addEventListener("change", toggleSelectAllOpen);

  exportPendingAllBtn && exportPendingAllBtn.addEventListener("click", onExportPendingAll);
  closePendingAllBtn && closePendingAllBtn.addEventListener("click", onClosePendingAll);
}

// ===================== BACKEND LOADER =====================

async function loadBackendData() {
  try {
    const res = await fetch(`${BACKEND_URL}?action=getAppData`);
    const data = await res.json();
    backendTasks = data.tasks || [];
    backendLines = data.lines || [];
  } catch (err) {
    console.error("Failed loadBackendData:", err);
    backendTasks = [];
    backendLines = [];
  }
}

function updateTaskSummaryDisplay() {
  const lc = localLines.length;
  const totalUnits = localLines.reduce((sum, l) => sum + (Number(l.qty) || 0), 0);

  document.getElementById("taskLineCount").textContent = lc;
  document.getElementById("taskUnitCount").textContent = totalUnits;

  const finishTaskBtn = document.getElementById("finishTaskBtn");
  const finishTaskHeaderBtn = document.getElementById("finishTaskHeaderBtn");
  const shouldEnable = lc > 0;

  finishTaskBtn && (finishTaskBtn.disabled = !shouldEnable);
  finishTaskHeaderBtn && (finishTaskHeaderBtn.disabled = !shouldEnable);
}
// ===================== SCANNER APP FLOW =====================

// ---- Set Bin ----
function onBinScanned() {
  const binInput = document.getElementById("binInput");
  const raw = (binInput.value || "").trim();
  if (!raw) return;

  const binId = raw.toUpperCase();
  setStatus("binStatus", `Validating bin ${binId}...`);

  // Check capacity remote usage
  const matchingLines = backendLines.filter(l => l.binId === binId);
  const usedRemote = matchingLines.reduce((sum, l) => sum + (Number(l.qty) || 0), 0);

  const binsCapacity = 100; // default
  currentBinId = binId;
  currentBinCapacity = binsCapacity;
  currentBinUsedRemote = usedRemote;
  currentBinUsedLocal = calcLocalBinUsage(binId);

  document.getElementById("binCapacity").textContent = currentBinCapacity;
  document.getElementById("binUsed").textContent = currentBinUsedRemote + currentBinUsedLocal;
  document.getElementById("binFree").textContent =
    currentBinCapacity - (currentBinUsedRemote + currentBinUsedLocal);

  // Update UI
  document.getElementById("scanStoreCard").style.display = "block";
  document.getElementById("reviewCard").style.display = "block";

  document.getElementById("binInput").readOnly = true;
  document.getElementById("setBinBtn").disabled = true;
  document.getElementById("resetBinBtn").style.display = "inline-block";

  setStatus("binStatus", `Current Bin: ${binId}`);
  refreshBinLinesTable();
}

function calcLocalBinUsage(binId) {
  return localLines
    .filter(l => l.binId === binId)
    .reduce((sum, l) => sum + (Number(l.qty) || 0), 0);
}

// ---- Save SKU Line Locally ----
function onSaveLine() {
  const skuInput = document.getElementById("skuInput");
  const qtyInput = document.getElementById("qtyInput");
  const remarksInput = document.getElementById("remarksInput");

  const skuRaw = (skuInput.value || "").trim();
  if (!skuRaw) {
    setStatus("statusMessage", "Enter SKU ID", true);
    return;
  }

  const skuId = skuRaw.toUpperCase();
  const qty = Number(qtyInput.value || 0);
  const remarks = (remarksInput.value || "").trim();

  if (!qty || qty <= 0) {
    setStatus("statusMessage", "Enter valid quantity (>0)", true);
    return;
  }

  const existingRemote = currentBinUsedRemote;
  const existingLocal = calcLocalBinUsage(currentBinId);
  const newTotal = existingRemote + existingLocal + qty;

  if (newTotal > currentBinCapacity) {
    setStatus("statusMessage", `Exceeds Capacity! Free: ${currentBinCapacity - (existingRemote + existingLocal)}`, true);
    return;
  }

  const line = {
    id: "LOCAL-" + Date.now(),
    binId: currentBinId,
    skuId,
    qty,
    remarks,
    scannedAt: new Date().toISOString()
  };
  localLines.push(line);

  skuInput.value = "";
  qtyInput.value = "";
  remarksInput.value = "";
  skuInput.focus();

  currentBinUsedLocal = calcLocalBinUsage(currentBinId);

  document.getElementById("binUsed").textContent = currentBinUsedRemote + currentBinUsedLocal;
  document.getElementById("binFree").textContent =
    currentBinCapacity - (currentBinUsedRemote + currentBinUsedLocal);

  refreshBinLinesTable();
  updateTaskSummaryDisplay();
  setStatus("statusMessage", "Line added", false);
}

// ---- Refresh Review Table ----
function refreshBinLinesTable() {
  const tbody = document.querySelector("#binLinesTable tbody");
  tbody.innerHTML = "";

  const list = localLines.filter(x => x.binId === currentBinId);
  list.forEach((l, index) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${index + 1}</td>
      <td>${l.skuId}</td>
      <td>${l.qty}</td>
      <td>${l.remarks || "-"}</td>
      <td>${formatTime(l.scannedAt)}</td>
      <td>
        <button class="tiny" onclick="editLine('${l.id}')">Edit</button>
        <button class="tiny red" onclick="deleteLine('${l.id}')">Delete</button>
      </td>
    `;
    tbody.appendChild(tr);
  });
}

// ---- Edit Line ----
function editLine(id) {
  const item = localLines.find(l => l.id === id);
  if (!item) return;

  const newSku = prompt("Edit SKU:", item.skuId);
  if (newSku === null) return;

  const newQty = Number(prompt("Edit Quantity:", item.qty));
  if (!newQty || newQty <= 0) {
    alert("Invalid qty");
    return;
  }

  const newRemarks = prompt("Edit Remarks:", item.remarks || "") || "";

  // Capacity validation
  const remoteUsed = currentBinUsedRemote;
  const otherLocal = localLines.filter(l => l.id !== id && l.binId === currentBinId)
    .reduce((sum, l) => sum + l.qty, 0);
  const testTotal = remoteUsed + otherLocal + newQty;

  if (testTotal > currentBinCapacity) {
    alert("Exceeds capacity");
    return;
  }

  item.skuId = newSku.trim().toUpperCase();
  item.qty = newQty;
  item.remarks = newRemarks.trim();
  refreshBinLinesTable();
  updateTaskSummaryDisplay();
}

// ---- Delete Line ----
function deleteLine(id) {
  localLines = localLines.filter(l => l.id !== id);
  currentBinUsedLocal = calcLocalBinUsage(currentBinId);
  document.getElementById("binUsed").textContent = currentBinUsedRemote + currentBinUsedLocal;
  document.getElementById("binFree").textContent =
    currentBinCapacity - (currentBinUsedRemote + currentBinUsedLocal);

  refreshBinLinesTable();
  updateTaskSummaryDisplay();
}

// ---- Bin Complete ----
function onBinComplete() {
  document.getElementById("scanStoreCard").style.display = "none";
  setStatus("binStatus", `Bin ${currentBinId} completed.`);
}

// ---- Reset Bin ----
function resetBin() {
  currentBinId = "";
  currentBinUsedLocal = 0;

  document.getElementById("binInput").value = "";
  document.getElementById("binInput").readOnly = false;
  document.getElementById("setBinBtn").disabled = false;
  document.getElementById("resetBinBtn").style.display = "none";

  document.getElementById("scanStoreCard").style.display = "none";
  document.getElementById("reviewCard").style.display = "none";

  setStatus("binStatus", "Scan bin again");
}

// ---- Finish Task (send all lines once) ----
async function onFinishTask() {
  if (localLines.length === 0) return;

  try {
    const payload = {
      action: "createTaskWithLines",
      deviceId: scannerDeviceId,
      createdAt: new Date().toISOString(),
      lines: localLines
    };

    const res = await fetch(BACKEND_URL, {
      method: "POST",
      body: JSON.stringify(payload),
      headers: { "Content-Type": "application/json" }
    });

    const data = await res.json();
    if (!data.success) {
      alert("Error: " + data.error);
      return;
    }

    alert("Task Submitted Successfully: " + data.code);
    localLines = [];
    currentBinId = "";
    updateTaskSummaryDisplay();
    window.location.reload();

  } catch (err) {
    alert("Error submitting: " + err);
  }
}
// ===================== SUPERVISOR TABLE BUILDERS =====================

function buildSupervisorTables() {
  buildOpenTodayTable();
  buildAllOpenTable();
  buildPendingOldTable();
  buildRecentClosedTable();
}

// ---- Open Tasks (Today) ----
function buildOpenTodayTable() {
  const tbody = document.querySelector("#taskTable tbody");
  tbody.innerHTML = "";

  const today = formatDateOnly(new Date());
  const tasks = backendTasks.filter(
    t => t.status === "OPEN" && formatDateOnly(t.createdAt) === today
  );

  tasks.forEach(task => {
    const lines = backendLines.filter(l => l.taskId === task.id);
    const units = lines.reduce((s, l) => s + l.qty, 0);

    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td><input type="checkbox" class="today-task-chk" data-taskid="${task.id}"></td>
      <td>${task.code}</td>
      <td>${formatDateTime(task.createdAt)}</td>
      <td>${lines.length}</td>
      <td>${units}</td>
      <td><button class="tiny" onclick="toggleTaskView('${task.id}','taskTable')">View</button></td>
    `;
    tbody.appendChild(tr);
  });

  document.getElementById("taskListStatus").textContent =
    tasks.length ? `${tasks.length} open tasks today` : "No open tasks for today";
}

// ---- All Open Tasks ----
function buildAllOpenTable() {
  const tbody = document.querySelector("#allOpenTable tbody");
  tbody.innerHTML = "";

  const openTasks = backendTasks.filter(t => t.status === "OPEN");

  openTasks.forEach(task => {
    const lines = backendLines.filter(l => l.taskId === task.id);
    const units = lines.reduce((s, l) => s + l.qty, 0);

    const created = new Date(task.createdAt);
    const ageDays = Math.floor((Date.now() - created.getTime()) / (1000 * 60 * 60 * 24));

    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td><input type="checkbox" class="open-task-chk" data-taskid="${task.id}"></td>
      <td>${task.code}</td>
      <td>${formatDateTime(task.createdAt)}</td>
      <td>${ageDays}</td>
      <td>${lines.length}</td>
      <td>${units}</td>
      <td><button class="tiny" onclick="toggleTaskView('${task.id}','allOpenTable')">View</button></td>
    `;
    tbody.appendChild(tr);
  });

  document.getElementById("allOpenStatus").textContent =
    openTasks.length ? `${openTasks.length} tasks open total` : "No open tasks found";
}

// ---- Pending Previous Days ----
function buildPendingOldTable() {
  const tbody = document.querySelector("#pendingOldTable tbody");
  tbody.innerHTML = "";

  const today = formatDateOnly(new Date());
  const pending = backendTasks.filter(
    t => t.status === "OPEN" && formatDateOnly(t.createdAt) !== today
  );

  pending.forEach(task => {
    const lines = backendLines.filter(l => l.taskId === task.id);
    const units = lines.reduce((s, l) => s + l.qty, 0);

    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${task.code}</td>
      <td>${formatDateTime(task.createdAt)}</td>
      <td>${lines.length}</td>
      <td>${units}</td>
      <td><button class="tiny" onclick="toggleTaskView('${task.id}','pendingOldTable')">View</button></td>
    `;
    tbody.appendChild(tr);
  });

  document.getElementById("pendingOldStatus").textContent =
    pending.length ? `${pending.length} pending tasks` : "None pending";
}

// ---- Recently Closed ----
function buildRecentClosedTable() {
  const tbody = document.querySelector("#recentClosedTable tbody");
  tbody.innerHTML = "";

  const closed = backendTasks
    .filter(t => t.status === "CLOSED")
    .sort((a, b) => new Date(b.closedAt) - new Date(a.closedAt))
    .slice(0, 10);

  closed.forEach(task => {
    const lines = backendLines.filter(l => l.taskId === task.id);
    const units = lines.reduce((s, l) => s + l.qty, 0);

    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${task.code}</td>
      <td>${formatDateTime(task.createdAt)}</td>
      <td>${formatDateTime(task.closedAt)}</td>
      <td>${lines.length}</td>
      <td>${units}</td>
      <td><button class="tiny" onclick="toggleTaskView('${task.id}','recentClosedTable')">View</button></td>
    `;
    tbody.appendChild(tr);
  });

  document.getElementById("recentClosedStatus").textContent =
    closed.length ? "" : "No recently closed tasks";
}

// ===================== INLINE VIEW (TOGGLE) =====================

function toggleTaskView(taskId, tableId) {
  const table = document.getElementById(tableId);
  const rows = Array.from(table.querySelectorAll("tr"));

  // if already open -> close all
  const existingRow = table.querySelector(`tr.details-row-${taskId}`);
  if (existingRow) {
    existingRow.remove();
    return;
  }

  // Close any other open detail rows in same table
  rows.forEach(r => {
    if (r.classList.contains("details-row")) r.remove();
  });

  const targetRow = [...table.querySelectorAll("tr")]
    .find(r => r.innerHTML.includes(`toggleTaskView('${taskId}'`));

  if (!targetRow) return;

  const detailRow = document.createElement("tr");
  detailRow.classList.add("details-row", `details-row-${taskId}`);

  const colspan = targetRow.children.length;
  const lines = backendLines.filter(l => l.taskId === taskId);

  let html = `
    <td colspan="${colspan}">
      <div>
        <strong>Task Lines</strong>
        <table class="detail-table">
          <thead>
            <tr>
              <th>Bin</th>
              <th>SKU</th>
              <th>Qty</th>
              <th>Remarks</th>
              <th>Time</th>
            </tr>
          </thead>
          <tbody>
  `;

  lines.forEach(l => {
    html += `
      <tr>
        <td>${l.binId}</td>
        <td>${l.skuId}</td>
        <td>${l.qty}</td>
        <td>${l.remarks || "-"}</td>
        <td>${formatTime(l.scannedAt)}</td>
      </tr>`;
  });

  html += `
          </tbody>
        </table>
      </div>
    </td>
  `;

  detailRow.innerHTML = html;

  targetRow.insertAdjacentElement("afterend", detailRow);
}
// ===================== BULK ACTION HANDLERS =====================

// ---- TODAY: Export Selected / All ----
function onExportTodaySelected() {
  const selected = [...document.querySelectorAll(".today-task-chk:checked")]
    .map(c => c.dataset.taskid);

  if (selected.length > 0) {
    exportTasksToCSV(selected);
  } else {
    const today = formatDateOnly(new Date());
    const tasks = backendTasks
      .filter(t => t.status === "OPEN" && formatDateOnly(t.createdAt) === today)
      .map(t => t.id);
    exportTasksToCSV(tasks);
  }
}

// ---- TODAY: Close Selected / All ----
async function onCloseTodaySelected() {
  const selected = [...document.querySelectorAll(".today-task-chk:checked")]
    .map(c => c.dataset.taskid);

  let ids = [];
  if (selected.length > 0) {
    ids = selected;
  } else {
    const today = formatDateOnly(new Date());
    ids = backendTasks
      .filter(t => t.status === "OPEN" && formatDateOnly(t.createdAt) === today)
      .map(t => t.id);
  }

  if (!ids.length) return alert("No tasks to close");

  if (!confirm(`Close ${ids.length} tasks?`)) return;

  for (const id of ids) {
    await updateTaskStatus(id, "CLOSED");
  }

  await loadBackendData();
  buildSupervisorTables();
}

// ---- Toggle Select All Today ----
function toggleSelectTodayAll(e) {
  const checked = e.target.checked;
  document.querySelectorAll(".today-task-chk").forEach(c => (c.checked = checked));
}

// ===================== ALL OPEN SECTION BULK =====================

// ---- Export Selected Open ----
function onExportSelectedOpen() {
  const selected = [...document.querySelectorAll(".open-task-chk:checked")]
    .map(c => c.dataset.taskid);

  if (!selected.length) return alert("Select tasks first");
  exportTasksToCSV(selected);
}

// ---- Close Selected Open ----
async function onCloseSelectedOpen() {
  const selected = [...document.querySelectorAll(".open-task-chk:checked")]
    .map(c => c.dataset.taskid);

  if (!selected.length) return alert("Select tasks first");
  if (!confirm(`Close ${selected.length} tasks?`)) return;

  for (const id of selected) {
    await updateTaskStatus(id, "CLOSED");
  }

  await loadBackendData();
  buildSupervisorTables();
}

// ---- Toggle select all open ----
function toggleSelectAllOpen(e) {
  const checked = e.target.checked;
  document.querySelectorAll(".open-task-chk").forEach(c => (c.checked = checked));
}

// ===================== PENDING OLD =====================

function onExportPendingAll() {
  const today = formatDateOnly(new Date());
  const pending = backendTasks
    .filter(t => t.status === "OPEN" && formatDateOnly(t.createdAt) !== today)
    .map(t => t.id);

  if (!pending.length) return alert("No pending tasks");

  exportTasksToCSV(pending);
}

async function onClosePendingAll() {
  const today = formatDateOnly(new Date());
  const pending = backendTasks
    .filter(t => t.status === "OPEN" && formatDateOnly(t.createdAt) !== today)
    .map(t => t.id);

  if (!pending.length) return alert("No pending tasks");
  if (!confirm(`Close ${pending.length} tasks?`)) return;

  for (const id of pending) {
    await updateTaskStatus(id, "CLOSED");
  }
  await loadBackendData();
  buildSupervisorTables();
}

// ===================== CLOSED RANGE FILTER =====================

function onClosedSearch() {
  const from = document.getElementById("closedFromDate").value;
  const to = document.getElementById("closedToDate").value || from;

  if (!from) {
    alert("Select From Date");
    return;
  }

  const tbody = document.querySelector("#closedRangeTable tbody");
  tbody.innerHTML = "";

  const results = backendTasks.filter(t => {
    return (
      t.status === "CLOSED" &&
      formatDateOnly(t.closedAt) >= from &&
      formatDateOnly(t.closedAt) <= to
    );
  });

  results.forEach(task => {
    const lines = backendLines.filter(l => l.taskId === task.id);
    const units = lines.reduce((s, l) => s + l.qty, 0);

    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${task.code}</td>
      <td>${formatDateTime(task.createdAt)}</td>
      <td>${formatDateTime(task.closedAt)}</td>
      <td>${lines.length}</td>
      <td>${units}</td>
      <td><button class="tiny" onclick="toggleTaskView('${task.id}','closedRangeTable')">View</button></td>
    `;
    tbody.appendChild(tr);
  });

  document.getElementById("closedRangeStatus").textContent =
    results.length ? `${results.length} result(s)` : "No results";
}

// ---- Export closed range ----
function exportClosedRangeCSV() {
  const rows = document.querySelectorAll("#closedRangeTable tbody tr");
  if (!rows.length) return alert("No results to export");

  const tasks = Array.from(rows).map(r => r.children[0].textContent);
  const relevantIds = backendTasks
    .filter(t => tasks.includes(t.code))
    .map(t => t.id);

  exportTasksToCSV(relevantIds);
}

// ===================== CSV EXPORT =====================

function exportTasksToCSV(taskIds) {
  let rows = [["task_code","task_created_at","task_closed_at","bin_id","sku_id","qty","remarks","scanned_at"]];

  backendLines.forEach(l => {
    if (taskIds.includes(l.taskId)) {
      const task = backendTasks.find(t => t.id === l.taskId);
      rows.push([
        task.code,
        task.createdAt,
        task.closedAt || "",
        l.binId,
        l.skuId,
        l.qty,
        l.remarks || "",
        l.scannedAt
      ]);
    }
  });

  downloadCSV(rows, "putaway_tasks.csv");
}

// ===================== DAILY REPORT =====================

function runDailyReport() {
  const date = document.getElementById("reportDate").value;
  if (!date) return alert("Pick a date");

  const closedToday = backendTasks.filter(
    t => t.status === "CLOSED" && formatDateOnly(t.closedAt) === date
  );

  const lines = backendLines.filter(l =>
    closedToday.map(t => t.id).includes(l.taskId)
  );

  const total = lines.reduce((s, l) => s + l.qty, 0);
  document.getElementById("reportTotalUnits").textContent = total;

  const skuTotals = {};
  lines.forEach(l => {
    skuTotals[l.skuId] = (skuTotals[l.skuId] || 0) + l.qty;
  });

  const tbody = document.querySelector("#reportBySkuTable tbody");
  tbody.innerHTML = "";
  Object.keys(skuTotals).forEach(sku => {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${sku}</td><td>${skuTotals[sku]}</td>`;
    tbody.appendChild(tr);
  });

  document.getElementById("reportStatus").textContent = `${lines.length} line(s)`;
}

function exportDailyReportCSV() {
  const rows = [];
  document.querySelectorAll("#reportBySkuTable tbody tr").forEach(r => {
    const sku = r.children[0].textContent;
    const qty = r.children[1].textContent;
    rows.push([sku, qty]);
  });

  downloadCSV([["SKU","Units"], ...rows], "daily_report.csv");
}

// ===================== CAMERA & UTILS =====================

function stopScanner() {
  try {
    if (html5QrCode) html5QrCode.stop();
  } catch (e) {
    console.warn(e);
  }
  html5QrCode = null;
  currentScanTarget = null;
  document.getElementById("closeCameraBtn").style.display = "none";
  setStatus("cameraStatus", "Camera stopped.");
}

function setStatus(elId, msg, isErr=false) {
  const el = document.getElementById(elId);
  if (!el) return;
  el.textContent = msg;
  el.style.color = isErr ? "red" : "green";
}

async function updateTaskStatus(id, newStatus) {
  const payload = { action: "updateTaskStatus", taskId: id, newStatus };
  await fetch(BACKEND_URL, {
    method: "POST",
    body: JSON.stringify(payload),
    headers: { "Content-Type": "application/json" }
  });
}

function downloadCSV(data, filename) {
  const csvContent = data.map(e => e.map(x => `"${x}"`).join(",")).join("\n");
  const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  link.click();
}

function formatDateOnly(d) {
  if (!d) return "";
  const dt = new Date(d);
  return dt.toISOString().substring(0, 10);
}

function formatDateTime(d) {
  if (!d) return "-";
  return d.replace("T", " ").substring(0, 16);
}

function formatTime(d) {
  if (!d) return "-";
  return d.replace("T", " ").substring(11, 16);
}
