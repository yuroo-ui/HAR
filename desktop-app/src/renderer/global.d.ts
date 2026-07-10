/// <reference types="vite/client" />
import type { HarSuiteApi } from '../preload';

declare global {
  interface Window {
    harSuite: HarSuiteApi;
  }
}
export {};
