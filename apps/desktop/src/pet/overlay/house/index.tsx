// ── House overlay page entry ─────────────────────────────────────────
// Transparent React root for the Pet house window. The shared Pet appearance
// bridge is initialised before mount so the first paint already matches the
// shell theme; the overlay component owns the Pixi surface and static preview.

import { createRoot } from 'react-dom/client';
import '@/renderer/globals.css';
import { initializePetAppearance, petAppearanceBridge } from '../../shared/appearance';
import { HouseOverlay } from './HouseOverlay';

async function main(): Promise<void> {
  await initializePetAppearance();
  const container = document.getElementById('root');
  if (!container) throw new Error('missing #root');
  createRoot(container).render(<HouseOverlay appearance={petAppearanceBridge} />);
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  void main();
}
