// ── Worker overlay page entry ────────────────────────────────────────
// Transparent React root for the Pet worker window.

import { createRoot } from 'react-dom/client';
import '@/renderer/globals.css';
import { initializePetAppearance, petAppearanceBridge } from '../../shared/appearance';
import { WorkerOverlay } from './WorkerOverlay';

async function main(): Promise<void> {
  await initializePetAppearance();
  const container = document.getElementById('root');
  if (!container) throw new Error('missing #root');
  createRoot(container).render(<WorkerOverlay appearance={petAppearanceBridge} />);
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  void main();
}
