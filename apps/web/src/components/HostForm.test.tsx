import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ApiRequestError } from '../api/client';
import { makeHost, zones, ZONE_ID } from '../test/fixtures';
import { HostForm } from './HostForm';

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
    });
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
