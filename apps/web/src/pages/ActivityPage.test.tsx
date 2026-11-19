import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AuditEntry } from '@burrow/shared';
import { createQueryClient } from '../App';
import { ToastProvider } from '../components/ui/Toast';
import { ActivityPage, actionLabel } from './ActivityPage';

const entry = (over: Partial<AuditEntry>): AuditEntry => ({
  id: 1,
  createdAt: new Date().toISOString(),
  action: 'host.update',
  category: 'host',
  target: 'app.example.com',
  actor: { label: 'admin@example.com', userId: 1, ip: '192.168.1.20' },
  details: { changes: [{ field: 'service', before: 'http://a:1', after: 'http://b:2' }] },
  undoable: true,
  undoneAt: null,
  undoneBy: null,
  revertOf: null,
  ...over,
});

function json(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

afterEach(() => vi.unstubAllGlobals());

describe('ActivityPage', () => {
  it('labels actions and falls back to the code', () => {
    expect(actionLabel('host.update')).toBe('Edited host');
    expect(actionLabel('something.new')).toBe('something.new');
  });

  it('lists changes with their diff and undoes one', async () => {
    const requests: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        requests.push(`${init?.method ?? 'GET'} ${url}`);
        if (url.includes('/undo')) {
          return json({
            undone: entry({ undoable: false, undoneAt: new Date().toISOString(), undoneBy: 3 }),
            entry: entry({ id: 3, revertOf: 1, undoable: true }),
          });
        }
        return json({
          entries: [
            entry({}),
            entry({ id: 2, action: 'token.create', target: 'ci', undoable: false, details: null }),
          ],
          nextBefore: null,
        });
      }),
    );
    const user = userEvent.setup();
    render(
      <QueryClientProvider client={createQueryClient()}>
        <ToastProvider>
          <MemoryRouter>
            <ActivityPage />
          </MemoryRouter>
        </ToastProvider>
      </QueryClientProvider>,
    );

    const row = (await screen.findByText('Edited host')).closest('li')!;
    expect(within(row).getByText(/admin@example\.com · 192\.168\.1\.20/)).toBeVisible();
    await user.click(within(row).getByRole('button', { name: 'Show the change' }));
    expect(within(row).getByText('http://a:1')).toBeVisible();
    expect(within(row).getByText('http://b:2')).toBeVisible();

    const tokenRow = screen.getByText('Created API token').closest('li')!;
    expect(within(tokenRow).queryByRole('button', { name: 'Undo' })).toBeNull();

    await user.click(within(row).getByRole('button', { name: 'Undo' }));
    const dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: 'Undo' }));
    expect(await screen.findByText('Change undone.')).toBeVisible();
    expect(requests).toContain('POST /api/audit/1/undo');

    await user.click(screen.getByRole('switch', { name: 'Only what can be undone' }));
    expect(requests.some((r) => r.includes('undoable=true'))).toBe(true);
  });
});
