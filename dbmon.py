#!/usr/bin/env python3
"""
dbmon - per-device headphone/speaker audio-exposure monitor for PipeWire.

Continuously measures your audio OUTPUT level (dBFS from the default sink's
monitor), converts it to estimated SPL (dB) via a PER-DEVICE recalibratable
mapping, and logs it so you can see listening duration / levels / worst-case
exposure over time and PER OUTPUT DEVICE (like iOS Health "Headphone Levels").

The output device matters for the measurement, so devices are tracked
individually, calibrated individually, and can be WHITELISTED: everything is
always logged, but reports can exclude non-whitelisted devices so your exposure
graphs only reflect the headphones you calibrated.

Exposure uses the NIOSH dose model (85 dB / 8 h, 3 dB exchange). You can also
set a personal loudness CAP (default 75 dB) and see how much time you spent
above it, per device and per day.

Raw dBFS + volume + device are stored, so re-calibrating later (or per device)
re-derives ALL history for that device.

Subcommands:
  daemon      run the background logger (used by the systemd service)
  live        live SPL readout for the current output device
  calibrate   play test tones on the CURRENT device, enter measured SPL, fit curve
  report      historical stats, by device and by day (whitelist-filtered)
  devices     list output devices seen + calibration + whitelist status
  whitelist   list / add / remove devices in the report whitelist
  cap         show or set the personal loudness cap in dB (default 75)
  addcalib    manually add a calibration point for a device
  showcalib   print stored calibration
"""
import argparse, sqlite3, subprocess, time, math, os, sys, tempfile, re, warnings
from datetime import datetime
warnings.filterwarnings("ignore")
try:
    import audioop
    def _rms(d): return audioop.rms(d, 2)
    def _peak(d): return audioop.max(d, 2)
except ImportError:  # audioop removed in Python 3.13
    import array
    def _rms(d):
        a = array.array('h'); a.frombytes(d[:len(d)//2*2])
        return int((sum(x*x for x in a)/len(a))**0.5) if a else 0
    def _peak(d):
        a = array.array('h'); a.frombytes(d[:len(d)//2*2])
        return max((abs(x) for x in a), default=0)

APP = os.path.expanduser("~/.local/share/dbmon")
DBF = os.path.join(APP, "data.db")
CHUNK = 5.0            # seconds captured per sample
LOG_ABOVE = -55.0      # rms dBFS below this = silence, not logged
DEFAULT_CAP = 75.0     # default personal loudness cap in dB

# ---------- storage ----------
def conn():
    os.makedirs(APP, exist_ok=True)
    c = sqlite3.connect(DBF, timeout=15)
    c.execute("PRAGMA journal_mode=WAL")
    c.executescript("""
      CREATE TABLE IF NOT EXISTS samples(
        ts REAL, device TEXT, rms REAL, peak REAL, volume REAL, dur REAL);
      CREATE TABLE IF NOT EXISTS calib(
        device TEXT, volume REAL, slope REAL, offset REAL, weighting TEXT, ts REAL,
        PRIMARY KEY(device, volume));
      CREATE TABLE IF NOT EXISTS devices(
        name TEXT PRIMARY KEY, label TEXT, last_seen REAL, whitelisted INTEGER DEFAULT 0);
      CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT);
      CREATE INDEX IF NOT EXISTS ix_ts ON samples(ts);
      CREATE INDEX IF NOT EXISTS ix_dev ON samples(device);
    """)
    cols = [r[1] for r in c.execute("PRAGMA table_info(devices)")]
    if "whitelisted" not in cols:
        c.execute("ALTER TABLE devices ADD COLUMN whitelisted INTEGER DEFAULT 0")
    c.commit()
    return c

def get_setting(c, key, default=None):
    r = c.execute("SELECT value FROM settings WHERE key=?", (key,)).fetchone()
    return r[0] if r else default

def set_setting(c, key, value):
    c.execute("""INSERT INTO settings(key,value) VALUES(?,?)
                 ON CONFLICT(key) DO UPDATE SET value=excluded.value""", (key, str(value)))
    c.commit()

def get_cap(c):
    return float(get_setting(c, "cap_db", DEFAULT_CAP))

def upsert_device(c, name, label):
    c.execute("""INSERT INTO devices(name,label,last_seen,whitelisted) VALUES(?,?,?,0)
                 ON CONFLICT(name) DO UPDATE SET label=excluded.label,last_seen=excluded.last_seen""",
              (name, label, time.time()))

def device_label(c, name):
    r = c.execute("SELECT label FROM devices WHERE name=?", (name,)).fetchone()
    return r[0] if r and r[0] else name

def whitelist_set(c):
    return {n for (n,) in c.execute("SELECT name FROM devices WHERE whitelisted=1")}

# ---------- pipewire helpers ----------
def wpctl(*a):
    try:
        return subprocess.run(["wpctl", *a], capture_output=True, text=True, timeout=8).stdout
    except Exception:
        return ""

def default_sink():
    """Return (id, node_name, description, volume) of the default sink, or None."""
    ins = wpctl("inspect", "@DEFAULT_AUDIO_SINK@")
    if not ins:
        return None
    m_id = re.search(r'\bid (\d+)', ins)
    m_nm = re.search(r'node\.name = "([^"]+)"', ins)
    m_ds = re.search(r'node\.description = "([^"]+)"', ins)
    vol = wpctl("get-volume", "@DEFAULT_AUDIO_SINK@")
    m_v = re.search(r'Volume:\s*([0-9.]+)', vol)
    muted = "MUTED" in vol
    if not (m_id and m_nm):
        return None
    return (int(m_id.group(1)), m_nm.group(1),
            m_ds.group(1) if m_ds else m_nm.group(1),
            0.0 if muted else (float(m_v.group(1)) if m_v else 1.0))

def capture(sink_id, secs=CHUNK):
    """Capture the sink monitor for `secs`; return (rms_dbfs, peak_dbfs) or None."""
    tmp = tempfile.mktemp(suffix=".raw", dir="/tmp")
    try:
        subprocess.run(["timeout", f"{secs+0.4:.1f}", "pw-record",
                        "--target", str(sink_id), "-P", "stream.capture.sink=true",
                        "--format=s16", "--rate=48000", "--channels=2", tmp],
                       capture_output=True, timeout=secs+3)
        data = open(tmp, "rb").read()
    except Exception:
        return None
    finally:
        try: os.remove(tmp)
        except Exception: pass
    if len(data) < 2000:
        return None
    rms = _rms(data); pk = _peak(data)
    d = lambda v: 20*math.log10(v/32768.0) if v > 0 else -120.0
    return d(rms), d(pk)

# ---------- calibration / SPL (PER DEVICE) ----------
def calib_rows(c, device):
    """Calibration points for THIS device only (no cross-device fallback)."""
    return c.execute("SELECT volume,slope,offset FROM calib WHERE device=? ORDER BY volume",
                     (device,)).fetchall()

def to_spl(dbfs, volume, rows):
    """Estimate SPL from measured dBFS + volume using nearest-volume calibration
    for the device. Volume adjusted assuming ~dB-linear control (approx for BT).
    Returns None if the device has no calibration."""
    if not rows or dbfs is None or dbfs <= -119:
        return None
    v, slope, off = min(rows, key=lambda r: abs(r[0]-volume))
    spl = slope*dbfs + off
    if volume > 0 and v > 0:
        spl += 20*math.log10(volume/v)
    return spl

# ---------- exposure math (NIOSH: 85 dB / 8 h / 3 dB exchange) ----------
def allowed_hours(L, ref=85.0, ref_h=8.0, exch=3.0):
    return ref_h * (2.0 ** ((ref - L)/exch))

# ---------- commands ----------
def cmd_daemon(args):
    c = conn()
    print("dbmon daemon started", flush=True)
    while True:
        s = default_sink()
        if not s:
            time.sleep(3); continue
        sid, name, desc, vol = s
        upsert_device(c, name, desc); c.commit()   # log ALL devices, always
        res = capture(sid, CHUNK)
        if res is None:
            time.sleep(1); continue
        rms, peak = res
        if rms > LOG_ABOVE:
            c.execute("INSERT INTO samples(ts,device,rms,peak,volume,dur) VALUES(?,?,?,?,?,?)",
                      (time.time(), name, rms, peak, vol, CHUNK))
            c.commit()

def cmd_live(args):
    c = conn()
    cap = get_cap(c)
    try:
        while True:
            s = default_sink()
            if not s:
                print("no default sink", end="\r"); time.sleep(1); continue
            sid, name, desc, vol = s
            upsert_device(c, name, desc); c.commit()
            wl = whitelist_set(c)
            res = capture(sid, 1.0)
            if res:
                rms, peak = res
                rows = calib_rows(c, name)
                spl = to_spl(rms, vol, rows); pspl = to_spl(peak, vol, rows)
                flags = ("" if rows else " [UNCALIBRATED]") + ("" if name in wl or not wl else " [not-whitelisted]")
                over = "  !! OVER %g dB" % cap if (spl is not None and spl > cap) else ""
                if rms <= LOG_ABOVE:
                    print(f"{desc[:22]:22} {vol*100:3.0f}%   (silent){flags}                ", end="\r")
                elif spl is None:
                    print(f"{desc[:22]:22} {vol*100:3.0f}%   RMS {rms:6.1f}dBFS{flags}   ", end="\r")
                else:
                    print(f"{desc[:22]:22} {vol*100:3.0f}%   RMS {rms:6.1f}dBFS  ~{spl:5.1f} dB SPL  (peak ~{pspl:5.1f}){over}{flags}   ", end="\r")
            sys.stdout.flush()
    except KeyboardInterrupt:
        print()

def cmd_calibrate(args):
    c = conn()
    s = default_sink()
    if not s:
        print("No default sink. Set the device you want to calibrate as the system output first."); return
    sid, name, desc, vol = s
    upsert_device(c, name, desc); c.commit()
    print(f"Calibrating device: {desc}  ({name})  @ volume {vol*100:.0f}%")
    print("Switch your SYSTEM OUTPUT to the device you want first, keep volume fixed.")
    print("For each tone: read your SPL meter at the ear cup, type the dB value (blank=skip).\n")
    tdir = os.path.expanduser("~/cal-tones")
    tones = sorted([f for f in os.listdir(tdir) if f.endswith(".wav")]) if os.path.isdir(tdir) else []
    if not tones:
        print("No tones in ~/cal-tones. Generate with:")
        print("  mkdir -p ~/cal-tones; for l in 6 12 18; do sox -n -r48000 -c2 ~/cal-tones/tone_-${l}dBFS.wav synth 25 sine 1000 gain -$l; done")
        return
    pts = []
    for t in tones:
        path = os.path.join(tdir, t)
        p = subprocess.Popen(["bash","-c", f"while true; do pw-play '{path}'; done"])
        time.sleep(0.6)
        res = capture(sid, 1.5)
        p.terminate(); subprocess.run(["pkill","-f","pw-play"], capture_output=True)
        if not res: continue
        rms, _ = res
        try:
            v = input(f"  {t}: measured RMS {rms:.2f} dBFS -> enter SPL dB: ").strip()
        except EOFError:
            v = ""
        if v:
            pts.append((rms, float(v)))
    if len(pts) < 2:
        print("Need >=2 points to fit a line."); return
    n=len(pts); sx=sum(x for x,_ in pts); sy=sum(y for _,y in pts)
    sxx=sum(x*x for x,_ in pts); sxy=sum(x*y for x,y in pts)
    slope=(n*sxy-sx*sy)/(n*sxx-sx*sx); off=(sy-slope*sx)/n
    c.execute("INSERT OR REPLACE INTO calib VALUES(?,?,?,?,?,?)",
              (name, round(vol,3), slope, off, "C", time.time()))
    c.commit()
    print(f"\nStored calibration for {desc} @ {vol*100:.0f}%:  SPL = {slope:.3f}*dBFS + {off:.1f}")
    print("History for this device now re-derives with this curve.")

def cmd_cap(args):
    c = conn()
    if args.value is not None:
        set_setting(c, "cap_db", args.value)
        print(f"Loudness cap set to {args.value:g} dB. Reports show time above it; live warns when exceeded.")
    else:
        print(f"Current loudness cap: {get_cap(c):g} dB   (set with: dbmon cap <dB>)")

def cmd_whitelist(args):
    c = conn()
    if args.action in ("add","rm"):
        val = 1 if args.action=="add" else 0
        cur = c.execute("UPDATE devices SET whitelisted=? WHERE name LIKE ? OR label LIKE ?",
                        (val, f"%{args.match}%", f"%{args.match}%"))
        if cur.rowcount==0 and args.action=="add":
            c.execute("INSERT OR IGNORE INTO devices(name,label,last_seen,whitelisted) VALUES(?,?,?,1)",
                      (args.match,args.match,time.time()))
            rc=1
        else:
            rc=cur.rowcount
        c.commit()
        print(f"{'whitelisted' if val else 'removed from whitelist'}: {rc} device(s) matching '{args.match}'")
    print(f"\n{'device':30} {'node':34} whitelisted")
    for name,label,wl in c.execute("SELECT name,label,whitelisted FROM devices ORDER BY whitelisted DESC,label"):
        print(f"{(label or name)[:30]:30} {name[:34]:34} {'YES' if wl else 'no'}")

def cmd_addcalib(args):
    c = conn()
    c.execute("INSERT OR REPLACE INTO calib VALUES(?,?,?,?,?,?)",
              (args.device, args.volume, args.slope, args.offset, args.weighting, time.time()))
    c.commit(); print("calibration stored.")

def cmd_showcalib(args):
    c = conn()
    print(f"{'device (label)':28} {'node':34} {'vol%':>5} {'slope':>7} {'offset':>7} wt")
    for d,v,sl,of,wt,ts in c.execute("SELECT * FROM calib ORDER BY device,volume"):
        print(f"{device_label(c,d)[:28]:28} {d[:34]:34} {v*100:5.0f} {sl:7.3f} {of:7.1f}  {wt}")

def cmd_devices(args):
    c = conn()
    print(f"{'device':28} {'last seen':17} {'listening':>9}  {'calib':6} whitelist")
    for name,label,last,wl in c.execute("SELECT name,label,last_seen,whitelisted FROM devices ORDER BY last_seen DESC"):
        dur = c.execute("SELECT COALESCE(SUM(dur),0) FROM samples WHERE device=?", (name,)).fetchone()[0]
        cal = c.execute("SELECT COUNT(*) FROM calib WHERE device=?", (name,)).fetchone()[0]
        ls = datetime.fromtimestamp(last).strftime("%Y-%m-%d %H:%M") if last else "-"
        print(f"{(label or name)[:28]:28} {ls:17} {dur/3600:6.2f} h  "
              f"{('yes' if cal else 'NO'):6} {'YES' if wl else 'no'}")

def cmd_report(args):
    c = conn()
    cap = get_cap(c)
    now = time.time(); since = now - args.days*86400
    q = "SELECT ts,device,rms,peak,volume,dur FROM samples WHERE ts>=?"
    params = [since]
    if args.device:
        q += " AND device LIKE ?"; params.append(f"%{args.device}%")
    rows = c.execute(q+" ORDER BY ts", params).fetchall()
    if not rows:
        print(f"No listening data in the last {args.days} day(s). Is the daemon running? (systemctl --user status dbmon)"); return
    wl = whitelist_set(c)
    only_wl = (args.whitelisted or bool(wl)) and not args.all
    cal_cache = {}
    def rows_for(dev):
        if dev not in cal_cache: cal_cache[dev]=calib_rows(c,dev)
        return cal_cache[dev]
    dev_stats={}; day_stats={}; overall_max=(-999,None,None)
    tot_dur=0.0; energy=0.0; uncal_dur=0.0; excluded_dur=0.0; tot_over=0.0
    for ts,dev,rms,peak,vol,dur in rows:
        if only_wl and dev not in wl:
            excluded_dur+=dur; continue
        D=dev_stats.setdefault(dev,{"dur":0.0,"energy":0.0,"max":-999,"dose":0.0,"over":0.0,"cal":bool(rows_for(dev))})
        D["dur"]+=dur
        spl=to_spl(rms,vol,rows_for(dev)); pspl=to_spl(peak,vol,rows_for(dev))
        if spl is None:
            uncal_dur+=dur; continue
        D["energy"]+=dur*(10**(spl/10)); D["dose"]+=100*(dur/3600)/allowed_hours(spl)
        if spl>cap: D["over"]+=dur; tot_over+=dur
        if pspl>D["max"]: D["max"]=pspl
        day=datetime.fromtimestamp(ts).strftime("%Y-%m-%d")
        S=day_stats.setdefault(day,{"dur":0.0,"energy":0.0,"max":-999,"dose":0.0,"over":0.0})
        S["dur"]+=dur; S["energy"]+=dur*(10**(spl/10)); S["dose"]+=100*(dur/3600)/allowed_hours(spl)
        if spl>cap: S["over"]+=dur
        if pspl>S["max"]: S["max"]=pspl
        tot_dur+=dur; energy+=dur*(10**(spl/10))
        if pspl>overall_max[0]: overall_max=(pspl,day,datetime.fromtimestamp(ts).strftime("%H:%M"))
    leq=lambda en,du: 10*math.log10(en/du) if du>0 else 0.0
    ocol = f">{cap:g}dB"

    scope = "whitelisted devices only" if only_wl else "ALL devices"
    print(f"\n=== Audio exposure - last {args.days} day(s) - {scope} ===")
    if only_wl: print("(use --all to include non-whitelisted devices)")
    print(f"\n-- by device --")
    print(f"{'device':24} {'listen':>8} {'Leq':>6} {'max dB':>7} {ocol:>8} {'dose%':>6}  calib")
    for dev,D in sorted(dev_stats.items(), key=lambda kv:-kv[1]['dur']):
        lbl=device_label(c,dev)[:24]
        if D["cal"]:
            print(f"{lbl:24} {D['dur']/3600:6.2f} h {leq(D['energy'],D['dur']):6.1f} {D['max']:7.1f} {D['over']/3600:6.2f} h {D['dose']:6.0f}  yes")
        else:
            print(f"{lbl:24} {D['dur']/3600:6.2f} h {'--':>6} {'--':>7} {'--':>8} {'--':>6}  NO (calibrate)")

    if day_stats:
        print(f"\n-- by day (calibrated devices) --")
        print(f"{'date':11} {'listen':>8} {'Leq':>6} {'max dB':>7} {ocol:>8} {'dose%':>6}")
        for day in sorted(day_stats):
            S=day_stats[day]
            print(f"{day:11} {S['dur']/3600:6.2f} h {leq(S['energy'],S['dur']):6.1f} {S['max']:7.1f} {S['over']/3600:6.2f} h {S['dose']:6.0f}")

    print("-"*58)
    print(f"TOTAL (calibrated): {tot_dur/3600:.2f} h   Leq {leq(energy,tot_dur):.1f} dB   worst-case peak {overall_max[0]:.1f} dB")
    if overall_max[1]:
        print(f"Worst-case peak: {overall_max[0]:.1f} dB on {overall_max[1]} at {overall_max[2]}")
    if tot_dur>0:
        print(f"Over cap ({cap:g} dB): {tot_over/3600:.2f} h  ({100*tot_over/tot_dur:.0f}% of listening)")
    if uncal_dur>0:
        print(f"Uncalibrated listening (no SPL): {uncal_dur/3600:.2f} h  -> run 'dbmon calibrate' with that device active")
    if excluded_dur>0:
        print(f"Excluded (non-whitelisted): {excluded_dur/3600:.2f} h")
    print(f"\nCap = your personal loudness limit ({cap:g} dB), set with 'dbmon cap <dB>'.")
    print("Dose = % of NIOSH daily safe limit (85 dB / 8 h, 3 dB exchange); 100% = a full")
    print("day's safe dose. SPL is C-weighted & headphone-estimated (ballpark).")

def main():
    ap=argparse.ArgumentParser(prog="dbmon",description="per-device audio-exposure monitor")
    sub=ap.add_subparsers(dest="cmd",required=True)
    sub.add_parser("daemon").set_defaults(f=cmd_daemon)
    sub.add_parser("live").set_defaults(f=cmd_live)
    sub.add_parser("calibrate").set_defaults(f=cmd_calibrate)
    sub.add_parser("showcalib").set_defaults(f=cmd_showcalib)
    sub.add_parser("devices").set_defaults(f=cmd_devices)
    w=sub.add_parser("whitelist")
    w.add_argument("action",nargs="?",choices=["add","rm","list"],default="list")
    w.add_argument("match",nargs="?",default="")
    w.set_defaults(f=cmd_whitelist)
    cp=sub.add_parser("cap"); cp.add_argument("value",nargs="?",type=float,default=None)
    cp.set_defaults(f=cmd_cap)
    r=sub.add_parser("report"); r.add_argument("--days",type=int,default=7)
    r.add_argument("--device",help="filter by device name substring")
    r.add_argument("--whitelisted",action="store_true",help="only whitelisted devices")
    r.add_argument("--all",action="store_true",help="include non-whitelisted devices")
    r.set_defaults(f=cmd_report)
    a=sub.add_parser("addcalib")
    a.add_argument("--device",required=True); a.add_argument("--volume",type=float,required=True)
    a.add_argument("--slope",type=float,required=True); a.add_argument("--offset",type=float,required=True)
    a.add_argument("--weighting",default="C"); a.set_defaults(f=cmd_addcalib)
    args=ap.parse_args(); args.f(args)

if __name__=="__main__":
    main()
