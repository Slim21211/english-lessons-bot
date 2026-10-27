/**
 * Ручной запуск тика с локальной машины (переменные из .env):
 *   npm run tick:local
 * Можно передать время для проверки сценариев: npm run tick:local -- 2026-11-02T17:55
 */
import { DateTime } from 'luxon';
import { config } from '../src/config.js';
import { runTick } from '../src/jobs/tick.js';

const zone = config().TIME_ZONE;
const arg = process.argv[2];
const now = arg ? DateTime.fromISO(arg, { zone }) : DateTime.now().setZone(zone);

runTick(now)
  .then((result) => console.log(JSON.stringify(result, null, 2)))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
