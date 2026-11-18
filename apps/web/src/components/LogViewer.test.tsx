import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { mergeLogLines } from '../hooks/useLogStream';
import { makeLog } from '../test/fixtures';
import { filterLogLines, LogViewer } from './LogViewer';

const lines = [
  makeLog(1, 'debug', 'Loaded configuration'),
  makeLog(2, 'info', 'Registered tunnel connection connIndex=0 location=cdg01'),
  makeLog(3, 'warn', 'Retrying connection in 2s'),
  makeLog(4, 'error', 'Unable to reach the origin service'),
];

describe('LogViewer', () => {
  it('renders every line with its level', () => {
    render(<LogViewer lines={lines} status="live" />);
    const log = screen.getByRole('log');
    expect(log.querySelectorAll('[data-level]')).toHaveLength(4);
    expect(within(log).getByText('Retrying connection in 2s')).toBeInTheDocument();
    expect(log.querySelector('[data-level="error"]')).toHaveTextContent(
      'Unable to reach the origin service',
    );
    expect(screen.getByText('Live')).toBeInTheDocument();
    expect(screen.getByText('4 of 4 lines')).toBeInTheDocument();
  });

  it('filters by minimum level and by text', async () => {
    const user = userEvent.setup();
    render(<LogViewer lines={lines} />);
    await user.selectOptions(screen.getByLabelText('Minimum level'), 'warn');
    expect(screen.getByRole('log').querySelectorAll('[data-level]')).toHaveLength(2);

    await user.type(screen.getByLabelText('Filter messages…'), 'origin');
    expect(screen.getByRole('log').querySelectorAll('[data-level]')).toHaveLength(1);
  });

  it('shows an empty state', () => {
    render(<LogViewer lines={[]} status="connecting" />);
    expect(screen.getByText('No log lines yet.')).toBeInTheDocument();
  });

  it('filterLogLines keeps levels at or above the minimum', () => {
    expect(filterLogLines(lines, 'info', '').map((l) => l.seq)).toEqual([2, 3, 4]);
  });
});

describe('mergeLogLines', () => {
  it('appends, deduplicates by seq and caps the buffer', () => {
    const merged = mergeLogLines(lines.slice(0, 2), [lines[1]!, lines[2]!, lines[3]!], 3);
    expect(merged.map((l) => l.seq)).toEqual([2, 3, 4]);
  });

  it('replaces the buffer when the server sequence restarts', () => {
    const prev = [makeLog(100, 'info', 'old'), makeLog(101, 'info', 'old')];
    const merged = mergeLogLines(prev, [makeLog(1, 'info', 'new'), makeLog(2, 'info', 'new')], 10);
    expect(merged.map((l) => l.seq)).toEqual([1, 2]);
  });
});
