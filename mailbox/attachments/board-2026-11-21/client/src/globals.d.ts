declare module "*.css";

// Codex's pipeline_view module, vendored verbatim as
// client/src/pipeline_view.mjs (from ~/workspace/bridge-tools/
// page-assets/). Typed here so the client can import it without
// touching the module's logic.
declare module "*.mjs" {
  export function paintSignal(
    badge: HTMLElement,
    signal: { label?: unknown; state?: string | null } | null | undefined,
  ): void;
  export function paintTraffic(
    track: HTMLElement,
    caption: HTMLElement,
    opts: { label: string; count?: number | null; moving?: boolean },
  ): void;
  export function bindFlowMotion(
    root: HTMLElement,
    pauseButton: HTMLElement,
    snapshotMaxAgeMs?: number,
  ): {
    observed: (sampleAt: number, ageMs: number) => void;
    unavailable: () => void;
    destroy: () => void;
  };
}
