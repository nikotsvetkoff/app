import React from 'react';
import { createRoot } from 'react-dom/client';
import { TizenApp } from './app/tizen-app';

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <TizenApp />
  </React.StrictMode>
);
