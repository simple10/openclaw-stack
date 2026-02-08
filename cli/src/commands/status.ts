import type { Config, CheckResult } from '../types.ts';
import { sshSafe, dockerComposeSafe } from '../ssh.ts';
import { header, printResults } from '../ui.ts';

async function check(
  name: string,
  fn: () => Promise<{ ok: boolean; detail: string }>
): Promise<CheckResult> {
  try {
    const { ok, detail } = await fn();
    return { name, target: 'vps1', ok, detail };
  } catch (err) {
    return { name, target: 'vps1', ok: false, detail: String(err) };
  }
}

export async function statusDashboard(cfg: Config): Promise<void> {
  header('Status Overview');
  console.log('  Running checks on VPS-1...\n');

  const results = await Promise.allSettled([
    check('SSH connectivity', async () => {
      const r = await sshSafe(cfg, 'vps1', 'echo ok');
      return { ok: r.ok, detail: r.ok ? 'Connected' : r.stderr };
    }),
    check('Gateway container', async () => {
      const r = await dockerComposeSafe(cfg, 'vps1', 'ps --format json');
      if (!r.ok) return { ok: false, detail: 'compose ps failed' };
      const running = r.stdout.includes('"running"') || r.stdout.includes('Up');
      return { ok: running, detail: running ? 'Running' : 'Not running' };
    }),
    check('Gateway health', async () => {
      const r = await sshSafe(cfg, 'vps1', 'curl -sf http://localhost:18789/health');
      return { ok: r.ok, detail: r.ok ? r.stdout.slice(0, 50) : 'Unreachable' };
    }),
    check('Vector', async () => {
      const r = await sshSafe(cfg, 'vps1', 'sudo docker ps --filter name=vector --format "{{.Status}}"');
      const up = r.ok && r.stdout.includes('Up');
      return { ok: up, detail: up ? r.stdout : 'Not running' };
    }),
    check('Cloudflared', async () => {
      const r = await sshSafe(cfg, 'vps1', 'sudo systemctl is-active cloudflared 2>/dev/null');
      const active = r.ok && r.stdout.trim() === 'active';
      if (!active) {
        const d = await sshSafe(cfg, 'vps1', 'sudo docker ps --filter name=cloudflared --format "{{.Status}}" 2>/dev/null');
        if (d.ok && d.stdout.includes('Up')) return { ok: true, detail: 'Running (Docker)' };
      }
      return { ok: active, detail: active ? 'Active' : 'Not running' };
    }),
  ]);

  const checks = results.map((r) =>
    r.status === 'fulfilled'
      ? r.value
      : { name: 'Unknown', target: 'vps1' as const, ok: false, detail: String(r.reason) }
  );

  printResults(checks);
}
