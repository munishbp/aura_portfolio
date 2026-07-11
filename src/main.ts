import "./style.css";
import type { Case, Manifest, Metrics, Variant } from "./types";

const DATA = "data/";

const state = {
  manifest: null as Manifest | null,
  face: "",
  procedure: "",
  instruction: "",
  variantIdx: 0,
  typeTimer: 0 as number | ReturnType<typeof setInterval>,
};

const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;

const PROCEDURE_LABELS: Record<string, string> = {
  rhinoplasty: "Rhinoplasty — nose",
  facelift: "Facelift — jawline & midface",
  blepharoplasty: "Blepharoplasty — eyelids",
};

// ---------------------------------------------------------------------------

async function boot(): Promise<void> {
  const res = await fetch(`${DATA}manifest.json`);
  if (!res.ok) {
    $("#app").innerHTML = `<div class="loading">Showcase data not generated yet.</div>`;
    return;
  }
  state.manifest = (await res.json()) as Manifest;
  const m = state.manifest;
  state.face = m.faces[0].id;
  state.procedure = m.procedures[0];
  state.instruction = firstInstruction();
  render();
}

function firstInstruction(): string {
  const c = casesFor(state.face, state.procedure).find((k) => !k.out_of_scope);
  return c ? c.instruction : "";
}

function casesFor(face: string, procedure: string): Case[] {
  return state.manifest!.cases.filter(
    (c) => c.face === face && c.procedure === procedure
  );
}

function currentCase(): Case | undefined {
  return casesFor(state.face, state.procedure).find(
    (c) => c.instruction === state.instruction
  );
}

// ---------------------------------------------------------------------------

function render(): void {
  const m = state.manifest!;
  $("#app").innerHTML = `
    ${sectionLabel("01", "Patient", "synthetic faces — no real patients")}
    <div class="faces" role="group" aria-label="choose a synthetic patient">
      ${m.faces
        .map(
          (f) => `<button class="face" data-face="${f.id}"
            aria-pressed="${f.id === state.face}" aria-label="patient ${f.id}">
            <img src="${DATA}${f.thumb}" alt="synthetic face ${f.id}" loading="lazy"></button>`
        )
        .join("")}
    </div>

    ${sectionLabel("02", "Procedure", "")}
    <div class="tabs" role="group" aria-label="choose a procedure">
      ${m.procedures
        .map(
          (p) => `<button class="tab" data-proc="${p}" aria-pressed="${p === state.procedure}">
            ${PROCEDURE_LABELS[p] ?? p}</button>`
        )
        .join("")}
    </div>

    ${sectionLabel("03", "Physician instruction", "the raw shorthand a surgeon would type")}
    <div class="chips" role="group" aria-label="choose an instruction">
      ${casesFor(state.face, state.procedure)
        .map(
          (c) => `<button class="chip ${c.out_of_scope ? "oob" : ""}"
            data-instr="${escapeAttr(c.instruction)}"
            aria-pressed="${c.instruction === state.instruction}">
            “${escapeHtml(c.instruction)}”</button>`
        )
        .join("")}
    </div>

    <div id="expander-slot"></div>
    <div id="result-slot"></div>
  `;

  document.querySelectorAll<HTMLButtonElement>(".face").forEach((b) =>
    b.addEventListener("click", () => {
      state.face = b.dataset.face!;
      state.instruction = firstInstruction();
      state.variantIdx = 0;
      render();
    })
  );
  document.querySelectorAll<HTMLButtonElement>(".tab").forEach((b) =>
    b.addEventListener("click", () => {
      state.procedure = b.dataset.proc!;
      state.instruction = firstInstruction();
      state.variantIdx = 0;
      render();
    })
  );
  document.querySelectorAll<HTMLButtonElement>(".chip").forEach((b) =>
    b.addEventListener("click", () => {
      state.instruction = b.dataset.instr!;
      state.variantIdx = 0;
      render();
    })
  );

  renderExpansion();
}

function sectionLabel(num: string, title: string, hint: string): string {
  return `<section><div class="seclabel">
    <div><span class="num">${num}</span>&ensp;<h2 style="display:inline">${title}</h2></div>
    ${hint ? `<span class="hint">${hint}</span>` : ""}
  </div>`;
}

// ---------------------------------------------------------------------------

function renderExpansion(): void {
  const c = currentCase();
  const slot = $("#expander-slot");
  clearInterval(state.typeTimer as number);

  if (!c) {
    slot.innerHTML = "";
    return;
  }

  if (c.out_of_scope) {
    slot.innerHTML = `
      ${sectionLabel("04", "Prompt expansion", "Qwen3.5-9B, 4-bit — sees the photo + the instruction")}
      <div class="refusal" role="status">
        <span class="badge">⚠ OUT OF SCOPE — the expander refused</span>
        <p>${escapeHtml(c.refusal_reason ?? "Instruction falls outside the selected procedure.")}</p>
        <p style="font-style:italic;color:var(--muted);font-size:13px">
          The guardrail layer: instructions that change identity, ethnicity, age or ask for a
          different person never reach the image model.</p>
      </div>`;
    $("#result-slot").innerHTML = "";
    return;
  }

  slot.innerHTML = `
    ${sectionLabel("04", "Prompt expansion", `Qwen3.5-9B, 4-bit · ${c.expand_latency_s.toFixed(1)} s on the RTX 5090`)}
    <div class="expander-card">
      <div class="cardlabel"><span>expanded prompt → sent to the image editor</span></div>
      <div class="expanded-text" id="typewriter" aria-live="polite"></div>
    </div>`;

  typewrite(c.expanded_prompt ?? "", () => renderResult());
}

function typewrite(text: string, done: () => void): void {
  const el = $("#typewriter");
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reduced || !text) {
    el.textContent = text;
    done();
    return;
  }
  let i = 0;
  const step = Math.max(1, Math.round(text.length / 90)); // ~1.5 s total
  el.innerHTML = `<span class="caret">&nbsp;</span>`;
  state.typeTimer = setInterval(() => {
    i = Math.min(text.length, i + step);
    el.innerHTML = `${escapeHtml(text.slice(0, i))}${i < text.length ? '<span class="caret">&nbsp;</span>' : ""}`;
    if (i >= text.length) {
      clearInterval(state.typeTimer as number);
      done();
    }
  }, 16);
  // render the result immediately as well — no need to wait for the animation
  done();
}

// ---------------------------------------------------------------------------

function renderResult(): void {
  const c = currentCase();
  if (!c || c.out_of_scope || c.variants.length === 0) return;
  const slot = $("#result-slot");
  if (slot.dataset.for === caseKey(c)) return; // already rendered for this case
  slot.dataset.for = caseKey(c);

  const v = c.variants[Math.min(state.variantIdx, c.variants.length - 1)];
  const faceThumb = state.manifest!.faces.find((f) => f.id === c.face)!;
  const before = `${DATA}${faceThumb.thumb.replace("thumbs/", "faces/")}`;

  slot.innerHTML = `
    ${sectionLabel("05", "Predicted outcome", `Qwen-Image-Edit-2511, NF4 + Lightning · ${v.latency_s.toFixed(1)} s`)}
    ${
      c.variants.length > 1
        ? `<div class="variants" role="group" aria-label="model variant">
            ${c.variants
              .map(
                (vv, i) => `<button data-vi="${i}" aria-pressed="${i === state.variantIdx}">${escapeHtml(vv.label)}</button>`
              )
              .join("")}
          </div>`
        : ""
    }
    <div class="stage">
      <div class="compare" id="compare" aria-label="before and after comparison — drag to reveal">
        <img src="${before}" alt="before" draggable="false">
        <div class="after-wrap" id="after-wrap"><img src="${DATA}${v.image}" alt="predicted outcome" draggable="false"></div>
        <div class="divider" id="divider"><div class="handle" role="slider" tabindex="0"
          aria-label="comparison position" aria-valuemin="0" aria-valuemax="100" aria-valuenow="50">‹›</div></div>
        <span class="tag before">before</span><span class="tag after">predicted</span>
      </div>
      <p class="stage-note">drag the handle — arrow keys work too</p>
    </div>

    ${sectionLabel("06", "Automatic evaluation", "scored by the same harness that gates training")}
    <div class="metrics">${metricTiles(v.metrics)}</div>
    ${canaryBadge(v.metrics)}
  `;

  slot.querySelectorAll<HTMLButtonElement>(".variants button").forEach((b) =>
    b.addEventListener("click", () => {
      state.variantIdx = Number(b.dataset.vi);
      slot.dataset.for = "";
      renderResult();
    })
  );

  initCompare();
}

function caseKey(c: Case): string {
  return `${c.face}|${c.procedure}|${c.instruction}|${state.variantIdx}`;
}

function metricTiles(m: Metrics): string {
  const t = (k: string, v: string, s: string) =>
    `<div class="tile"><div class="k">${k}</div><div class="v">${v}</div><div class="s">${s}</div></div>`;
  return [
    t("edit magnitude", m.edit_magnitude.toFixed(3), "&gt; 0.05 = a real edit happened"),
    t("identity (ArcFace)", m.arcface_cosine === null ? "—" : m.arcface_cosine.toFixed(3), "≥ 0.6 = clearly the same person"),
    t("LPIPS", m.lpips.toFixed(3), "perceptual distance, sanity check"),
    t("CLIP score", m.clip_score.toFixed(3), "instruction ↔ image alignment"),
  ].join("");
}

function canaryBadge(m: Metrics): string {
  return m.canary_static
    ? `<div class="canary bad" role="status">⚠ <strong>canary tripped</strong> — output ≈ input (static-image collapse)</div>`
    : `<div class="canary ok" role="status">✓ <strong>real edit detected</strong> — the static-image canary is quiet</div>`;
}

// ---------------------------------------------------------------------------

function initCompare(): void {
  const box = $("#compare");
  const afterWrap = $("#after-wrap");
  const divider = $("#divider");
  const handle = divider.querySelector(".handle") as HTMLElement;
  let pos = 50;

  const apply = () => {
    afterWrap.style.clipPath = `inset(0 0 0 ${pos}%)`;
    divider.style.left = `calc(${pos}% - 1px)`;
    handle.setAttribute("aria-valuenow", String(Math.round(pos)));
  };

  const fromEvent = (clientX: number) => {
    const r = box.getBoundingClientRect();
    pos = Math.min(98, Math.max(2, ((clientX - r.left) / r.width) * 100));
    apply();
  };

  let dragging = false;
  box.addEventListener("pointerdown", (e) => {
    dragging = true;
    box.setPointerCapture(e.pointerId);
    fromEvent(e.clientX);
  });
  box.addEventListener("pointermove", (e) => dragging && fromEvent(e.clientX));
  box.addEventListener("pointerup", () => (dragging = false));
  box.addEventListener("pointercancel", () => (dragging = false));

  handle.addEventListener("keydown", (e) => {
    if (e.key === "ArrowLeft") pos = Math.max(2, pos - 4);
    else if (e.key === "ArrowRight") pos = Math.min(98, pos + 4);
    else return;
    e.preventDefault();
    apply();
  });

  apply();
}

// ---------------------------------------------------------------------------

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/"/g, "&quot;");
}

boot();
