import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import { keepAppFresh } from './sw-update.js';
import './styles.css';

createRoot(document.getElementById('root')).render(<App />);

keepAppFresh(
  typeof navigator !== 'undefined' ? navigator : null,
  () => window.location.reload(),
  (evt, fn) => window.addEventListener(evt, fn),
  (fn, ms) => setInterval(fn, ms)
);
