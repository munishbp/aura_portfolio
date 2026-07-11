# AURA — interactive pipeline explorer

The portfolio-embeddable, fully static showcase of
[AURA](https://github.com/munishbp/AURA): an AI-assisted plastic-surgery
outcome visualizer that runs end-to-end (inference, LoRA training, and
evaluation) on a single RTX 5090.

**What it is**: pick a synthetic patient, a procedure, and a line of surgeon
shorthand — see the real Qwen3.5-9B prompt expansion (including the guardrail
refusing out-of-scope requests), drag a before/after comparison of the real
Qwen-Image-Edit-2511 output, toggle zero-shot vs procedure-LoRA variants, and
read the same evaluation metrics (edit-magnitude canary, ArcFace identity,
LPIPS, CLIP) that gate AURA's training runs.

**Why it's static**: the pipeline needs a 32 GB GPU, which browsers don't
have. Every prompt, image, and metric in `public/data/` was produced by the
actual pipeline on the 5090, then packaged. Nothing is mocked; it's
*precomputed*, and labeled as such in the UI.

**Faces are StyleGAN-synthetic** — no real patients, no HDA imagery (whose
research-only license forbids redistribution).

## Develop

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # -> dist/
```

## Regenerate the data bundle (on the 5090, with the AURA repo checked out)

```bash
cd ~/Aura/ml
uv run python ~/aura_portfolio/scripts/generate_showcase.py \
    --faces data/raw/faces \
    --out ~/aura_portfolio/public/data \
    --rhino-lora outputs/rhinoplasty/best
```

## Deploy

Pushes to `main` deploy to GitHub Pages via `.github/workflows/deploy.yml`
(enable Pages → GitHub Actions in the repo settings once). The build uses a
relative base, so the same `dist/` also works inside an `<iframe>` on
munishpersaud.com or copied into any static host.
