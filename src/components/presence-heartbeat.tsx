'use client';

import { useEffect } from 'react';

export function PresenceHeartbeat({ userId }: { userId: string }) {
  useEffect(() => {
    if (!userId) return;
    let live = true;
    let stopped = false;
    let controller: AbortController | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;

    async function heartbeat() {
      if (!live || stopped || document.hidden || controller) return;
      if (timer) clearTimeout(timer);
      const current = new AbortController();
      controller = current;
      timeout = setTimeout(() => current.abort(), 15000);
      try {
        const response = await fetch('/api/v1/presence', { method: 'POST', signal: current.signal });
        if (live && !current.signal.aborted && (response.status === 401 || response.status === 403)) stopped = true;
      } catch {
        // A transient failure is retried while this member keeps the page visible.
      } finally {
        if (controller === current) {
          if (timeout) clearTimeout(timeout);
          controller = null;
          if (live && !stopped && !document.hidden) timer = setTimeout(heartbeat, 60000);
        }
      }
    }

    function visibilityChanged() {
      if (document.hidden) {
        if (timer) clearTimeout(timer);
        if (timeout) clearTimeout(timeout);
        controller?.abort();
        controller = null;
      } else void heartbeat();
    }

    void heartbeat();
    document.addEventListener('visibilitychange', visibilityChanged);
    return () => {
      live = false;
      if (timer) clearTimeout(timer);
      if (timeout) clearTimeout(timeout);
      controller?.abort();
      document.removeEventListener('visibilitychange', visibilityChanged);
    };
  }, [userId]);

  return null;
}
