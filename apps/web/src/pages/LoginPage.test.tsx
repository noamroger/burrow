import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createQueryClient } from '../App';
import { LoginPage } from './LoginPage';

const ME = { user: { id: 1, email: 'admin@example.com' }, csrfToken: 'csrf' };

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Fake API: login asks for a second factor, `verify` accepts 123456 only. */
function stubApi() {
  const calls: { url: string; body: unknown }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ url, body });
      if (url.endsWith('/setup/status')) {
        return json(200, { userCreated: true, cloudflareConfigured: true, tunnelReady: true });
      }
      if (url.endsWith('/auth/me')) {
        return json(401, { error: { code: 'UNAUTHORIZED', message: 'no' } });
      }
      if (url.endsWith('/auth/login')) {
        return json(200, { mfaRequired: true, ticket: 'tkt', methods: ['totp', 'recovery'] });
      }
      if (url.endsWith('/auth/login/verify')) {
        return (body as { code: string }).code === '123456'
          ? json(200, ME)
          : json(401, { error: { code: 'UNAUTHORIZED', message: 'This code is not valid.' } });
      }
      return json(404, { error: { code: 'NOT_FOUND', message: url } });
    }),
  );
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('LoginPage', () => {
  it('asks for the authenticator code after the password', async () => {
    const calls = stubApi();
    const user = userEvent.setup();
    render(
      <QueryClientProvider client={createQueryClient()}>
        <MemoryRouter initialEntries={['/login']}>
          <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route path="/" element={<p>Signed in</p>} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    await user.type(await screen.findByLabelText('Email'), 'admin@example.com');
    await user.type(screen.getByLabelText('Password'), 'correct horse battery');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    const code = await screen.findByLabelText('Authentication code');
    await user.type(code, '000000');
    await user.click(screen.getByRole('button', { name: 'Verify' }));
    expect(await screen.findByText('This code is not valid. Try the next one.')).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Use a recovery code' }));
    expect(screen.getByLabelText('Recovery code')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Use the authenticator app' }));

    await user.type(screen.getByLabelText('Authentication code'), '123456');
    await user.click(screen.getByRole('button', { name: 'Verify' }));
    expect(await screen.findByText('Signed in')).toBeVisible();
    expect(calls.filter((c) => c.url.endsWith('/auth/login/verify')).at(-1)?.body).toEqual({
      ticket: 'tkt',
      code: '123456',
    });
  });
});
