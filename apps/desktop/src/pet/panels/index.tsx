// ── Unified Pet panel entry ──────────────────────────────────────────
// One React root for both Pet panels, selected with `?panel=slip|transcript`.
// The appearance is resolved and applied before the first React paint so the
// shared Tailwind/theme tokens are correct from the start.

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '../../renderer/globals.css';
import { initializePetAppearance } from '../shared/appearance';
import { GraphSlip } from './GraphSlip';
import { Transcript } from './Transcript';

async function bootstrap(): Promise<void> {
  await initializePetAppearance();
  const container = document.getElementById('root');
  if (!container) throw new Error('missing #root');
  const panel = new URLSearchParams(window.location.search).get('panel');
  createRoot(container).render(
    <StrictMode>
      {panel === 'transcript' ? <Transcript /> : <GraphSlip />}
    </StrictMode>,
  );
}

void bootstrap();
