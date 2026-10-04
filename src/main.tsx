import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/App';
import { ensureIsolation } from './app/isolation';
import { Unsupported } from './app/Unsupported';
import { checkWebGpu } from './engine/webgpu';
import './app/styles.css';

async function boot(): Promise<void> {
  const isolation = await ensureIsolation();
  if (isolation === 'reloading') return;
  const root = createRoot(document.getElementById('root') as HTMLElement);
  if (isolation === 'unavailable') {
    root.render(
      <Unsupported
        title="Riffle needs cross-origin isolation"
        reason="The simulation shares memory between threads (SharedArrayBuffer), which the browser only allows on a cross-origin isolated page. This server doesn't send the COOP/COEP headers, and the service worker that adds them couldn't start."
      />,
    );
    return;
  }
  const support = await checkWebGpu();
  if (!support.supported) {
    root.render(<Unsupported reason={support.reason ?? 'WebGPU is not available.'} />);
    return;
  }
  root.render(
    <StrictMode>
      <App adapterInfo={support.adapterInfo ?? ''} />
    </StrictMode>,
  );
}

void boot();
