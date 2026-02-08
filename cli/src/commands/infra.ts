import { select } from '@inquirer/prompts';
import type { Config } from '../types.ts';
import { sshSafe } from '../ssh.ts';
import { header, ok, fail, printOutput, vpsLabel } from '../ui.ts';

async function runOnVps(cfg: Config, label: string, cmd: string): Promise<void> {
  const r = await sshSafe(cfg, 'vps1', cmd);

  console.log(`\n  ${vpsLabel('vps1')} ${label}`);
  if (r.ok) printOutput(r.stdout);
  else fail(r.stderr);

  console.log();
}

export async function infraMenu(cfg: Config): Promise<void> {
  while (true) {
    header('Infrastructure');
    const action = await select({
      message: 'Infrastructure checks',
      choices: [
        { name: 'Firewall status', value: 'ufw' },
        { name: 'Disk usage', value: 'disk' },
        { name: 'System resources', value: 'resources' },
        { name: 'SSH connectivity', value: 'ssh' },
        { name: 'Back', value: 'back' },
      ],
    });

    if (action === 'back') return;

    switch (action) {
      case 'ufw':
        await runOnVps(cfg, 'UFW', 'sudo ufw status');
        break;
      case 'disk':
        await runOnVps(cfg, 'Disk usage', 'df -h --output=source,size,used,avail,pcent -x tmpfs -x devtmpfs 2>/dev/null || df -h');
        break;
      case 'resources':
        await runOnVps(cfg, 'System resources', 'echo "--- Memory ---" && free -h && echo "--- Uptime ---" && uptime');
        break;
      case 'ssh': {
        const r = await sshSafe(cfg, 'vps1', 'echo ok');
        r.ok ? ok(`${vpsLabel('vps1')} Connected`) : fail(`${vpsLabel('vps1')} ${r.stderr}`);
        console.log();
        break;
      }
    }
  }
}
