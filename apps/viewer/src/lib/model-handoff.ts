/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Model hand-off from an opener window (e.g. the bridge.geoBIM modeler).
 *
 * The sender opens the viewer with `?handoff=1` (keeping `window.opener`). The viewer then
 * announces itself to its opener and accepts exactly one model buffer via postMessage:
 *
 *   viewer → opener   { type: 'geobim:handoff-ready', version: 1 }
 *   opener → viewer   { type: 'geobim:handoff-model', version: 1, name: 'x.ifc', buffer: ArrayBuffer }
 *   viewer → opener   { type: 'geobim:handoff-done', version: 1 } | { type: 'geobim:handoff-error', version: 1, message }
 *
 * SECURITY: like `?model=`, a hand-off must not become a drive-by model-injection vector. A model is
 * only accepted when the page was explicitly opened for a hand-off, the message comes from the very
 * window that opened this tab, and its origin is on the allowlist (configured origins plus loopback
 * development hosts). The ready announcement carries no data.
 */

export const HANDOFF_PARAM = 'handoff';
export const HANDOFF_VERSION = 1;

export interface HandoffModelMessage {
  type: 'geobim:handoff-model';
  version: number;
  name: string;
  buffer: ArrayBuffer;
}

/** Origins allowed by default; extend with VITE_HANDOFF_ORIGINS (comma separated). */
export const DEFAULT_HANDOFF_ORIGINS = ['https://bridge.geobim.app'];

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

export function parseHandoffOrigins(raw: string | undefined): string[] {
  const extra = (raw ?? '')
    .split(',')
    .map((s) => s.trim().replace(/\/+$/, ''))
    .filter(Boolean);
  return [...DEFAULT_HANDOFF_ORIGINS, ...extra];
}

/** True when `origin` may hand a model to this viewer. Loopback hosts (any port) are allowed for development. */
export function isAllowedHandoffOrigin(origin: string, allowed: readonly string[]): boolean {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.origin !== origin) return false; // reject anything that is not a bare origin
  if ((url.protocol === 'http:' || url.protocol === 'https:') && LOOPBACK_HOSTS.has(url.hostname)) return true;
  return allowed.includes(origin);
}

export function isHandoffModelMessage(data: unknown): data is HandoffModelMessage {
  if (!data || typeof data !== 'object') return false;
  const d = data as Record<string, unknown>;
  return (
    d.type === 'geobim:handoff-model' &&
    typeof d.version === 'number' &&
    typeof d.name === 'string' &&
    d.buffer instanceof ArrayBuffer
  );
}

/** Keep a sane, extension-bearing file name; the name only feeds the model title and format sniffing. */
export function handoffFileName(name: string): string {
  const base = name.split(/[\\/]/).pop()?.trim().slice(0, 200) || 'model.ifc';
  return /\.[A-Za-z0-9]{2,5}$/.test(base) ? base : `${base}.ifc`;
}

/**
 * Starts listening for a hand-off when the page was opened with `?handoff=1` by another window.
 * Returns a cleanup function, or null when no hand-off was requested.
 */
export function startModelHandoff(opts: {
  win: Window;
  allowedOrigins: readonly string[];
  onModel: (file: File) => Promise<void>;
  onError?: (message: string) => void;
}): (() => void) | null {
  const { win, allowedOrigins, onModel, onError } = opts;
  const params = new URLSearchParams(win.location.search);
  if (params.get(HANDOFF_PARAM) !== '1') return null;
  const opener = win.opener as Window | null;
  if (!opener) return null;

  let done = false;
  const onMessage = (ev: MessageEvent) => {
    if (done || ev.source !== opener || !isAllowedHandoffOrigin(ev.origin, allowedOrigins)) return;
    if (!isHandoffModelMessage(ev.data)) return;
    done = true;
    // Drop the parameter so a reload does not wait for a hand-off again. Done only now (not on
    // start) so a StrictMode effect re-run still finds it.
    const rest = new URLSearchParams(win.location.search);
    rest.delete(HANDOFF_PARAM);
    const qs = rest.toString();
    win.history.replaceState(win.history.state, '', `${win.location.pathname}${qs ? `?${qs}` : ''}${win.location.hash}`);
    const reply = (msg: Record<string, unknown>) => {
      try {
        opener.postMessage({ version: HANDOFF_VERSION, ...msg }, ev.origin);
      } catch {
        /* opener closed */
      }
    };
    const file = new File([ev.data.buffer], handoffFileName(ev.data.name), { type: 'application/x-step' });
    onModel(file).then(
      () => reply({ type: 'geobim:handoff-done' }),
      (err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        onError?.(message);
        reply({ type: 'geobim:handoff-error', message });
      },
    );
  };
  win.addEventListener('message', onMessage);
  // The announcement carries no data, so a wildcard target origin is harmless.
  try {
    opener.postMessage({ type: 'geobim:handoff-ready', version: HANDOFF_VERSION }, '*');
  } catch {
    /* opener closed */
  }
  return () => win.removeEventListener('message', onMessage);
}
