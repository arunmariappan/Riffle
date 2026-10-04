/** Shown when the browser can't run Riffle: no WebGPU (plan D1: desktop Chrome and Edge) or no cross-origin isolation. */
export function Unsupported({ reason, title = 'Riffle needs WebGPU' }: { reason: string; title?: string }) {
  return (
    <main className="unsupported" role="alert">
      <h1>{title}</h1>
      <p>{reason}</p>
      <p>
        Please open Riffle in an up-to-date <strong>Google Chrome</strong> or <strong>Microsoft Edge</strong> on a
        desktop computer.
      </p>
    </main>
  );
}
