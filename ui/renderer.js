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

// ----- chart (Apple-style range capsules: min..max per day) -----
function barColor(d) {
  return (d.max != null && d.max > currentCap) ? '#ff6b6b' : '#35d0a5';
}
function drawChart(byDay) {
  byDayGlobal = byDay;
  const labels = byDay.map(d => d.date.slice(5));
  const ranges = byDay.map(d => (d.min != null && d.max != null) ? [d.min, d.max] : null);
  const data = {
    labels,
    datasets: [
      { type: 'bar', label: 'Range (dB)', data: ranges, backgroundColor: byDay.map(barColor),
        borderRadius: 20, borderSkipped: false, barPercentage: 0.55, categoryPercentage: 0.7, maxBarThickness: 26, yAxisID: 'y' },
      { type: 'line', label: 'Average', data: byDay.map(d => d.leq), showLine: false, pointRadius: 3, pointBackgroundColor: '#eaeef3', pointBorderColor: '#0d0f13', yAxisID: 'y' },
      { type: 'line', label: `Cap ${currentCap} dB`, data: byDay.map(() => currentCap), borderColor: 'rgba(255,107,107,.7)', borderDash: [5, 5], pointRadius: 0, borderWidth: 1.5, yAxisID: 'y' }
    ]
  };
  const opts = {
    responsive: true, maintainAspectRatio: false,
    interaction: { mode: 'index', intersect: false },
    scales: {
      x: { grid: { display: false }, ticks: { color: '#8b93a1' } },
      y: { suggestedMin: 30, suggestedMax: 100, grid: { color: 'rgba(255,255,255,.05)' }, ticks: { color: '#8b93a1', stepSize: 10 }, title: { display: true, text: 'dB SPL', color: '#5f6672' } }
    },
    plugins: {
      legend: { labels: { color: '#c7ccd4', boxWidth: 10, usePointStyle: true } },
      tooltip: {
        callbacks: {
          label: (item) => {
            const d = byDayGlobal[item.dataIndex]; if (!d) return '';
            if (item.datasetIndex === 0) return `Range: ${d.min} to ${d.max} dB`;
            if (item.datasetIndex === 1) return `Average: ${d.leq} dB`;
            return '';
          },
          afterBody: (items) => {
            const d = byDayGlobal[items[0].dataIndex]; if (!d) return '';
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
  ['dashboard', 'settings', 'calibration', 'spectrum'].forEach(v =>
    $('view-' + v).classList.toggle('active', tab === v));
  if (tab === 'calibration') { buildCalTable(); loadCalList(); }
  if (tab === 'spectrum') { initSpectrumInputs(); } else { stopSpectrum(); }
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

// ----- calibration -----
const CAL_LEVELS = [6, 12, 18];
let calRows = [];
let calDevice = null, calVolume = 0.5;
function buildCalTable() {
  calRows = CAL_LEVELS.map(l => ({ level: l, rms: null, spl: null }));
  const tb = $('calTable').querySelector('tbody');
  tb.innerHTML = calRows.map((r, i) =>
    `<tr><td>-${r.level} dBFS</td>` +
    `<td><button class="btn" data-i="${i}">Play</button></td>` +
    `<td class="rmsCell muted">--</td>` +
    `<td><input type="number" class="splIn select" data-i="${i}" style="width:100px" placeholder="dB"></td></tr>`).join('');
  tb.querySelectorAll('button').forEach(b => b.addEventListener('click', () => playCal(parseInt(b.dataset.i, 10))));
  tb.querySelectorAll('.splIn').forEach(inp => inp.addEventListener('change', () => { calRows[parseInt(inp.dataset.i, 10)].spl = parseFloat(inp.value); }));
  $('calMsg').textContent = '';
}
async function playCal(i) {
  const freq = parseFloat($('calFreq').value);
  const btns = $('calTable').querySelectorAll('button');
  btns[i].textContent = '...'; btns[i].disabled = true;
  const r = await window.api.playtone(freq, calRows[i].level);
  btns[i].textContent = 'Play'; btns[i].disabled = false;
  if (r && r.rms != null) {
    calRows[i].rms = r.rms; calDevice = r.device; calVolume = r.volume;
    $('calTable').querySelectorAll('.rmsCell')[i].textContent = r.rms + ' dBFS';
    $('calDevInfo').textContent = (r.label || '') + '  vol ' + Math.round(r.volume * 100) + '%';
  } else {
    $('calMsg').textContent = 'capture failed (no output device?)';
  }
}
async function saveCal() {
  const freq = parseFloat($('calFreq').value);
  const pts = calRows.filter(r => r.rms != null && r.spl != null && !isNaN(r.spl));
  if (pts.length < 2) { $('calMsg').textContent = 'Need at least 2 measured points.'; return; }
  if (!calDevice) { $('calMsg').textContent = 'Play a tone first to detect the device.'; return; }
  const n = pts.length;
  const sx = pts.reduce((a, p) => a + p.rms, 0), sy = pts.reduce((a, p) => a + p.spl, 0);
  const sxx = pts.reduce((a, p) => a + p.rms * p.rms, 0), sxy = pts.reduce((a, p) => a + p.rms * p.spl, 0);
  const slope = (n * sxy - sx * sy) / (n * sxx - sx * sx);
  const offset = (sy - slope * sx) / n;
  await window.api.addCalib(calDevice, calVolume, freq, slope, offset);
  $('calMsg').textContent = `Saved ${freq} Hz: SPL = ${slope.toFixed(3)} x dBFS + ${offset.toFixed(1)}`;
  loadCalList(); loadDevices(); loadReport();
}
async function loadCalList() {
  const list = await window.api.calibList();
  const tb = $('calList').querySelector('tbody');
  tb.innerHTML = '';
  list.forEach(r => {
    const tr = document.createElement('tr');
    tr.innerHTML =
      `<td>${escapeHtml(r.label)}</td><td>${Math.round(r.volume * 100)}%</td>` +
      `<td>${r.freq} Hz</td><td>SPL = ${r.slope.toFixed(3)} x dBFS + ${r.offset.toFixed(1)}</td>` +
      `<td><button class="btn">Delete</button></td>`;
    tr.querySelector('button').addEventListener('click', async () => {
      await window.api.delCalib(r.device, r.volume, r.freq);
      loadCalList(); loadReport(); loadDevices();
    });
    tb.appendChild(tr);
  });
}
$('calSave').addEventListener('click', saveCal);

// ----- spectrum (Web Audio FFT on the output monitor) -----
let specStream = null, specCtx = null, specRAF = null, specAnalyser = null;
async function initSpectrumInputs() {
  try { const t = await navigator.mediaDevices.getUserMedia({ audio: true }); t.getTracks().forEach(x => x.stop()); } catch (e) {}
  const devs = await navigator.mediaDevices.enumerateDevices();
  const inputs = devs.filter(d => d.kind === 'audioinput');
  const sel = $('specInput');
  sel.innerHTML = inputs.map(d => `<option value="${d.deviceId}">${escapeHtml(d.label || d.deviceId)}</option>`).join('');
  const mon = inputs.find(d => /monitor/i.test(d.label));
  if (mon) sel.value = mon.deviceId;
  $('specMsg').textContent = mon ? 'Ready. Press Start.' : 'Pick the "Monitor of ..." input to see your output, then Start.';
}
async function startSpectrum() {
  stopSpectrum();
  const id = $('specInput').value;
  try {
    specStream = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: id ? { exact: id } : undefined, echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
  } catch (e) { $('specMsg').textContent = 'could not open input: ' + e.message; return; }
  specCtx = new AudioContext();
  await specCtx.resume();
  const src = specCtx.createMediaStreamSource(specStream);
  specAnalyser = specCtx.createAnalyser();
  specAnalyser.fftSize = 4096; specAnalyser.smoothingTimeConstant = 0.82;
  src.connect(specAnalyser);
  $('specDevice').textContent = $('specInput').selectedOptions[0] ? $('specInput').selectedOptions[0].textContent : 'input';
  $('specMsg').textContent = '';
  drawSpectrum();
}
function stopSpectrum() {
  if (specRAF) { cancelAnimationFrame(specRAF); specRAF = null; }
  if (specStream) { specStream.getTracks().forEach(t => t.stop()); specStream = null; }
  if (specCtx) { try { specCtx.close(); } catch (e) {} specCtx = null; }
  specAnalyser = null;
}
function drawSpectrum() {
  const cv = $('specCanvas'); const g = cv.getContext('2d');
  const W = cv.width = cv.clientWidth, H = cv.height;
  const bins = specAnalyser.frequencyBinCount;
  const freqData = new Float32Array(bins);
  function frame() {
    specAnalyser.getFloatFrequencyData(freqData);
    const spl = (lastLive && lastLive.spl != null && !lastLive.silent) ? lastLive.spl : null;
    $('specDb').textContent = spl != null ? spl.toFixed(1) + ' dB SPL' : '';
    g.clearRect(0, 0, W, H);
    const nbars = 72, step = Math.floor(bins / nbars);
    for (let b = 0; b < nbars; b++) {
      let m = -140; for (let k = 0; k < step; k++) { const v = freqData[b * step + k]; if (v > m) m = v; }
      const norm = Math.max(0, Math.min(1, (m + 100) / 100));
      const bh = norm * (H - 14);
      const x = b * (W / nbars);
      const hue = 165 - norm * 165;
      g.fillStyle = `hsl(${hue},72%,55%)`;
      g.fillRect(x + 1, H - bh, (W / nbars) - 2, bh);
    }
    specRAF = requestAnimationFrame(frame);
  }
  frame();
}
$('specStart').addEventListener('click', startSpectrum);
$('specStop').addEventListener('click', () => { stopSpectrum(); $('specMsg').textContent = 'stopped'; });

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
