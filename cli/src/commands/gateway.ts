import { select, input } from '@inquirer/prompts';
import type { Config } from '../types.ts';
import {
  dockerCompose,
  dockerComposeSafe,
  dockerComposeStream,
  gatewayContainer,
  sshSafe,
  sshStream,
  sshInteractive,
} from '../ssh.ts';
import { header, info, fail, printOutput } from '../ui.ts';

export async function gatewayMenu(cfg: Config): Promise<void> {
  while (true) {
    header('Gateway (Docker)');
    const action = await select({
      message: 'Gateway management',
      choices: [
        { name: 'Container status', value: 'ps' },
        { name: 'Health check', value: 'health' },
        { name: 'View logs', value: 'logs' },
        { name: 'Start stack', value: 'start' },
        { name: 'Stop stack', value: 'stop' },
        { name: 'Restart stack', value: 'restart' },
        { name: 'Shell into container', value: 'shell' },
        { name: 'Back', value: 'back' },
      ],
    });

    if (action === 'back') return;

    switch (action) {
      case 'ps': {
        const r = await dockerComposeSafe(cfg, 'vps1', 'ps');
        if (r.ok) printOutput(r.stdout);
        else fail(r.stderr);
        break;
      }
      case 'health': {
        const r = await sshSafe(cfg, 'vps1', 'curl -sf http://localhost:18789/health');
        if (r.ok) {
          info('Gateway healthy');
          printOutput(r.stdout);
        } else {
          fail('Gateway health check failed');
          if (r.stderr) printOutput(r.stderr);
        }
        break;
      }
      case 'logs': {
        const mode = await select({
          message: 'Log mode',
          choices: [
            { name: 'Tail (last 100 lines)', value: 'tail' },
            { name: 'Tail (last N lines)', value: 'tailn' },
            { name: 'Follow (live)', value: 'follow' },
          ],
        });
        if (mode === 'follow') {
          info('Streaming gateway logs... Press Ctrl+C to stop.');
          await sshStream(cfg, 'vps1', `sudo docker logs -f ${gatewayContainer(cfg)}`);
        } else if (mode === 'tailn') {
          const n = await input({ message: 'Number of lines:', default: '50' });
          const r = await sshSafe(cfg, 'vps1', `sudo docker logs --tail ${n} ${gatewayContainer(cfg)}`);
          printOutput(r.stdout || r.stderr);
        } else {
          const r = await sshSafe(cfg, 'vps1', `sudo docker logs --tail 100 ${gatewayContainer(cfg)}`);
          printOutput(r.stdout || r.stderr);
        }
        break;
      }
      case 'start':
        info('Starting gateway stack...');
        printOutput(await dockerCompose(cfg, 'vps1', 'up -d'));
        info('Done.');
        break;
      case 'stop':
        info('Stopping gateway stack...');
        printOutput(await dockerCompose(cfg, 'vps1', 'down'));
        info('Done.');
        break;
      case 'restart':
        info('Restarting gateway stack...');
        printOutput(await dockerCompose(cfg, 'vps1', 'restart'));
        info('Done.');
        break;
      case 'shell':
        info('Opening shell in gateway container... Type "exit" to return.');
        await sshInteractive(cfg, 'vps1', `sudo docker exec -it ${gatewayContainer(cfg)} /bin/sh`);
        break;
    }
  }
}
