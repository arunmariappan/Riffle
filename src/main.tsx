import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/App';
import { Unsupported } from './app/Unsupported';
import { checkWebGpu } from './engine/webgpu';
import './app/styles.css';

async function boot(): Promise<void> {
  const root = createRoot(document.getElementById('root') as HTMLElement);
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
