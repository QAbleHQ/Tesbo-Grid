// Minimal type stub for `@novnc/novnc` — the package ships no `.d.ts` and
// only its constructor + a tiny event surface is used in this codebase
// (see `components/LiveVncViewer.tsx`). Anything else is exposed as
// `unknown` so accidental misuse fails type-checking.
declare module "@novnc/novnc" {
  export interface RfbCredentials {
    username?: string;
    password?: string;
    target?: string;
  }

  export interface RfbOptions {
    credentials?: RfbCredentials;
    wsProtocols?: string[];
    repeaterID?: string;
    shared?: boolean;
  }

  export default class RFB {
    constructor(target: HTMLElement, url: string, options?: RfbOptions);
    addEventListener(type: string, listener: (event: CustomEvent) => void): void;
    removeEventListener(type: string, listener: (event: CustomEvent) => void): void;
    disconnect(): void;
    sendCredentials(credentials: RfbCredentials): void;
    sendKey(keysym: number, code: string, down?: boolean): void;
    sendCtrlAltDel(): void;
    machineShutdown(): void;
    machineReboot(): void;
    machineReset(): void;
    clipboardPasteFrom(text: string): void;
    focus(): void;
    blur(): void;

    viewOnly: boolean;
    focusOnClick: boolean;
    clipViewport: boolean;
    dragViewport: boolean;
    scaleViewport: boolean;
    resizeSession: boolean;
    showDotCursor: boolean;
    background: string;
    qualityLevel: number;
    compressionLevel: number;
    capabilities: Record<string, boolean>;
  }
}
