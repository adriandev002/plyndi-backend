// User counts for the admin "Users" tab — GET /v1/admin/user-stats (src/routes/admin.js).
//
// Both stores (memoryStore.js, postgresStore.js) gather the same two raw inputs and hand them to
// summarize() here, so the counting rules live in exactly one place:
//   installs: [{ deviceId, day }]       — each device once, `day` = Taiwan day of its FIRST EVER
//                                         onboarding_started (so a reinstall never counts twice:
//                                         the device ID lives in the Keychain and survives it).
//   events:   [{ event, deviceId, day }] — one row per (event, device, Taiwan day) inside the range.
//
// Days are Taiwan calendar days (Asia/Taipei, UTC+8 all year — Taiwan has no daylight saving).
// Rows with no deviceId are ignored (they can't be counted per person). Rows whose `build`
// property is "debug" or "testflight" are dropped by the stores before they get here; app 1.0
// sends no `build` at all, so those rows still count. ANALYTICS_EXCLUDE_DEVICE_IDS (comma-
// separated) drops the owner's own test devices.

const TAIPEI_OFFSET_MS = 8 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const TIMEZONE = 'Asia/Taipei';

// Builds that are not real users. Sent by app 1.0.1+ as properties.build.
const TEST_BUILDS = ['debug', 'testflight'];

// Metric name -> analytics event counted as distinct devices.
const METRIC_EVENTS = {
  activeUsers: 'app_opened',
  finishedOnboarding: 'onboarding_completed',
  activated: 'user_activated',
  trialsStarted: 'trial_started',
  purchases: 'purchased',
};
const INSTALL_EVENT = 'onboarding_started';
const OPEN_EVENT = 'app_opened';
// Day-N retention: of the devices that first installed on day X, the share that sent app_opened
// on day X+N. Shown only for cohorts where the answer is knowable: day X+N is inside the range,
// and day X is on/after the first app_opened seen in the range (app 1.0 never sends it, so
// earlier cohorts would read a false 0%).
const RETENTION_DAYS = [1, 7];
const METRICS = ['newInstalls', ...Object.keys(METRIC_EVENTS)];

function taipeiDay(date) {
  return new Date(date.getTime() + TAIPEI_OFFSET_MS).toISOString().slice(0, 10);
}

function todayTaipei(now = new Date()) {
  return taipeiDay(now);
}

function addDays(day, n) {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
}

// [fromTs, toTs) covering fromDay 00:00 to the end of toDay, Taiwan time.
function dayBounds(fromDay, toDay) {
  return {
    fromTs: new Date(Date.parse(`${fromDay}T00:00:00Z`) - TAIPEI_OFFSET_MS),
    toTs: new Date(Date.parse(`${toDay}T00:00:00Z`) - TAIPEI_OFFSET_MS + DAY_MS),
  };
}

function excludedDeviceIds(raw = process.env.ANALYTICS_EXCLUDE_DEVICE_IDS) {
  return new Set(
    String(raw || '')
      .split(',')
      .map((id) => id.trim().toLowerCase())
      .filter(Boolean)
  );
}

function emptyCounts() {
  return Object.fromEntries(METRICS.map((m) => [m, 0]));
}

function summarize({ fromDay, toDay, installs, events, exclude }) {
  const skip = (deviceId) => !deviceId || exclude.has(String(deviceId).toLowerCase());

  const days = new Map();
  for (let day = fromDay; day <= toDay; day = addDays(day, 1)) days.set(day, emptyCounts());
  const totals = emptyCounts();

  for (const { deviceId, day } of installs) {
    if (skip(deviceId) || !days.has(day)) continue;
    days.get(day).newInstalls += 1;
    totals.newInstalls += 1;
  }

  const metricFor = Object.fromEntries(Object.entries(METRIC_EVENTS).map(([m, e]) => [e, m]));
  const perDay = new Map(); // `${metric}|${day}` -> Set(deviceId)
  const perRange = new Map(); // metric -> Set(deviceId)
  for (const { event, deviceId, day } of events) {
    const metric = metricFor[event];
    if (!metric || skip(deviceId) || !days.has(day)) continue;
    const id = String(deviceId).toLowerCase();
    const dayKey = `${metric}|${day}`;
    if (!perDay.has(dayKey)) perDay.set(dayKey, new Set());
    perDay.get(dayKey).add(id);
    if (!perRange.has(metric)) perRange.set(metric, new Set());
    perRange.get(metric).add(id);
  }
  for (const [key, ids] of perDay) {
    const [metric, day] = key.split('|');
    days.get(day)[metric] = ids.size;
  }
  // Totals are distinct devices across the whole range, not a sum of the days.
  for (const [metric, ids] of perRange) totals[metric] = ids.size;

  // ---- retention
  const openedOn = new Map(); // day -> Set(deviceId)
  for (const { event, deviceId, day } of events) {
    if (event !== OPEN_EVENT || skip(deviceId) || !days.has(day)) continue;
    if (!openedOn.has(day)) openedOn.set(day, new Set());
    openedOn.get(day).add(String(deviceId).toLowerCase());
  }
  const firstOpenDay = openedOn.size ? [...openedOn.keys()].sort()[0] : null;
  const retentionByDay = new Map(); // day -> { d1: {cohort, retained} | null, d7: ... }
  const retentionTotals = Object.fromEntries(RETENTION_DAYS.map((n) => [`d${n}`, { cohort: 0, retained: 0 }]));
  for (const day of days.keys()) {
    const row = {};
    for (const n of RETENTION_DAYS) row[`d${n}`] = null;
    retentionByDay.set(day, row);
  }
  for (const { deviceId, day } of installs) {
    if (skip(deviceId) || !days.has(day)) continue;
    for (const n of RETENTION_DAYS) {
      const target = addDays(day, n);
      if (firstOpenDay === null || day < firstOpenDay || target > toDay) continue;
      const key = `d${n}`;
      const row = retentionByDay.get(day);
      if (!row[key]) row[key] = { cohort: 0, retained: 0 };
      row[key].cohort += 1;
      retentionTotals[key].cohort += 1;
      if (openedOn.has(target) && openedOn.get(target).has(String(deviceId).toLowerCase())) {
        row[key].retained += 1;
        retentionTotals[key].retained += 1;
      }
    }
  }

  return {
    days: [...days.entries()].map(([day, counts]) => ({ day, ...counts, retention: retentionByDay.get(day) })),
    totals,
    retention: retentionTotals,
    // Taiwan day of the first app_opened in the range (null until app 1.0.1 is out): retention
    // and active users only mean something from this day on.
    appOpenedSince: firstOpenDay,
  };
}

module.exports = {
  TIMEZONE,
  TEST_BUILDS,
  METRIC_EVENTS,
  INSTALL_EVENT,
  OPEN_EVENT,
  RETENTION_DAYS,
  taipeiDay,
  todayTaipei,
  addDays,
  dayBounds,
  excludedDeviceIds,
  summarize,
};
