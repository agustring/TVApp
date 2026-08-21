# TVApp

**Full name: TuViejapp.** "TVApp" is the short name shown on the TV launcher;
"TuViejapp" is the full name, and it is also the Tizen application id
(`TuVieja001.TuViejapp`), which is the install identity on the TV and therefore
stays as it is.

A Tizen Web Application for Samsung Smart TVs that plays video from a folder on
your own machine, over your local network. It shows a Netflix-style browsable
grid, previews the focused item, and plays through the TV's native **AVPlay**
pipeline so that MKV, AVI and other containers the browser cannot decode still
work.

It can also open an arbitrary HLS or DASH streaming URL.

---

## Features

- **Browsable grid** of folders and videos, navigated with the TV remote.
- **Focused-card preview** — the highlighted item plays a muted inline clip.
- **AVPlay playback** — MP4, MKV, AVI, MOV, M4V, WEBM, TS.
- **Custom player overlay** — play/pause, seek bar, ±10s skip, buffering
  indicator, auto-hide after a few seconds of inactivity.
- **Smart folder filtering** — folders that contain no real video are hidden, so
  a library sitting next to unrelated directories stays clean.
- **Streaming URLs** — play any clear HLS (`.m3u8`) or DASH (`.mpd`) stream.

---

## Requirements

| | |
|---|---|
| TV | Samsung Smart TV with Tizen 5.0 or newer, in Developer Mode |
| PC | Windows, on the **same network** as the TV |
| PC video server | `video-server.bat` uses Windows PowerShell, already included with Windows; no Node.js or npm installation is needed |
| Tizen tooling | [Tizen Studio](https://developer.tizen.org/development/tizen-studio/download) **or** the VS Code Tizen extension |

The app is signed with the **default Tizen certificates**, which a TV accepts
while it is in Developer Mode. You do **not** need a Samsung account
certificate for personal sideloading.

---

## Repository layout

```
config.xml           Tizen manifest: privileges, 1920x1080 viewport
index.html           The three views (grid / streaming URL / player)
js/main.js           All application logic
css/style.css        Styling
icon.png             512x512 launcher icon
video-server.bat      Zero-install local HTTP video server (single Windows file)
video-server.config   Folder and port settings read by the batch launcher
video-server.js       Optional Node.js version for development
deploy-tv.bat         Double-click build, install and launch helper
deploy-tv.config      TV IP and deployment settings
deploy.ps1           Build + install + launch helper (PowerShell)
```

---

## Setup

### 1. Enable Developer Mode on the TV

1. Open **Apps**, then press `1 2 3 4 5` on the remote.
2. Set **Developer mode** to **On**.
3. Enter the **IP address of your PC**.
4. Restart the TV.

### 2. Serve your video folder

For the simplest setup, copy `video-server.bat` and `video-server.config` to the
Windows PC. Edit `video-server.config` before starting:

```ini
root=D:\Movies
port=8001
```

Then double-click `video-server.bat`. It uses Windows PowerShell, which is built
into Windows, and does not require Node.js, npm, or any other installation. If
`root=` is left blank, it serves the folder containing the batch file.

You can also start it from Command Prompt with an explicit folder and port:

```bat
video-server.bat "D:\Movies" 8001
```

Leave the window open while you use the app. Press `Ctrl+C` to stop the server.

The original Node.js server remains available for development:

```powershell
node video-server.js "D:\Movies" 8001
```

The first argument is the folder to serve and the second is the port. Both are
optional, but **the defaults in `video-server.js` are specific to the original
author's machine, so pass your own folder** (or edit `ROOT` near the top of the
file).

Avoid port 8000 if you run XAMPP/Apache — it is commonly taken.

Leave this running while you use the app.

### 3. Point the app at your PC

Edit `SERVER_URL` near the top of `js/main.js`:

```js
var SERVER_URL = 'http://192.168.1.50:8001/';   // your PC's LAN IP, trailing slash required
```

Find your IP with `ipconfig`. It must be the address on the same subnet as the
TV — not `127.0.0.1`, and not a VPN adapter.

### 4. Build and deploy

For a double-click workflow, edit `deploy-tv.config` and set `tv_ip` to the
address entered in the TV's Developer Mode. Then double-click `deploy-tv.bat`.
It builds, packages, connects, installs, and launches the app. Tizen Studio or
the VS Code Tizen extension must already be installed; the launcher can detect
the tools automatically, or you can set `tizen_tools` in the config file.

Set `no_build=true` when only an existing `Debug\TVApp.wgt` should be installed.

```powershell
.\deploy.ps1 -TvIp 192.168.1.154
```

To avoid retyping the address, set it once:

```powershell
$env:TVAPP_TV_IP = "192.168.1.154"
.\deploy.ps1
```

Other options:

```powershell
.\deploy.ps1 -NoBuild                            # reinstall existing package
.\deploy.ps1 -TizenTools "C:\tizen-studio\tools" # if auto-detection fails
```

The script locates the Tizen tools automatically, builds and signs the `.wgt`,
pushes it to the TV, installs and launches it.

> **Why not `tz install`?** Retail TVs report `secure_protocol:enabled` and
> refuse arbitrary `sdb shell` commands with `closed`. `tz install` first runs
> `sdb shell 0 vd_appuninstall`, so it fails once the app is already installed.
> `deploy.ps1` pushes the package and calls `vd_appinstall` directly, which
> upgrades in place.

You can also import the folder into Tizen Studio (**File → Import → Tizen →
Tizen Project**) and build from there.

---

## Using the app

### Grid

| Key | Action |
|---|---|
| Arrows | Move selection |
| OK / Enter | Open folder, or play video |
| RETURN (Back) | Up one folder; exits the app at the top level |

### Player

| Key | Action |
|---|---|
| OK / Enter | Play / pause |
| Left / Right | Seek 10 seconds |
| RETURN (Back) | Stop and return to the grid |

Media transport buttons (▶/⏸/⏹/⏪/⏩) also work. The overlay hides after about
four seconds and reappears on any keypress; it stays visible while paused.

### Streaming URLs

The first card in the grid root opens the streaming view. Type a URL — focusing
the field raises the TV's on-screen keyboard — or pick one of the bundled public
test streams.

> **DRM is out of scope.** YouTube, Netflix, Disney+ and Prime Video are
> protected by Widevine/PlayReady and cannot be played by pasting a URL. AVPlay
> supports DRM, but that needs a licence-server handshake, the `drmplay`
> privilege, and an agreement with the content owner.

---

## How folder filtering works

The server decides what the TV is allowed to see, using two rules:

1. A folder is listed only if it contains a playable video **at some depth**
   (up to 8 levels, memoised for 30 seconds).
2. That video must be at least `MIN_MEDIA_BYTES` (**20 MB** by default).

Rule 2 exists because installers and application folders often ship tiny
promotional clips, which would otherwise make an unrelated folder appear in your
library. The size floor gates *folder visibility* only — once you open a folder,
every video in it is listed regardless of size.

Hidden entries (names starting with `.`) and symlinked directories are skipped.

---

## Troubleshooting

**"Could not reach http://…" on the grid**
The server is not running, the IP in `SERVER_URL` is wrong or has changed
(DHCP), or Windows Firewall is blocking Node. Allow `node.exe` on the
**Private *and* Public** profiles — home Wi-Fi is often classified Public.
Confirm from another device: `http://<pc-ip>:8001/` should return a file list.

**`deploy.ps1` says the TV is not reachable**
The TV is off or asleep, dropped off Wi-Fi, or Developer Mode was reset (it
sometimes clears after a firmware update). Re-enable it and confirm the PC IP is
still listed.

**Commands return `closed`**
The sdb link has gone stale. It can report *already connected* while every
command fails. Reset it:

```powershell
sdb kill-server; sdb start-server; sdb connect <tv-ip>
```

**The app does not pick up code changes**
Reinstalling is what forces a fresh start. `was_kill` is rejected on retail
firmware, and launching an already-running app only *resumes* it without
re-running `window.onload`. Just run `deploy.ps1` again.

**A video plays audio over a black screen**
AVPlay draws on a hardware plane *behind* the browser surface, so any opaque
pixel hides it. The app makes `<body>` transparent while the player is open; if
you add CSS that paints an opaque background over the player view, you will see
this.

**A card shows a placeholder instead of a preview**
Expected for containers the browser cannot decode (MKV, AVI). Fullscreen
playback still works, because that path uses AVPlay rather than `<video>`.

---

## Design notes

**Two players, deliberately.** AVPlay is a single hardware decoder instance, so
it cannot preview and play at once. Grid previews therefore use one shared HTML5
`<video>` element that is moved into the focused card; giving every card its own
element would exhaust the TV's decoders. Previews are debounced (700 ms) so
holding an arrow key does not thrash the decoder.

**Seeking needs HTTP Range.** AVPlay issues a fresh ranged `GET` for every seek.
`video-server.js` implements Range (including a correct `416` for unsatisfiable
requests) — note that Python's `http.server` does *not*, which is why it is a
poor substitute here.

---

## Licence

Created by Agustin Copita in 2026 for the exclusive use of Agustin Copita.
© 2026 Agustin Copita. All rights reserved.

This project is **not** open source. No permission is granted to use, copy,
modify or distribute it without the express written consent of the author.

---

## Development notes

Built with an LLM-assisted workflow (Claude Code). The agent scaffolded the app
and tooling; the hardware-boundary problems were mine to debug on the physical
TV.

- Agent-drafted the grid UI, player overlay, and initial deploy script.
- I diagnosed the parts an agent can't reach without the device: the AVPlay
  hardware-plane / transparent-body issue, the retail `secure_protocol` refusal
  that broke `tz install` (fixed via direct `vd_appinstall`), and the HTTP Range
  server needed for AVPlay seeking.

Result: a working sideloaded TV app, with the hardware/firmware-boundary bugs
resolved through log- and trace-driven debugging on real hardware.
