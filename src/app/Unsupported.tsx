/** Shown when the browser has no WebGPU (plan D1: desktop Chrome and Edge). */
export function Unsupported({ reason }: { reason: string }) {
  return (
    <main className="unsupported" role="alert">
      <h1>Riffle needs WebGPU</h1>
      <p>{reason}</p>
      <p>
        Please open Riffle in an up-to-date <strong>Google Chrome</strong> or <strong>Microsoft Edge</strong> on a
        desktop computer.
      </p>
    </main>
  );
}
