import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { DEFAULT_MAINTENANCE_PAGE, type MaintenancePage } from '@burrow/shared';
import { describe, expect, it } from 'vitest';
import { MaintenancePageEditor } from './MaintenancePageEditor';

function Harness() {
  const [page, setPage] = useState<MaintenancePage>(DEFAULT_MAINTENANCE_PAGE);
  return <MaintenancePageEditor value={page} onChange={setPage} hostname="nas.example.com" />;
}

const preview = () => screen.getByTitle('Preview').getAttribute('srcdoc') ?? '';

describe('MaintenancePageEditor', () => {
  it('previews the simple design as it is edited, sandboxed', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    expect(screen.getByTitle('Preview')).toHaveAttribute('sandbox', '');
    await user.clear(screen.getByLabelText('Title'));
    await user.type(screen.getByLabelText('Title'), 'Back at <noon>');
    expect(preview()).toContain('Back at &lt;noon&gt;');
    expect(preview()).toContain('nas.example.com');
  });

  it('switches to custom HTML, starting from the simple design', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole('radio', { name: 'Custom HTML' }));
    await user.click(screen.getByRole('button', { name: 'Start from the simple design' }));
    expect((screen.getByLabelText('HTML document') as HTMLTextAreaElement).value).toContain(
      '{{hostname}}',
    );
    expect(preview()).toContain('nas.example.com');
  });
});
