import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '@/lib/api';

/**
 * The demo build's hard backstop: the single frontend fetch choke point must
 * reject before `fetch` whenever Vite mode is `demo`, even if a component
 * forgets to gate itself.
 */
describe('api demo backstop', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('rejects before calling fetch in demo mode', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    vi.stubEnv('MODE', 'demo');

    await expect(api.getHealth()).rejects.toThrow('Demo mode');
    await expect(api.putSetting('timezone', 'UTC')).rejects.toThrow('Demo mode');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
