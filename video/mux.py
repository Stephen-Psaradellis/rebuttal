"""Lay each narration clip at its scene's start and mux with the screen recording.

    python mux.py out/ [--mode demo|sandbox]   ->  out/rebuttal-demo.mp4
The first frames (page load) are trimmed: output starts 0.4s before scene 1. A scene
that overran its clip by more than CUT_OVER seconds has the quiet middle of that wait
cut, keeping KEEP seconds each side. A disclosure line sits on the first 7 seconds.
Adapted from Owed's video/mux.py (github.com/Stephen-Psaradellis/owed).
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

import imageio_ffmpeg

ap = argparse.ArgumentParser()
ap.add_argument("out", nargs="?", type=Path, default=Path(__file__).with_name("out"))
ap.add_argument("--mode", choices=["demo", "sandbox"], default="demo")
a = ap.parse_args()
out = a.out
cfg = json.loads(Path(__file__).with_name("scenes.json").read_text(encoding="utf-8"))
tl = json.loads((out / "timeline.json").read_text(encoding="utf-8"))
ids = [s["id"] for s in cfg["scenes"]]
lengths = json.loads((out / "lengths.json").read_text(encoding="utf-8"))
CUT_OVER, KEEP = 6.0, 2.5
FONT = "C\\:/Windows/Fonts/segoeui.ttf"
NOTE = {"demo": "Demo data (fictional store), dry run - nothing sent. Synthetic voice. Built by Claude (AI).",
        "sandbox": "Airwallex sandbox, fictional store. Synthetic voice. Built by Claude (AI)."}[a.mode]
lead = max(0.0, tl[ids[0]] - 0.4)
cuts = []
for i, nxt in zip(ids, ids[1:] + ["_end"]):
    if tl.get(f"{i}_overrun_s", 0) > CUT_OVER:
        s, e = tl[i] + lengths[i] + KEEP - lead, tl[nxt] - KEEP - lead
        if e - s > 1:
            cuts.append((s, e))
shift = lambda t: t - sum(e - s for s, e in cuts if e <= t)
end = shift(tl["_end"] - lead)

cmd = [imageio_ffmpeg.get_ffmpeg_exe(), "-y", "-ss", f"{lead:.3f}", "-i", str(out / "screen.webm")]
for i in ids:
    cmd += ["-i", str(out / f"{i}.mp3")]
parts, labels = [], []
for n, i in enumerate(ids, start=1):
    ms = int(round((shift(tl[i] - lead) + 0.25) * 1000))
    parts.append(f"[{n}:a]adelay={ms}|{ms}[a{n}]")
    labels.append(f"[a{n}]")
parts.append(f"{''.join(labels)}amix=inputs={len(ids)}:normalize=0,apad[aout]")
sel = f"select='not({'+'.join(f'between(t,{s:.3f},{e:.3f})' for s, e in cuts)})',setpts=N/30/TB," if cuts else ""
parts.append(f"[0:v]fps=30,{sel}drawtext=fontfile='{FONT}':text='{NOTE}':fontcolor=white@0.9:fontsize=20:"
             f"box=1:boxcolor=black@0.55:boxborderw=8:x=20:y=h-44:enable='lt(t,7)'[vout]")
cmd += ["-filter_complex", ";".join(parts), "-map", "[vout]", "-map", "[aout]",
        "-t", f"{min(end, 299.0):.3f}", "-c:v", "libx264", "-preset", "medium", "-crf", "20",
        "-pix_fmt", "yuv420p", "-r", "30", "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart",
        str(out / "rebuttal-demo.mp4")]
r = subprocess.run(cmd, capture_output=True, text=True)
if r.returncode:
    sys.exit(r.stderr[-2000:])
print(json.dumps({"mp4": str(out / "rebuttal-demo.mp4"), "seconds": round(min(end, 299.0), 1),
                  "cut_s": round(sum(e - s for s, e in cuts), 1)}))
