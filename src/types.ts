export interface Metrics {
  edit_magnitude: number;
  arcface_cosine: number | null;
  lpips: number;
  clip_score: number;
  canary_static: boolean;
}

export interface Variant {
  label: string; // "zero-shot" | "+ procedure LoRA"
  image: string; // path relative to data/
  metrics: Metrics;
  latency_s: number;
}

export interface Case {
  face: string;
  procedure: string;
  instruction: string;
  /** null when the expander refused (out of scope) */
  expanded_prompt: string | null;
  out_of_scope: boolean;
  refusal_reason?: string;
  expand_latency_s: number;
  variants: Variant[];
}

export interface Face {
  id: string;
  thumb: string; // path relative to data/
}

export interface Manifest {
  generated: string;
  editor_model: string;
  expander_model: string;
  hardware: string;
  recipe: string;
  procedures: string[];
  faces: Face[];
  cases: Case[];
}
