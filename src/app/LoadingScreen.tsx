/** Shown while the valley is generated and planted. */
export function LoadingScreen({ label, fraction }: { label: string; fraction: number }) {
  return (
    <div className="loading" role="status" aria-live="polite">
      <div className="loading-title">Riffle</div>
      <div className="loading-label">{label}…</div>
      <div className="loading-bar">
        <div className="loading-fill" style={{ width: `${Math.round(fraction * 100)}%` }} />
      </div>
    </div>
  );
}
