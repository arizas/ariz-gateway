import fs from 'node:fs';
import path from 'node:path';

// Gateway-owned mapping of which payer account is charged for monitoring each
// account: { [monitoredAccountId]: payerAccountId }. Persisted in monitors.json.
// The near-accounting-export library stays generic and knows nothing about this.

function monitorsFile(dataDir) {
    return path.join(dataDir, 'monitors.json');
}

export function loadMonitors(dataDir) {
    const f = monitorsFile(dataDir);
    if (!fs.existsSync(f)) return {};
    try {
        return JSON.parse(fs.readFileSync(f, 'utf8')).monitors || {};
    } catch {
        return {};
    }
}

export function saveMonitors(dataDir, monitors) {
    fs.writeFileSync(monitorsFile(dataDir), JSON.stringify({ monitors }, null, 2));
}

/** The payer charged for monitoring `accountId`, or null. */
export function getPayer(dataDir, accountId) {
    return loadMonitors(dataDir)[accountId] || null;
}

/** Record that `payer` pays for monitoring `accountId` (no-op if unchanged). */
export function setPayer(dataDir, accountId, payer) {
    const monitors = loadMonitors(dataDir);
    if (monitors[accountId] === payer) return;
    monitors[accountId] = payer;
    saveMonitors(dataDir, monitors);
}

/** Stop tracking `accountId` (drops its payer mapping). */
export function removeMonitor(dataDir, accountId) {
    const monitors = loadMonitors(dataDir);
    if (!(accountId in monitors)) return;
    delete monitors[accountId];
    saveMonitors(dataDir, monitors);
}
