import { render, screen } from '@testing-library/react';
import MessageBubble from '@/components/MessageBubble';

const base = (overrides = {}) => ({
  id: 1,
  direction: 'in',
  sender_type: 'customer',
  body: 'halo',
  created_at: new Date('2026-04-15T10:00:00Z').toISOString(),
  ...overrides,
});

test('renders inbound customer message text', () => {
  render(<MessageBubble message={base()} />);
  expect(screen.getByText('halo')).toBeInTheDocument();
  expect(screen.getByText('Customer')).toBeInTheDocument();
});

test('renders outbound AI message with Tiara label', () => {
  render(<MessageBubble message={base({ direction: 'out', sender_type: 'ai', body: 'halo Kak' })} />);
  expect(screen.getByText('halo Kak')).toBeInTheDocument();
  expect(screen.getByText('Tiara (AI)')).toBeInTheDocument();
});

test('renders shadow badge when message.shadow', () => {
  render(<MessageBubble message={base({ direction: 'out', sender_type: 'ai', body: 'x', shadow: true })} />);
  expect(screen.getByText('shadow')).toBeInTheDocument();
});

test('renders send-failed badge when send_status', () => {
  render(<MessageBubble message={base({ direction: 'out', sender_type: 'ai', body: 'x', send_status: 'send_failed' })} />);
  expect(screen.getByText('send failed')).toBeInTheDocument();
});

test('renders <img> for image attachments', () => {
  render(<MessageBubble message={base({ attachment_url: 'https://x/y.jpg', message_type: 'image' })} />);
  const img = screen.getByRole('img');
  expect(img).toHaveAttribute('src', 'https://x/y.jpg');
  // Image is wrapped in an <a> link to open full size
  expect(img.closest('a')).toHaveAttribute('href', 'https://x/y.jpg');
});

test('renders download link for non-image attachments (e.g. PDF)', () => {
  render(<MessageBubble message={base({
    attachment_url: 'https://x/contract.pdf', message_type: 'document', body: 'Kontrak terlampir',
  })} />);
  expect(screen.getByText('Kontrak terlampir')).toBeInTheDocument();
  expect(screen.getByText('contract.pdf')).toBeInTheDocument();
  expect(screen.getByText('contract.pdf').closest('a')).toHaveAttribute('href', 'https://x/contract.pdf');
});

test('renders placeholder when body is empty (e.g. media-only)', () => {
  render(<MessageBubble message={base({ body: null, message_type: 'media' })} />);
  expect(screen.getByText('[media]')).toBeInTheDocument();
});
