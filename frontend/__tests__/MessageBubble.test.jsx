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

test('shows attachment link when attachment_url', () => {
  render(<MessageBubble message={base({ attachment_url: 'https://x/y.jpg' })} />);
  expect(screen.getByText('Attachment')).toHaveAttribute('href', 'https://x/y.jpg');
});

test('renders placeholder when body is empty (e.g. media-only)', () => {
  render(<MessageBubble message={base({ body: null, message_type: 'media' })} />);
  expect(screen.getByText('[media]')).toBeInTheDocument();
});
