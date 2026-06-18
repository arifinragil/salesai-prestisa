// Single source of truth for the sidebar nav. Used by Layout (render) and the
// /menu-access matrix editor. `adminOnly` is the fallback gate used only when no
// menu_access matrix is configured for a role.
export const navItems = [
  { href: '/inbox',             label: 'Inbox',      icon: '💬' },
  { href: '/lotus-inbox',       label: 'Lotus Inbox',icon: '🪷' },
  { href: '/customer',          label: 'Customer',   icon: '🎫' },
  { href: '/tax-requests',      label: 'Faktur Pajak', icon: '🧾' },
  { href: '/pipeline',          label: 'Pipeline',   icon: '📊' },
  { href: '/tasks',             label: 'Tasks',      icon: '✅' },
  { href: '/supervisor',        label: 'Supervisor', icon: '👁',  adminOnly: true },
  { href: '/supervisor-control', label: 'Supervisor Control', icon: '👁‍🗨', adminOnly: true },
  { href: '/lead-distribution', label: 'Leads',      icon: '🎯', adminOnly: true },
  { href: '/retention',         label: 'Retention',  icon: '🔁', adminOnly: true },
  { href: '/b2b-outreach',      label: 'B2B Outreach', icon: '🏢', adminOnly: true },
  { href: '/ai-monitor',        label: 'Monitor',    icon: '📡' },
  { href: '/ai-settings',       label: 'Persona',    icon: '🤖' },
  { href: '/knowledge',         label: 'Knowledge',  icon: '📚' },
  { href: '/qna',               label: 'Q&A AI',     icon: '💡', adminOnly: true },
  { href: '/reply-templates',   label: 'Templates',  icon: '📝' },
  { href: '/tags',              label: 'Tags',       icon: '🏷️' },
  { href: '/promos',            label: 'Promo',      icon: '🎁' },
  { href: '/sql-queries',       label: 'SQL',        icon: '🗄' },
  { href: '/users',             label: 'Users',      icon: '👤' },
  { href: '/snippets',          label: 'Snippets',   icon: '✂️' },
  { href: '/channel-settings',  label: 'Channel',    icon: '🔌', adminOnly: true },
  { href: '/menu-access',       label: 'Menu Access', icon: '🔐', adminOnly: true },
];

// Roles whose menu visibility is configurable. `admin` is intentionally excluded:
// admin always sees everything and can never be locked out of the editor.
export const CONFIGURABLE_ROLES = ['operator', 'viewer', 'acquisition', 'retention'];

// Compute the visible nav for a user given their `menu_access` matrix (from /me).
// - admin → everything.
// - other role with a matrix entry → exactly the allowed hrefs.
// - other role with NO matrix entry → fallback to non-adminOnly items (legacy behavior).
export function visibleNavFor(user) {
  const role = user?.role;
  if (role === 'admin') return navItems;
  const allowed = (user?.menu_access || {})[role];
  if (Array.isArray(allowed)) return navItems.filter((it) => allowed.includes(it.href));
  return navItems.filter((it) => !it.adminOnly);
}
