// One-shot: set WA business profile (name, status/about, picture) for the
// active WAHA session. Run once after first login.
//
// Usage:
//   cd /home/krttpt/crm/backend
//   node scripts/setupWaProfile.js                          # interactive defaults
//   node scripts/setupWaProfile.js --name "Prestisa" --status "Toko bunga online" --picture-url https://...
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const waClient = require('../services/waClient');
const logger = require('../services/logger');

function arg(name, fallback) {
  const i = process.argv.indexOf('--' + name);
  if (i > -1 && process.argv[i + 1]) return process.argv[i + 1];
  return fallback;
}

async function main() {
  const session = arg('session', process.env.WAHA_SESSION || 'finance0000');
  const name = arg('name', 'Prestisa - Toko Bunga Online');
  const status = arg('status', 'Karangan bunga, bouquet, parsel & cake. Free ongkir Jabodetabek. WA: 24/7 order, CS 08-22 WIB.');
  const pictureUrl = arg('picture-url', null);

  logger.info({ session, name, status, picture: !!pictureUrl }, '[wa-setup] starting');

  // 1. Read current profile (sanity check)
  const before = await waClient.getProfile({ session });
  logger.info({ before }, '[wa-setup] current profile');

  // 2. Set name
  try {
    await waClient.setProfileName({ session, name });
    logger.info('[wa-setup] name set ✓');
  } catch (err) { logger.error({ err: err.message }, 'name failed'); }

  // 3. Set status / about
  try {
    await waClient.setProfileStatus({ session, status });
    logger.info('[wa-setup] status set ✓');
  } catch (err) { logger.error({ err: err.message }, 'status failed'); }

  // 4. Set profile picture (skip if none provided)
  if (pictureUrl) {
    try {
      await waClient.setProfilePicture({ session, fileUrl: pictureUrl });
      logger.info('[wa-setup] picture set ✓');
    } catch (err) { logger.error({ err: err.message }, 'picture failed'); }
  } else {
    logger.warn('[wa-setup] picture-url not provided — skipped. Re-run with --picture-url https://...');
  }

  // 5. Verify
  const after = await waClient.getProfile({ session });
  logger.info({ after }, '[wa-setup] profile after');
  process.exit(0);
}

main().catch((err) => { logger.error({ err: err.message }, '[wa-setup] failed'); process.exit(1); });
