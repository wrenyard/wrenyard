import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { SessionPage } from './SessionPage.js';
import './session-v2.css';

const element = document.getElementById('session-v2-page');
if (!element) throw new Error('Session v2 page element #session-v2-page was not found.');

const root = createRoot(element);
root.render(<StrictMode><SessionPage api={window.sessionV2} /></StrictMode>);
window.addEventListener('beforeunload', () => root.unmount(), { once: true });
