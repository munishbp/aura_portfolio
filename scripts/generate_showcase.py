"""Generate the showcase data bundle by running the REAL Aura pipeline.

Runs on the 5090 with the Aura repo's environment:

    cd ~/Aura/ml && uv run python ~/aura_portfolio/scripts/generate_showcase.py \
        --faces data/raw/faces --out ~/aura_portfolio/public/data \
        [--rhino-lora outputs/rhinoplasty/best]

Faces MUST be license-clean (the StyleGAN synthetic set) — never HDA imagery,
whose license forbids redistribution. Everything written here ships publicly.

Output layout (all paths in manifest.json are relative to --out):
    manifest.json
    thumbs/<face>.webp     160px face-picker thumbnails
    faces/<face>.webp      768px "before" images
    out/<case-slug>.webp   768px predicted outcomes
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
from datetime import date
from pathlib import Path

os.environ.setdefault("AURA_METRICS_DEVICE", "cpu")

# Instructions per procedure. Each face gets all of them. One out-of-scope
# probe per procedure demonstrates the guardrail.
INSTRUCTIONS: dict[str, list[str]] = {
    "rhinoplasty": [
        "make the nose smaller",
        "shave the dorsal hump down",
        "refine the tip a little",
    ],
    "facelift": [
        "tighten the jawline a bit",
        "soften the smile lines",
    ],
    "blepharoplasty": [
        "smooth the under-eye bags",
        "reduce the hooded upper lids",
    ],
}
OUT_OF_SCOPE: dict[str, str] = {
    "rhinoplasty": "make her look like a completely different person",
    "facelift": "make him twenty years younger and change his ethnicity",
    "blepharoplasty": "turn this into an anime character",
}

SEED = 42


def slug(*parts: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", "_".join(parts).lower()).strip("-")


def save_webp(img, path: Path, long_edge: int, quality: int = 82) -> None:
    im = img.copy()
    im.thumbnail((long_edge, long_edge))
    path.parent.mkdir(parents=True, exist_ok=True)
    im.save(path, "WEBP", quality=quality)


def nan_to_none(v: float):
    import math

    return None if (isinstance(v, float) and math.isnan(v)) else round(v, 4)


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--faces", required=True, help="dir of synthetic face photos")
    p.add_argument("--out", required=True, help="public/data dir of aura_portfolio")
    p.add_argument("--n-faces", type=int, default=6)
    p.add_argument("--rhino-lora", default=None,
                   help="path to a trained rhinoplasty LoRA -> adds a '+ procedure LoRA' variant")
    p.add_argument("--lora-scale", type=float, default=1.0)
    args = p.parse_args()

    from PIL import Image

    from aura_ml.eval.metrics import all_metrics, is_static
    from aura_ml.inference.pipeline import AuraConfig, AuraInferencePipeline
    from aura_ml.inference.qwen_edit import QwenEditConfig

    out = Path(args.out).expanduser()
    (out / "thumbs").mkdir(parents=True, exist_ok=True)
    (out / "faces").mkdir(parents=True, exist_ok=True)
    (out / "out").mkdir(parents=True, exist_ok=True)

    face_paths = sorted(
        pp for pp in Path(args.faces).iterdir()
        if pp.suffix.lower() in {".jpg", ".jpeg", ".png", ".webp"}
    )[: args.n_faces]
    if not face_paths:
        print("[fatal] no faces found", file=sys.stderr)
        return 2

    cfg = AuraConfig(qwen_edit=QwenEditConfig())
    if args.rhino_lora:
        cfg.procedure_lora_paths = {"rhinoplasty": str(Path(args.rhino_lora).expanduser())}
        cfg.procedure_lora_scales = {"rhinoplasty": args.lora_scale}
    pipeline = AuraInferencePipeline(cfg)

    faces_meta = []
    for fp in face_paths:
        fid = fp.stem
        img = Image.open(fp).convert("RGB")
        save_webp(img, out / "thumbs" / f"{fid}.webp", 160)
        save_webp(img, out / "faces" / f"{fid}.webp", 768)
        faces_meta.append({"id": fid, "thumb": f"thumbs/{fid}.webp"})

    cases = []
    total = len(face_paths) * sum(len(v) for v in INSTRUCTIONS.values())
    done = 0

    for fp in face_paths:
        fid = fp.stem
        img = Image.open(fp).convert("RGB")

        for procedure, instr_list in INSTRUCTIONS.items():
            for instr in instr_list:
                done += 1
                print(f"[{done}/{total}] {fid} · {procedure} · '{instr}'", flush=True)

                exp = pipeline.expander.expand_detailed(img, instr, procedure, seed=SEED)
                if exp.out_of_scope:
                    print("  unexpectedly out of scope — skipped", flush=True)
                    continue

                variants = []
                variant_plan = [("zero-shot", False)]
                if args.rhino_lora and procedure == "rhinoplasty":
                    variant_plan.append(("+ procedure LoRA", True))

                for label, use_lora in variant_plan:
                    pipeline.diffuser.load()
                    pipeline._register_loras()
                    if use_lora:
                        pipeline.diffuser.set_active_loras(
                            ["rhinoplasty"], [args.lora_scale]
                        )
                    else:
                        pipeline.diffuser.disable_loras()

                    t0 = time.monotonic()
                    edited = pipeline.diffuser.generate(img, exp.prompt, seed=SEED)
                    dt = time.monotonic() - t0

                    name = slug(fid, procedure, instr, label) + ".webp"
                    save_webp(edited, out / "out" / name, 768)
                    m = all_metrics(img, edited, exp.prompt)
                    variants.append({
                        "label": label,
                        "image": f"out/{name}",
                        "latency_s": round(dt, 1),
                        "metrics": {
                            "edit_magnitude": nan_to_none(m["edit_magnitude"]),
                            "arcface_cosine": nan_to_none(m["arcface_cosine"]),
                            "lpips": nan_to_none(m["lpips"]),
                            "clip_score": nan_to_none(m["clip_score"]),
                            "canary_static": is_static(m),
                        },
                    })

                cases.append({
                    "face": fid,
                    "procedure": procedure,
                    "instruction": instr,
                    "expanded_prompt": exp.prompt,
                    "out_of_scope": False,
                    "expand_latency_s": round(exp.latency_s, 1),
                    "variants": variants,
                })

    # Out-of-scope probes: one per procedure, demonstrated on the first face.
    probe_img = Image.open(face_paths[0]).convert("RGB")
    for procedure, instr in OUT_OF_SCOPE.items():
        print(f"[oob] {procedure} · '{instr}'", flush=True)
        exp = pipeline.expander.expand_detailed(probe_img, instr, procedure, seed=SEED)
        for fp in face_paths:
            cases.append({
                "face": fp.stem,
                "procedure": procedure,
                "instruction": instr,
                "expanded_prompt": None,
                "out_of_scope": True,
                "refusal_reason": exp.reason or "instruction outside procedure scope",
                "expand_latency_s": round(exp.latency_s, 1),
                "variants": [],
            })

    manifest = {
        "generated": date.today().isoformat(),
        "editor_model": "Qwen/Qwen-Image-Edit-2511 (selective NF4 + Lightning 8-step)",
        "expander_model": "Qwen/Qwen3.5-9B (4-bit NF4)",
        "hardware": "1x NVIDIA RTX 5090 (32 GB)",
        "recipe": "8 steps, cfg 1.0, seed 42",
        "procedures": list(INSTRUCTIONS),
        "faces": faces_meta,
        "cases": cases,
    }
    (out / "manifest.json").write_text(json.dumps(manifest, indent=1), encoding="utf-8")
    n_img = len(list((out / "out").glob("*.webp")))
    print(f"done: {len(cases)} cases, {n_img} output images -> {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
