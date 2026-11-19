import { render, screen, within } from '@testing-library/react';
import { REQUIRED_TOKEN_PERMISSIONS } from '@burrow/shared';
import { describe, expect, it } from 'vitest';
import { API_TOKENS_URL, TokenGuide } from './TokenPermissions';

describe('TokenGuide', () => {
  it('links to the API Tokens page of the Cloudflare dashboard', () => {
    render(<TokenGuide />);
    expect(screen.getByRole('link', { name: /api-tokens/ })).toHaveAttribute(
      'href',
      API_TOKENS_URL,
    );
  });

  it('lists every permission row as the three dropdown values to pick', () => {
    render(<TokenGuide />);
    const rows = within(
      screen.getByRole('list', { name: 'Permissions the token needs' }),
    ).getAllByRole('listitem');
    expect(rows).toHaveLength(REQUIRED_TOKEN_PERMISSIONS.length);
    REQUIRED_TOKEN_PERMISSIONS.forEach((p, i) => {
      expect(rows[i]).toHaveTextContent(`${p.scope}${p.group}${p.level}`);
    });
  });

  it('explains that DNS only shows up once the row scope is Zone', () => {
    render(<TokenGuide />);
    expect(screen.getByText(/first dropdown of the row is set to "Zone"/)).toBeInTheDocument();
  });
});
