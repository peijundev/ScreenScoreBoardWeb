export {};

declare global {
  interface Window {
    ssbShell?: {
      isElectron?: boolean;
      returnToLauncher?: () => Promise<{ ok: boolean; error?: string }>;
    };
  }
}
