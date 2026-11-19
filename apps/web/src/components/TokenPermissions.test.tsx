import { render, screen } from '@testing-library/react';
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

  it('puts DNS and Zone in a separate Zone policy', () => {
    render(<TokenGuide />);
    expect(screen.getByText(/second policy of type "Zone"/)).toHaveTextContent(
      'DNS: Edit and Zone: Read',
    );
  });
});
