import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { SyncBadge } from './SyncBadge';

describe('SyncBadge', () => {
  it('shows the status label', () => {
    render(<SyncBadge sync={{ status: 'synced', error: null, lastSyncedAt: null }} />);
    expect(screen.getByText('Synced')).toBeInTheDocument();
    expect(screen.getByRole('tooltip')).toHaveTextContent(
      'The tunnel route and the DNS record match this host.',
    );
  });

  it('exposes the error message in an accessible tooltip', () => {
    render(
      <SyncBadge
        sync={{
          status: 'error',
          error: 'DNS record conflict on app.example.com',
          lastSyncedAt: null,
        }}
      />,
    );
    expect(screen.getByText('Error')).toBeInTheDocument();
    const tooltip = screen.getByRole('tooltip');
    expect(tooltip).toHaveTextContent('DNS record conflict on app.example.com');
    // The focusable trigger points at the tooltip so screen readers read it.
    expect(tooltip.id).toBeTruthy();
    expect(document.querySelector(`[aria-describedby="${tooltip.id}"]`)).not.toBeNull();
  });
});
