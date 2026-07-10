import { createRoot } from 'react-dom/client';
// Mantine styles must be imported before our own so styles.css can override
// custom surfaces (the virtualized network list, waterfall, detail pane).
import '@mantine/core/styles.css';
import '@mantine/notifications/styles.css';
import { MantineProvider } from '@mantine/core';
import { Notifications } from '@mantine/notifications';
import App from './App';
import { theme } from './theme';
import './styles.css';

const container = document.getElementById('root')!;
const root = createRoot(container);

// The app owns the dark/light toggle (persisted to localStorage and reflected on
// <html data-theme>). We mirror that into Mantine via defaultColorScheme so both
// systems agree on first paint; App keeps them in sync afterwards.
const initialScheme =
  (localStorage.getItem('har-suite-theme') as 'dark' | 'light' | null) ?? 'dark';

root.render(
  <MantineProvider theme={theme} defaultColorScheme={initialScheme}>
    <Notifications position="bottom-right" />
    <App />
  </MantineProvider>,
);
