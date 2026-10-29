"""Cuts a recording into the narrated walkthrough: python3 edit.py <take dir> <out.mp4>

Per step: plays at real speed, speeds up the logged waits (agent working) with a label, and
holds the last frame when the narration runs longer than the step. Audio: narrator clips at
each step's start, the browser's audio (Ava) and the caller's lines at their real moments.
"""
import glob, json, subprocess, sys

take, out = sys.argv[1], sys.argv[2]
ev = json.load(open(f'{take}/events.json'))
t0 = next(e['t'] for e in ev if e['type'] == 'video-start')
sec = lambda e: (e['t'] - t0) / 1000
dur = lambda f: float(subprocess.check_output(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f]))

NARRATION = {'cases': ['intro', 'cases'], 'home': ['home', 'outro'], 'approvals': ['approvals'], 'memory': ['memory'],
             'voice': ['voice'], 'improvements': ['improvements'], 'onboarding': ['onboarding'], 'safety': ['safety']}
GAP = 0.6       # between two narrator clips
TAIL = 1.5      # after the narration before the next step
FONT = '/usr/share/fonts/liberation/LiberationSans-Bold.ttf'

steps, cur = [], None
for e in ev:
    if e['type'] == 'step': cur = {'name': e['name'], 's': sec(e), 'waits': []}
    elif e['type'] == 'wait-start': cur['waits'].append([sec(e), None])
    elif e['type'] == 'wait-end': cur['waits'][-1][1] = sec(e)
    elif e['type'] == 'step-end': cur['e'] = sec(e); steps.append(cur)

segments = []      # (src_start, src_end, speed, label, pad_after)
mapping = []       # (src_start, src_end, out_start, speed) to place real-time audio
audio = []         # (file, out_time)
t_out = 0.0
for st in steps:
    clips = [f'clips/narrator-{n}.wav' for n in NARRATION.get(st['name'], [])]
    need = sum(dur(c) for c in clips) + GAP * max(0, len(clips) - 1) + TAIL
    at = t_out
    for c in clips:
        audio.append((c, at)); at += dur(c) + GAP
    parts, pos = [], st['s']
    for ws, we in st['waits']:
        parts.append([pos, ws, 1]); parts.append([ws, we, 'wait']); pos = we
    parts.append([pos, st['e'], 1])
    plain = sum(b - a for a, b, k in parts if k == 1)
    waits = sum(b - a for a, b, k in parts if k == 'wait')
    wait_out = max(4.0, need - plain) if waits else 0
    speed = max(1.0, waits / wait_out) if waits else 1
    seg_out = 0.0
    for a, b, k in parts:
        if b - a < 0.05: continue
        k = speed if k == 'wait' else 1
        label = f'Sped up {round(k)}x' if k > 1.5 else ''
        if k < 1.5: k = 1
        segments.append([a, b, k, label, 0.0])
        mapping.append((a, b, t_out + seg_out, k))
        seg_out += (b - a) / k
    if seg_out < need:
        segments[-1][4] = need - seg_out
        seg_out = need
    print(f"{st['name']:13} src {st['e'] - st['s']:6.1f}s  waits {waits:6.1f}s x{speed:4.1f}  out {seg_out:6.1f}s  narration {need:5.1f}s")
    t_out += seg_out

def to_out(t):
    for a, b, o, k in mapping:
        if a - 0.01 <= t <= b + 0.01: return o + (t - a) / k
    raise ValueError(t)

# Ava (browser audio) only during the call, at real speed; the caller's lines where they were played.
for e in ev:
    if e['type'] == 'say': audio.append((f"clips/caller-{e['clip']}.wav", to_out((e['at'] - t0) / 1000)))
call = [sec(e) for e in ev if e['type'] in ('call-start', 'step-end') and (e['type'] == 'call-start' or e.get('name') == 'voice')]
browser = glob.glob(f'{take}/browser-audio.*')
rec_at = next((e['startedAt'] for e in ev if e['type'] == 'audio'), None)

video = [f for f in glob.glob(f'{take}/*.webm') if 'browser-audio' not in f][0]
inputs = ['-i', video]
fc = []
for i, (a, b, k, label, pad) in enumerate(segments):
    f = f'[0:v]trim=start={a:.3f}:end={b:.3f},setpts=(PTS-STARTPTS)/{k},fps=30'
    if label:
        f += f",drawtext=fontfile={FONT}:text='{label}':x=w-tw-28:y=24:fontsize=22:fontcolor=white:box=1:boxcolor=0x111827CC:boxborderw=10"
    if pad > 0: f += f',tpad=stop_mode=clone:stop_duration={pad:.3f}'
    fc.append(f + f'[v{i}]')
fc.append(''.join(f'[v{i}]' for i in range(len(segments))) + f'concat=n={len(segments)}:v=1:a=0[v]')
mix = []
for j, (f, at) in enumerate(audio):
    inputs += ['-i', f]
    fc.append(f'[{j + 1}:a]aresample=48000,aformat=channel_layouts=stereo,loudnorm=I=-17:TP=-1.5,adelay={int(at * 1000)}:all=1[a{j}]')
    mix.append(f'[a{j}]')
if browser and len(call) == 2 and rec_at:
    off = (rec_at - t0) / 1000
    a, b = call[0] - 0.5, call[1]
    inputs += ['-i', browser[0]]
    n = len(audio) + 1
    fc.append(f'[{n}:a]atrim=start={a - off:.3f}:end={b - off:.3f},asetpts=PTS-STARTPTS,aresample=48000,aformat=channel_layouts=stereo,loudnorm=I=-17:TP=-1.5,adelay={int(to_out(a) * 1000)}:all=1[ava]')
    mix.append('[ava]')
fc.append(''.join(mix) + f'amix=inputs={len(mix)}:normalize=0:duration=longest,apad,atrim=end={t_out:.3f}[a]')
subprocess.check_call(['ffmpeg', '-v', 'error', '-y', *inputs, '-filter_complex', ';'.join(fc), '-map', '[v]', '-map', '[a]',
                       '-c:v', 'libx264', '-preset', 'medium', '-crf', '22', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '160k',
                       '-movflags', '+faststart', '-t', f'{t_out:.3f}', out])
print(f'{out}: {t_out:.1f}s')
