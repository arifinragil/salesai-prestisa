import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import HandoverBanner from '@/components/HandoverBanner';
import { ToastProvider } from '@/components/Toast';

beforeEach(() => { global.fetch = jest.fn(); });
afterEach(() => { jest.restoreAllMocks(); });

function renderWithToast(ui) {
  return render(<ToastProvider>{ui}</ToastProvider>);
}

test('renders nothing when no open handovers', () => {
  const { container } = renderWithToast(<HandoverBanner handovers={[]} />);
  expect(container.firstChild).toBeNull();
});

test('renders nothing when all handovers resolved', () => {
  const { container } = renderWithToast(
    <HandoverBanner handovers={[{ id: 1, reason: 'complaint', resolved_at: '2026-04-01' }]} />
  );
  expect(container.firstChild).toBeNull();
});

test('renders latest open handover with reason label', () => {
  renderWithToast(
    <HandoverBanner handovers={[
      { id: 1, reason: 'complaint', detail: 'rusak', created_at: new Date().toISOString() },
    ]} />
  );
  expect(screen.getByText(/Komplain/)).toBeInTheDocument();
  expect(screen.getByText('rusak')).toBeInTheDocument();
});

test('clicking Resolve calls API and triggers onResolved', async () => {
  global.fetch.mockResolvedValueOnce({
    ok: true, status: 200,
    headers: { get: () => 'application/json' },
    json: async () => ({ success: true }),
    text: async () => '{}',
  });
  const onResolved = jest.fn();
  renderWithToast(
    <HandoverBanner
      handovers={[{ id: 555, reason: 'refund', created_at: new Date().toISOString() }]}
      onResolved={onResolved}
    />
  );
  await userEvent.click(screen.getByText('Resolve'));
  await waitFor(() => expect(onResolved).toHaveBeenCalled());
  expect(fetch).toHaveBeenCalledWith(
    '/api/inbox/handovers/555/resolve',
    expect.objectContaining({ method: 'POST' })
  );
});
