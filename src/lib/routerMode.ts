import { IS_LOCAL } from './mode';

/** Hosted: normal paths. File from disk: #hash paths. Preview panels: in memory. */
export type RouterMode = 'browser' | 'hash' | 'memory';

function detect(): RouterMode {
  // 'web' mode = the online app published as one index.html on a static host.
  if (!IS_LOCAL && import.meta.env.MODE !== 'web') return 'browser';
  try {
    const { protocol, href } = window.location;
    if (!/^(https?|file):$/.test(protocol)) return 'memory';
    new URL('#/login', href);
    // Inside a frame (e.g. an app's preview panel), the host may hijack links.
    return window.self !== window.top ? 'memory' : 'hash';
  } catch {
    return 'memory';
  }
}

export const ROUTER_MODE: RouterMode = detect();
