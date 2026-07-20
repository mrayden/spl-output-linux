const $ = (id) => document.getElementById(id);
let state = { days: 7, all: false, device: '' };
let chart = null;
let currentCap = 75;
let trayEnabled = false;
let lastLive = null;
let byDayGlobal = [];

// ----- meter helpers -----
const MIN_DB = 40, MAX_DB = 100;
function dbToPct(db) {
  return Math.max(0, Math.min(1, (db - MIN_DB) / (MAX_DB - MIN_DB))) * 100;
}
function placeCap(cap) {
  $('meterCap').style.left = dbToPct(cap) + '%';
  $('capLabel').textContent = cap + ' dB cap';
}

// ----- tray icon drawing -----
function drawTray(o) {
  const cv = $('trayCanvas'); const g = cv.getContext('2d');
  const S = cv.width;
  g.clearRect(0, 0, S, S);
  let text, color, tip;
  if (!o || o.error || o.silent) { text = '--'; color = '#9aa0aa'; tip = 'SPL Monitor: silent'; }
  else if (o.spl === null) { text = String(Math.round(o.rms_dbfs)); color = '#9aa0aa'; tip = (o.label || 'device') + ': not calibrated'; }
  else {
    text = String(Math.round(o.spl));
    color = o.over_cap ? '#ff5c5c' : '#35d0a5';
    tip = (o.label || 'device') + ': ' + o.spl.toFixed(1) + ' dB SPL' + (o.over_cap ? '  (OVER CAP)' : '');
  }
  g.fillStyle = '#1b1f27';
  g.beginPath(); g.roundRect(2, 2, S - 4, S - 4, 16); g.fill();
  g.fillStyle = color;
  g.font = 'bold ' + (text.length >= 3 ? 34 : 46) + 'px sans-serif';
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(text, S / 2, S / 2 + 3);
  try { window.api.trayUpdate(cv.toDataURL('image/png'), tip); } catch (e) {}
}

// ----- live -----
window.api.onLive((o) => {
  lastLive = o;
  const warnEl = $('liveWarn');
  if (!o || o.error) {
    $('liveDevice').textContent = 'no output device';
    $('liveSpl').textContent = '--';
    $('meterFill').style.width = '100%';
    warnEl.style.display = 'none';
  } else {
    $('liveDevice').textContent = o.label || o.device;
    $('liveVol').textContent = 'volume ' + Math.round(o.volume * 100) + '%';
    const stateEl = $('liveState');
    if (o.silent) {
      $('liveSpl').textContent = '--'; $('liveRms').textContent = '';
      stateEl.textContent = 'silent'; stateEl.className = 'state silent';
      $('meterFill').style.width = '100%';
    } else if (o.spl === null) {
      $('liveSpl').textContent = o.rms_dbfs; $('liveRms').textContent = 'dBFS (not calibrated)';
      stateEl.textContent = 'uncalibrated'; stateEl.className = 'state uncal';
      $('meterFill').style.width = '100%';
    } else {
      $('liveSpl').textContent = o.spl.toFixed(1);
      const pk = (o.peak_spl != null) ? o.peak_spl.toFixed(1) : '--';
      $('liveRms').textContent = 'peak ~' + pk + ' dB   |   ' + o.rms_dbfs + ' dBFS';
      $('meterFill').style.width = (100 - dbToPct(o.spl)) + '%';
      if (o.over_cap) { stateEl.textContent = 'OVER CAP'; stateEl.className = 'state over'; }
      else { stateEl.textContent = 'ok'; stateEl.className = 'state'; }
    }
    // warning badge for current device
    if (!o.silent && !o.calibrated) { warnEl.textContent = 'not calibrated'; warnEl.style.display = ''; }
    else if (!o.silent && !o.whitelisted) { warnEl.textContent = 'not in whitelist'; warnEl.style.display = ''; }
    else { warnEl.style.display = 'none'; }
    if (o.cap && o.cap !== currentCap) {
      currentCap = o.cap; placeCap(currentCap);
      if (!document.activeElement || document.activeElement.id !== 'capInput') $('capInput').value = currentCap;
    }
  }
  if (trayEnabled) drawTray(o);
});

// ----- report -----
function doseAvg(r) {
  const days = r.by_day || [];
  const sum = days.reduce((a, d) => a + (d.dose || 0), 0);
  return Math.round(sum / Math.max(1, days.length));
}
function setStatus(r) {
  const t = r.total || {};
  const dot = $('statusDot'), text = $('statusText'), sub = $('statusSub');
  if (!t.hours) { dot.className = 'status-dot'; text.textContent = 'No data yet'; sub.textContent = 'Play something on a calibrated device to start tracking.'; return; }
  const loud = (t.over_pct >= 5) || (t.leq != null && t.leq >= currentCap);
  if (loud) {
    dot.className = 'status-dot loud'; text.textContent = 'Loud';
    sub.textContent = `${t.over_pct || 0}% of your listening was above ${currentCap} dB in this period.`;
  } else {
    dot.className = 'status-dot ok'; text.textContent = 'OK';
    sub.textContent = `Levels stayed within your ${currentCap} dB cap. Average ${t.leq != null ? t.leq.toFixed(0) : '--'} dB.`;
  }
}
async function loadReport() {
  const allEff = state.all || !!state.device;
  const r = await window.api.report(state.days, allEff, state.device);
  const t = r.total || {};
  $('sHours').textContent = (t.hours || 0).toFixed(1);
  $('sLeq').textContent = (t.leq != null) ? t.leq.toFixed(1) : '--';
  $('sMax').textContent = (t.worst_peak != null) ? t.worst_peak.toFixed(1) : '--';
  $('sMaxWhen').textContent = t.worst_when || 'dB';
  $('sDose').textContent = doseAvg(r);
  $('sOver').textContent = (t.over_hours || 0).toFixed(2);
  $('sOverPct').textContent = (t.over_pct || 0) + '% of listening';
  if (r.cap) {
    currentCap = r.cap; placeCap(currentCap);
    if ($('capInput').value === '') $('capInput').value = currentCap;
  }
  setStatus(r);
  drawChart(r.by_day || []);
}

// ----- chart (Apple-style level bars) -----
function barColor(d) {
  if (d.leq != null && d.leq > currentCap) return '#ff5c5c';
  if (d.max != null && d.max > currentCap) return '#f5a623';
  return '#35d0a5';
}
function drawChart(byDay) {
  byDayGlobal = byDay;
  const labels = byDay.map(d => d.date.slice(5));
  const data = {
    labels,
    datasets: [
      { type: 'bar', label: 'Avg level (dB)', data: byDay.map(d => d.leq), backgroundColor: byDay.map(barColor), borderRadius: 5, yAxisID: 'y' },
      { type: 'line', label: 'Peak (dB)', data: byDay.map(d => d.max), borderColor: '#c9d1dc', backgroundColor: '#c9d1dc', pointRadius: 2, tension: .3, fill: false, yAxisID: 'y' },
      { type: 'line', label: `Cap (${currentCap} dB)`, data: byDay.map(() => currentCap), borderColor: '#ff5c5c', borderDash: [6, 4], pointRadius: 0, yAxisID: 'y' }
    ]
  };
  const opts = {
    responsive: true, maintainAspectRatio: false,
    interaction: { mode: 'index', intersect: false },
    scales: {
      x: { grid: { color: '#20242e' }, ticks: { color: '#8a909a' } },
      y: { suggestedMin: 40, suggestedMax: 100, grid: { color: '#20242e' }, ticks: { color: '#8a909a' }, title: { display: true, text: 'dB SPL', color: '#8a909a' } }
    },
    plugins: {
      legend: { labels: { color: '#c7ccd4', boxWidth: 12 } },
      tooltip: {
        callbacks: {
          afterBody: (items) => {
            const d = byDayGlobal[items[0].dataIndex];
            if (!d) return '';
            return `Listening: ${d.hours.toFixed(2)} h\nOver cap: ${d.over_hours.toFixed(2)} h`;
          }
        }
      }
    }
  };
  if (chart) { chart.data = data; chart.options = opts; chart.update(); }
  else { chart = new Chart($('chart').getContext('2d'), { data, options: opts }); }
}

// ----- devices -----
function populateDevFilter(devs) {
  const sel = $('devFilter');
  const cur = sel.value;
  sel.innerHTML = '<option value="">All devices</option>' +
    devs.map(d => `<option value="${escapeHtml(d.device)}">${escapeHtml(d.label)}</option>`).join('');
  if ([...sel.options].some(o => o.value === cur)) sel.value = cur;
}
async function loadDevices() {
  const devs = await window.api.devices();
  populateDevFilter(devs);
  const tb = $('devTable').querySelector('tbody');
  tb.innerHTML = '';
  devs.forEach(d => {
    const tr = document.createElement('tr');
    tr.innerHTML =
      `<td>${escapeHtml(d.label)}</td>` +
      `<td>${d.hours.toFixed(2)} h</td>` +
      `<td><span class="pill ${d.calibrated ? 'yes' : 'no'}">${d.calibrated ? 'yes' : 'no'}</span></td>` +
      `<td><label class="switch"><input type="checkbox" ${d.whitelisted ? 'checked' : ''}><span class="slider"></span></label></td>`;
    const cb = tr.querySelector('input');
    cb.addEventListener('change', async () => { await window.api.whitelist(d.device, cb.checked); loadReport(); });
    tb.appendChild(tr);
  });
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// ----- tabs -----
$('tabs').addEventListener('click', (e) => {
  if (e.target.tagName !== 'BUTTON') return;
  [...$('tabs').children].forEach(b => b.classList.remove('active'));
  e.target.classList.add('active');
  const tab = e.target.dataset.tab;
  $('view-dashboard').classList.toggle('active', tab === 'dashboard');
  $('view-settings').classList.toggle('active', tab === 'settings');
});

// ----- controls -----
$('daysSeg').addEventListener('click', (e) => {
  if (e.target.tagName !== 'BUTTON') return;
  [...$('daysSeg').children].forEach(b => b.classList.remove('active'));
  e.target.classList.add('active');
  state.days = parseInt(e.target.dataset.days, 10);
  loadReport();
});
$('devFilter').addEventListener('change', (e) => { state.device = e.target.value; loadReport(); });
$('allChk').addEventListener('change', (e) => { state.all = e.target.checked; loadReport(); loadDevices(); });
$('refreshBtn').addEventListener('click', () => { loadReport(); loadDevices(); });
$('capSave').addEventListener('click', async () => {
  const v = parseFloat($('capInput').value);
  if (isNaN(v)) return;
  await window.api.setCap(v);
  currentCap = v; placeCap(v);
  $('capMsg').textContent = 'saved';
  setTimeout(() => { $('capMsg').textContent = ''; }, 1500);
  loadReport();
});
$('trayChk').addEventListener('change', async (e) => {
  trayEnabled = e.target.checked;
  await window.api.setUiSetting('tray', trayEnabled);
  if (trayEnabled && lastLive) drawTray(lastLive);
});
$('allDefaultChk').addEventListener('change', async (e) => {
  await window.api.setUiSetting('allDefault', e.target.checked);
  state.all = e.target.checked;
  $('allChk').checked = e.target.checked;
  loadReport(); loadDevices();
});

// ----- init -----
async function init() {
  const s = await window.api.getUiSettings();
  trayEnabled = !!s.tray;
  $('trayChk').checked = trayEnabled;
  $('allDefaultChk').checked = !!s.allDefault;
  if (s.allDefault) { state.all = true; $('allChk').checked = true; }
  placeCap(currentCap);
  await loadDevices();
  loadReport();
  setInterval(() => { loadReport(); loadDevices(); }, 30000);
}
init();
