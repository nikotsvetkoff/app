import React from 'react';
import { createRoot } from 'react-dom/client';
import { WebOsApp } from './app/webos-app';
import './app/webos.styles.css';

createRoot(document.getElementById('root')!).render(<WebOsApp />);
