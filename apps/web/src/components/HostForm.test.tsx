import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ApiRequestError } from '../api/client';
import { makeHost, zones, ZONE_ID } from '../test/fixtures';
import { accessChanged, HostForm } from './HostForm';

function setup(props: Partial<Parameters<typeof HostForm>[0]> = {}) {
  const onSubmit = vi.fn(async () => {});
  render(<HostForm zones={zones} onSubmit={onSubmit} onCancel={() => {}} {...props} />);
  return { onSubmit, user: userEvent.setup() };
}

describe('HostForm', () => {
  it('previews the public hostname as the user types', async () => {
    const { user } = setup();
    const preview = screen.getByTestId('fqdn-preview');
    expect(preview).toHaveTextContent('https://example.com');

    await user.type(screen.getByLabelText('Subdomain'), 'Jellyfin');
    expect(preview).toHaveTextContent('https://jellyfin.example.com');

    await user.selectOptions(screen.getByLabelText('Domain'), 'homelab.dev');
    expect(preview).toHaveTextContent('https://jellyfin.homelab.dev');

    await user.clear(screen.getByLabelText('Subdomain'));
    await user.type(screen.getByLabelText('Subdomain'), '@');
    expect(preview).toHaveTextContent('https://homelab.dev');
  });

  it('validates with the shared schema and does not submit invalid input', async () => {
    const { user, onSubmit } = setup();
    await user.type(screen.getByLabelText('Subdomain'), 'bad_name!');
    await user.type(screen.getByLabelText('Service URL'), 'localhost:3000');
    await user.click(screen.getByRole('button', { name: 'Create host' }));

    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByText(/letters, digits and hyphens/i)).toBeInTheDocument();
    expect(screen.getByText(/Use a URL like/i)).toBeInTheDocument();
    expect(screen.getByLabelText('Service URL')).toHaveAttribute('aria-invalid', 'true');
  });

  it('submits a valid host, and a service example fills the URL', async () => {
    const { user, onSubmit } = setup();
    await user.type(screen.getByLabelText('Subdomain'), 'app');
    await user.click(screen.getByRole('button', { name: 'http://my-container:3000' }));
    await user.click(screen.getByRole('button', { name: 'Create host' }));

    expect(onSubmit).toHaveBeenCalledWith({
      subdomain: 'app',
      zoneId: ZONE_ID,
      service: 'http://my-container:3000',
      path: '',
      enabled: true,
      options: { noTLSVerify: false, httpHostHeader: '', originServerName: '' },
      access: { enabled: false, emails: [], emailDomains: [], sessionDuration: '24h' },
    });
  });

  it('protects a host with Cloudflare Access: emails, domains and session length', async () => {
    const { user, onSubmit } = setup();
    await user.type(screen.getByLabelText('Subdomain'), 'nas');
    await user.type(screen.getByLabelText('Service URL'), 'http://192.168.1.20:5000');
    expect(screen.queryByLabelText('Allowed emails')).not.toBeInTheDocument();

    await user.click(screen.getByLabelText(/Require sign-in/));
    await user.click(screen.getByRole('button', { name: 'Create host' }));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByText(/at least one allowed email/i)).toBeInTheDocument();

    await user.type(
      screen.getByLabelText('Allowed emails'),
      'me@example.com{enter}Friend@Example.net',
    );
    await user.type(screen.getByLabelText('Allowed email domains'), '@family.example');
    await user.selectOptions(screen.getByLabelText('Stay signed in for'), '1 week');
    expect(screen.getByText('Changes take about a minute')).toBeInTheDocument();
    expect(screen.getByText(/every path of nas\.example\.com/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Create host' }));

    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        access: {
          enabled: true,
          emails: ['me@example.com', 'Friend@Example.net'],
          emailDomains: ['@family.example'],
          sessionDuration: '168h',
        },
      }),
    );
  });

  it('shows an invalid email on the emails field', async () => {
    const { user, onSubmit } = setup();
    await user.type(screen.getByLabelText('Subdomain'), 'nas');
    await user.type(screen.getByLabelText('Service URL'), 'http://nas:5000');
    await user.click(screen.getByLabelText(/Require sign-in/));
    await user.type(screen.getByLabelText('Allowed emails'), 'not-an-email');
    await user.click(screen.getByRole('button', { name: 'Create host' }));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Allowed emails')).toHaveAttribute('aria-invalid', 'true');
  });

  it('loads the protection of an existing host', () => {
    setup({
      host: makeHost({
        access: {
          enabled: true,
          emails: ['me@example.com'],
          emailDomains: [],
          sessionDuration: '6h',
        },
      }),
    });
    expect(screen.getByLabelText('Allowed emails')).toHaveValue('me@example.com');
    expect(screen.getByLabelText('Stay signed in for')).toHaveValue('6h');
  });

  it('explains Access conflicts returned by the API', async () => {
    const onSubmit = vi.fn(async () => {
      throw new ApiRequestError(409, 'ACCESS_CONFLICT', 'covered by "My NAS"');
    });
    const user = userEvent.setup();
    render(<HostForm zones={zones} host={makeHost()} onSubmit={onSubmit} onCancel={() => {}} />);
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(
      await screen.findByText('nas.example.com is already protected by another Access application'),
    ).toBeInTheDocument();
  });

  it('explains DNS conflicts returned by the API', async () => {
    const onSubmit = vi.fn(async () => {
      throw new ApiRequestError(409, 'DNS_CONFLICT', 'A CNAME record already exists');
    });
    const user = userEvent.setup();
    render(<HostForm zones={zones} host={makeHost()} onSubmit={onSubmit} onCancel={() => {}} />);
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(await screen.findByText('nas.example.com already has a DNS record')).toBeInTheDocument();
    expect(screen.getByText(/was not created by Burrow/)).toBeInTheDocument();
  });
});

describe('accessChanged', () => {
  const on = {
    enabled: true,
    emails: ['me@example.com'],
    emailDomains: [],
    sessionDuration: '24h',
  } as const;
  const priv = makeHost({ access: { ...on, emails: [...on.emails], emailDomains: [] } });
  const pub = makeHost();

  it('is true for a new private host, false for a new public one', () => {
    expect(accessChanged(undefined, priv)).toBe(true);
    expect(accessChanged(undefined, pub)).toBe(false);
  });

  it('is true when protection is turned on, off, or its rules change', () => {
    expect(accessChanged(pub, priv)).toBe(true);
    expect(accessChanged(priv, pub)).toBe(true);
    expect(
      accessChanged(
        priv,
        makeHost({ access: { ...on, emails: ['friend@example.net'], emailDomains: [] } }),
      ),
    ).toBe(true);
    expect(
      accessChanged(
        priv,
        makeHost({
          access: { ...on, emails: [...on.emails], emailDomains: [], sessionDuration: '6h' },
        }),
      ),
    ).toBe(true);
  });

  it('is false when only unrelated settings change', () => {
    expect(accessChanged(priv, { ...priv, service: 'http://other:80' })).toBe(false);
    expect(accessChanged(pub, { ...pub, service: 'http://other:80' })).toBe(false);
  });
});
