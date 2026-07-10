// Re-export from shared to avoid code duplication. The pure detection logic
// now lives in shared/src/captcha-detector.ts so it's usable by both the
// extension (DOM scanner + content script) and the desktop app (MITM proxy).
export { detectFromUrl, stableId } from '@har-suite/shared';

// Re-export the DetectionInput type for callers in the extension.
export type { DetectionInput } from '@har-suite/shared';
