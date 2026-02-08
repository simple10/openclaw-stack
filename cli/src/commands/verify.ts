import type { Config, CheckResult } from '../types.ts';
import { sshSafe, dockerComposeSafe } from '../ssh.ts';
import { header, printResults } from '../ui.ts';

async function check(
  name: string,
  fn: () => Promise<{ ok: boolean; detail: string }>
): Promise<CheckResult> {
  try {
    return { name, target: 'vps1', ...(await fn()) };
  } catch (err) {
    return { name, target: 'vps1', ok: false, detail: String(err) };
  }
}

export async function runVerification(cfg: Config): Promise<void> {
  header('Full Verification Suite');
  console.log('  Running all checks from 07-verification.md...\n');

  // 7.1 OpenClaw (VPS-1)
  const oclawChecks = await Promise.all([
    check('Gateway containers running', async () => {
      const r = await dockerComposeSafe(cfg, 'vps1', 'ps');
      const up = r.ok && (r.stdout.includes('Up') || r.stdout.includes('running'));
      return { ok: up, detail: up ? 'Running' : 'Not running' };
    }),
    check('Gateway health endpoint', async () => {
      const r = await sshSafe(cfg, 'vps1', 'curl -sf http://localhost:18789/health');
      return { ok: r.ok, detail: r.ok ? r.stdout.slice(0, 50) : 'Unreachable' };
    }),
  ]);

  // 7.2 Vector (log shipping)
  const vectorChecks = await Promise.all([
    check('Vector running', async () => {
      const r = await sshSafe(cfg, 'vps1', 'sudo docker ps --filter name=vector --format "{{.Status}}"');
      const up = r.ok && r.stdout.includes('Up');
      return { ok: up, detail: up ? r.stdout.trim() : 'Not running' };
    }),
  ]);

  // 7.4 External access
  const networkingChecks = await Promise.all([
    check('Cloudflared service', async () => {
      const r = await sshSafe(cfg, 'vps1', 'sudo systemctl is-active cloudflared 2>/dev/null');
      const active = r.ok && r.stdout.trim() === 'active';
      if (!active) {
        const d = await sshSafe(cfg, 'vps1', 'sudo docker ps --filter name=cloudflared --format "{{.Status}}" 2>/dev/null');
        if (d.ok && d.stdout.includes('Up')) return { ok: true, detail: 'Running (Docker)' };
      }
      return { ok: active, detail: active ? 'Active' : 'Not running' };
    }),
  ]);

  // 7.5 Host alerter
  const alerterChecks = await Promise.all([
    check('Host alerter cron job', async () => {
      const r = await sshSafe(cfg, 'vps1', 'sudo cat /etc/cron.d/openclaw-alerts 2>/dev/null | head -1');
      return { ok: r.ok && r.stdout.trim().length > 0, detail: r.ok ? 'Configured' : 'Missing' };
    }),
  ]);

  // 7.6 Security
  const secChecks = await Promise.all([
    check('UFW active', async () => {
      const r = await sshSafe(cfg, 'vps1', 'sudo ufw status | head -1');
      const active = r.ok && r.stdout.includes('active');
      return { ok: active, detail: active ? 'Active' : r.stdout.trim() };
    }),
    check('Fail2ban running', async () => {
      const r = await sshSafe(cfg, 'vps1', 'sudo systemctl is-active fail2ban');
      return { ok: r.ok && r.stdout.trim() === 'active', detail: r.stdout.trim() };
    }),
    check('SSH on port 222', async () => {
      const r = await sshSafe(cfg, 'vps1', 'ss -tlnp | grep 222');
      return { ok: r.ok && r.stdout.includes(':222'), detail: r.ok ? 'Listening' : 'Not found' };
    }),
    check('Sysbox runtime', async () => {
      const r = await sshSafe(cfg, 'vps1', 'sudo systemctl is-active sysbox');
      return { ok: r.ok && r.stdout.trim() === 'active', detail: r.stdout.trim() };
    }),
    check('Backup cron job', async () => {
      const r = await sshSafe(cfg, 'vps1', 'sudo cat /etc/cron.d/openclaw-backup 2>/dev/null | head -1');
      return { ok: r.ok && r.stdout.trim().length > 0, detail: r.ok ? 'Configured' : 'Missing' };
    }),
  ]);

  const all = [
    ...oclawChecks,
    ...vectorChecks,
    ...networkingChecks,
    ...alerterChecks,
    ...secChecks,
  ];

  printResults(all);
}
