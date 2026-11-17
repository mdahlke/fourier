# Fourier Draw

Draw anything and watch a chain of spinning arrows (a Fourier series / epicycles) trace it.

- Draw freehand with mouse, pen or finger (multiple strokes get joined into one loop)
- Presets (dinosaur, heart, star, square, …) and SVG import (upload a file or paste a path `d`)
- Adjust the number of circles (1–2048), speed and zoom; the camera can follow the pen
- "Build up" mode adds circles each loop so you can see the approximation improve
- **3D mode** (button or `3` key), loaded only when used:
  - **Time ribbon**: your 2D shape with time as depth; floor shows x(t), side wall shows y(t)
  - **Draw on the floor & wall**: sketch x(t) on the floor and y(t) on the wall separately and watch the 2D shape they make, then animate it
  - **3D curve**: real 3D closed curves drawn by spinning *tilted ellipses* — presets (trefoil, torus
    knot, coil, sphere figure-8, baseball seam, Lissajous), "make your drawing 3D" (wave, cylinder,
    sphere, saddle), or import your own `x y z` points
  - drag to orbit, same circles/speed/zoom/dive controls as 2D

Plain HTML/CSS/JS in `public/`, no build step. The only library is [three.js](https://threejs.org)
r170 (MIT) for the 3D view, vendored in `public/vendor/three/` — no CDNs, so the strict CSP stays intact.

## Run locally

```sh
docker compose up -d          # http://localhost:8080  (PORT=3000 docker compose up -d to change)
docker compose down
```

`docker-compose.override.yml` adds the local port and mounts `public/` into the container, so edits
show up on browser refresh without rebuilding.
Without Docker: `cd public && python3 -m http.server 8080`.

## Deploy on Coolify

1. Push this repo to GitHub.
2. In Coolify: **New Resource → Private Repository (GitHub App or deploy key)**, pick the repo.
3. Build pack: **Docker Compose** (uses `docker-compose.yml`, which includes the hardening settings).
   *The Dockerfile build pack also works, but skips the read-only filesystem / dropped capabilities.*
4. Set the `fourier` service domain to `https://fourier.checkoutthisfuckingthing.com` (container port 80).
5. Deploy. `docker-compose.override.yml` (local port + live-edit mount) is ignored by Coolify.

## Analytics (self-hosted Umami)

Visitor stats come from [Umami](https://umami.is), running as its own Coolify service with its own
login-protected dashboard. It is cookieless and does not store IP addresses, so no cookie banner is needed.

**Set up once:**

1. Coolify → your project → **+ New → Service → Umami**. Set its domain, e.g.
   `https://stats.checkoutthisfuckingthing.com:3000` (the `:3000` tells Coolify the container port). Deploy.
2. Open the stats domain and log in with the default **`admin` / `umami`**, then **immediately** go to
   *Settings → Profile* and change the password to a long random one (password manager).
3. *Settings → Websites → Add website*: name "Fourier", domain `fourier.checkoutthisfuckingthing.com`.
   Copy the **Website ID**.
4. In the Fourier app → **Environment Variables**, set:

   | Variable | Value |
   |---|---|
   | `UMAMI_HOST` | `https://stats.checkoutthisfuckingthing.com` (no trailing slash) |
   | `UMAMI_WEBSITE_ID` | the ID from step 3 |
   | `UMAMI_DOMAINS` | `fourier.checkoutthisfuckingthing.com` (only count the real site) |
   | `UMAMI_SCRIPT_NAME` | optional; `script.js` unless you rename it in Umami via `TRACKER_SCRIPT_NAME` |

5. Redeploy the Fourier app. The CSP automatically allows that analytics host and nothing else.

Leave the variables empty and analytics is completely off (that's the default for local runs).

**What you'll see:** visitors, page views, referrers, countries, browsers/devices, plus custom events
(Umami → Websites → Fourier → Events; click an event to break it down by its properties).
Drawings themselves are never sent.

| Event | When | Properties |
|---|---|---|
| `first-stroke` | visitor starts drawing (once per visit) — *did they try it at all?* | `input` (mouse/touch/pen) |
| `draw` | their drawing gets animated | `strokes`, `via` (auto/button/key), `count` (nth drawing this visit) |
| `replay` | Animate pressed on the current shape | `via` |
| `new-drawing` / `undo` | cleared the canvas / undid a stroke (undo once per visit) | — |
| `preset` | picked a preset | `name` |
| `svg-import` / `svg-import-failed` | imported an SVG / it failed | `source` (file/paste), `reason` |
| `circles` | settled on a circle count (debounced) | `count` (bucket) |
| `speed` | settled on a speed (debounced) | `secondsPerLoop` |
| `zoom` | finished zooming manually (debounced) | `level` (power of 10), `via` (wheel/slider/keys) |
| `dive` / `zoom-reset` | dove to the smallest circle / zoomed back out | `via`, `circles`, `depth` |
| `pause` | paused the animation | `via` (button/key) |
| `toggle` | changed a checkbox | `option`, `on` |
| `shortcut` | first use of each keyboard shortcut per visit | `key` |
| `panel` | opened/closed the controls panel | `open`, `screen` (wide/narrow) |
| `save-png` | saved an image | `mode`, `zoomed` |
| `view` | switched between 2D and 3D | `mode` |
| `3d-source` | switched time ribbon ↔ 3D curve | `source` |
| `3d-preset` / `3d-from-drawing` | picked a 3D shape / turned their drawing into 3D | `name` / `kind` |
| `3d-import` / `3d-import-failed` | imported 3D points / it failed | `points` (bucket) / `reason` |
| `3d-wave-draw` / `3d-wave-shape` | opened floor & wall drawing / turned it into a shape | — / `edited` (floor, wall, both, none) |
| `3d-orbit` | first camera drag (once per visit) | — |
| `3d-failed` | 3D couldn't start (e.g. no WebGL) | `reason` |
| `session-summary` | when the visitor leaves | `duration`, `drawings`, `presets`, `imports`, `dives`, `pngs`, `maxCircles`, `maxZoom`, `input`, `used3d` |

## Security

**Built in:**
- Static site only: no backend, database, logins or uploads on this app, so very little to attack.
- nginx runs as a non-root user, on a read-only filesystem, with all Linux capabilities dropped,
  `no-new-privileges`, and memory/CPU/process limits.
- Only `GET`/`HEAD` are accepted (others → 405); dotfiles always 404; no directory listings; server
  version hidden; small request size limits and short timeouts.
- Per-visitor rate limit (20 req/s, burst 40 → 429), keyed on Cloudflare's `CF-Connecting-IP` (validated)
  or the proxy-forwarded IP; access logs record the real visitor IP.
- Strict headers: Content-Security-Policy (only our own scripts + your analytics host; no inline code,
  no framing), HSTS, `nosniff`, `X-Frame-Options: DENY`, Referrer-Policy, Permissions-Policy, COOP/CORP.
- SVG import is rebuilt from an allowlist of geometry elements/attributes, so scripts, event handlers,
  links, `<use>`, `<foreignObject>` etc. never reach the page; 5 MB size cap.
- No CDNs; the only third-party code is three.js (pinned r170, vendored, loaded from our own origin).
  The base image is pinned to the nginx 1.28 stable line.

**Your checklist (server side — this is where real-world compromises usually happen):**
- [ ] Umami: default password changed; long unique password. Keep the Umami service updated in Coolify.
- [ ] Coolify: strong password + **2FA** enabled; keep Coolify updated; reach the dashboard via its domain
      over HTTPS and firewall off port `8000` (and `6001`/`6002`) from the internet.
- [ ] Firewall (e.g. `ufw`): allow only `22`, `80`, `443`.
- [ ] SSH: key-only login (`PasswordAuthentication no`), `PermitRootLogin prohibit-password` or `no`;
      consider `fail2ban`.
- [ ] OS: automatic security updates (`unattended-upgrades`).
- [ ] GitHub: 2FA on your account; Coolify should use a read-only deploy key / GitHub App.
- [ ] Backups of the Umami database (Coolify → the Umami service's Postgres → Backups).
- [x] Domain is behind Cloudflare (proxied) for DDoS protection and to hide your server IP.
- [ ] Firewall ports `80`/`443` so only [Cloudflare's IP ranges](https://www.cloudflare.com/ips/) can reach them.
      Otherwise someone who finds your server IP can bypass Cloudflare (and fake `CF-Connecting-IP`).
- [ ] Turn off Cloudflare's auto-injected Web Analytics (the CSP blocks it anyway; Umami replaces it).
- [ ] Check your headers at https://securityheaders.com after deploying.

## How it works

**2D.** The drawing is resampled into 2048 points spaced evenly along its length and treated as complex numbers
`z_n = x_n + i·y_n`. A discrete Fourier transform gives coefficients `c_k`; each one is an arrow of length
`|c_k|` that spins `k` times per loop. Chaining the arrows tip-to-tail (largest first) makes the
last tip trace the shape.

**3D.** A complex number can't hold three coordinates, so each axis gets its own Fourier series. For
frequency `k` the x, y and z terms combine into `a·cos(2πkt) + b·sin(2πkt)` with 3D vectors `a`, `b`:
a point going around a tilted ellipse `k` times per loop. Chaining the ellipses traces the 3D curve.
