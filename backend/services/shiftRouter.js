// Resolve which operator(s) are currently on-shift in Asia/Jakarta time.
// Falls back to "any active staff" if nobody scheduled.
const pg = require('../db/postgres');

const TZ = 'Asia/Jakarta';

function nowJakarta() {
  // returns { weekday: 0..6, hhmm: 'HH:MM:SS' }
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ, weekday: 'short', hour12: false,
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const parts = fmt.formatToParts(new Date()).reduce((a, p) => (a[p.type] = p.value, a), {});
  const wkMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return { weekday: wkMap[parts.weekday], hhmm: `${parts.hour}:${parts.minute}:${parts.second}` };
}

async function onShift() {
  const { weekday, hhmm } = nowJakarta();
  const { rows } = await pg.query(
    `SELECT DISTINCT u.id, u.username, u.full_name, u.role
     FROM crm_shifts s
     JOIN staff_users u ON u.id = s.staff_id
     WHERE s.active = TRUE AND s.weekday = $1
       AND s.start_time <= $2::time AND s.end_time >= $2::time
       AND u.active = TRUE AND u.disabled_at IS NULL`,
    [weekday, hhmm]
  );
  if (rows.length) return rows;
  // Fallback: anyone currently online (last_seen <90s) — they're around even if no shift defined
  const fallback = await pg.query(
    `SELECT id, username, full_name, role FROM staff_users
     WHERE active = TRUE AND disabled_at IS NULL
       AND last_seen_at > now() - interval '90 seconds'
     ORDER BY last_seen_at DESC LIMIT 5`
  );
  return fallback.rows;
}

// Returns the on-shift operator currently with the lightest open-handover load.
async function pickLeastLoaded() {
  const operators = await onShift();
  if (!operators.length) return null;
  const ids = operators.map((o) => o.id);
  const { rows } = await pg.query(
    `SELECT s.id, COUNT(c.id)::int AS load
     FROM staff_users s
     LEFT JOIN crm_conversation_claims c
       ON c.staff_id = s.id AND c.released_at IS NULL AND c.expires_at > now()
     WHERE s.id = ANY($1::int[])
     GROUP BY s.id ORDER BY load ASC, random() LIMIT 1`,
    [ids]
  );
  if (!rows[0]) return operators[0];
  return operators.find((o) => o.id === rows[0].id) || operators[0];
}

module.exports = { onShift, pickLeastLoaded, nowJakarta };
