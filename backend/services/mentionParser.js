// @mention parser & resolver.
// Extract usernames from "@<token>" patterns in body, resolve to staff_users.id.

function extract(body) {
  if (!body) return [];
  const matches = String(body).matchAll(/@([a-zA-Z0-9._-]+)/g);
  const set = new Set();
  for (const m of matches) set.add(m[1].toLowerCase());
  return [...set];
}

async function resolve(client, usernames) {
  if (!usernames || !usernames.length) return [];
  const { rows } = await client.query(
    `SELECT id, username FROM staff_users
     WHERE LOWER(username) = ANY($1::varchar[])
       AND active = TRUE AND disabled_at IS NULL`,
    [usernames]
  );
  return rows;
}

// Combine: extract + resolve, return staff_id array.
async function parse(client, body) {
  const usernames = extract(body);
  if (!usernames.length) return [];
  const resolved = await resolve(client, usernames);
  return resolved.map((r) => r.id);
}

module.exports = { extract, resolve, parse };
