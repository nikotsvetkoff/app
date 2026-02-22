import React from 'react';
import { createRoot } from 'react-dom/client';
import { MagApp } from './app/app';
import './app/styles.css';

createRoot(document.getElementById('root')!).render(<MagApp />);

