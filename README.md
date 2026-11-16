# Fourier Draw

Draw anything and watch a chain of spinning arrows (a Fourier series / epicycles) trace it.

- Draw freehand with mouse, pen or finger (multiple strokes get joined into one loop)
- Presets (dinosaur, heart, star, square, …) and SVG import (upload a file or paste a path `d`)
- Adjust the number of circles (1–2048), speed and zoom; the camera can follow the pen
- "Build up" mode adds circles each loop so you can see the approximation improve

Zero dependencies: plain HTML/CSS/JS in `public/`.

## Run locally

```sh
docker compose up -d          # http://localhost:8080  (PORT=3000 docker compose up -d to change)
docker compose down
```

`public/` is mounted into the container, so edits show up on browser refresh without rebuilding.
Without Docker: `cd public && python3 -m http.server 8080`.

## Deploy on Coolify

1. Push this folder to a Git repo (GitHub/GitLab/Gitea).
2. In Coolify: **New Resource → Public/Private Repository**, pick the repo.
3. Build pack: **Dockerfile**. Port: **80**.
4. Set your domain and deploy.

## How it works

The drawing is resampled into 2048 points spaced evenly along its length and treated as complex numbers
`z_n = x_n + i·y_n`. A discrete Fourier transform gives coefficients `c_k`; each one is an arrow of length
`|c_k|` that spins `k` times per loop. Chaining the arrows tip-to-tail (largest first) makes the
last tip trace the shape.
