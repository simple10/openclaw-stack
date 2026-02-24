import { select, input } from '@inquirer/prompts';
import type { Config } from '../types.ts';
import { openclawCmd, openclawCmdSafe, sshStream, sshInteractive, openclawExecPrefix, openclawExecItPrefix } from '../ssh.ts';
import { header, printOutput, info, fail } from '../ui.ts';

async function runAndPrint(cfg: Config, args: string): Promise<void> {
  info(`openclaw ${args}`);
  const result = await openclawCmdSafe(cfg, args);
  if (result.ok) {
    printOutput(result.stdout);
  } else {
    fail(`Exit code ${result.exitCode}`);
    if (result.stderr) printOutput(result.stderr);
    if (result.stdout) printOutput(result.stdout);
  }
}

async function statusHealthMenu(cfg: Config): Promise<void> {
  const action = await select({
    message: 'Status & Health',
    choices: [
      { name: 'Status', value: 'status' },
      { name: 'Health', value: 'health' },
      { name: 'Doctor', value: 'doctor' },
      { name: 'Back', value: 'back' },
    ],
  });
  if (action === 'back') return;
  const cmds: Record<string, string> = {
    status: 'status --all',
    health: 'health',
    doctor: 'doctor',
  };
  await runAndPrint(cfg, cmds[action]);
}

async function configMenu(cfg: Config): Promise<void> {
  const action = await select({
    message: 'Configuration',
    choices: [
      { name: 'Get config value', value: 'get' },
      { name: 'Set config value', value: 'set' },
      { name: 'Show config schema', value: 'schema' },
      { name: 'Interactive configure', value: 'configure' },
      { name: 'Back', value: 'back' },
    ],
  });
  if (action === 'back') return;
  switch (action) {
    case 'get': {
      const key = await input({ message: 'Config key:' });
      await runAndPrint(cfg, `config get ${key}`);
      break;
    }
    case 'set': {
      const key = await input({ message: 'Config key:' });
      const value = await input({ message: 'Value:' });
      await runAndPrint(cfg, `config set ${key} ${value}`);
      break;
    }
    case 'schema':
      await runAndPrint(cfg, 'config schema');
      break;
    case 'configure': {
      const section = await input({ message: 'Section (leave blank for all):' });
      const args = section ? `configure --section ${section}` : 'configure';
      // Interactive command needs PTY
      await sshInteractive(cfg, 'vps1', `${openclawExecItPrefix(cfg)} ${args}`);
      break;
    }
  }
}

async function channelsMenu(cfg: Config): Promise<void> {
  const action = await select({
    message: 'Channels',
    choices: [
      { name: 'List channels', value: 'list' },
      { name: 'Channel status', value: 'status' },
      { name: 'Channel logs', value: 'logs' },
      { name: 'Channel capabilities', value: 'capabilities' },
      { name: 'Back', value: 'back' },
    ],
  });
  if (action === 'back') return;
  switch (action) {
    case 'list':
      await runAndPrint(cfg, 'channels list');
      break;
    case 'status':
      await runAndPrint(cfg, 'channels status');
      break;
    case 'logs': {
      const ch = await input({ message: 'Channel name (or "all"):' });
      await runAndPrint(cfg, `channels logs --channel ${ch}`);
      break;
    }
    case 'capabilities':
      await runAndPrint(cfg, 'channels capabilities');
      break;
  }
}

async function modelsMenu(cfg: Config): Promise<void> {
  const action = await select({
    message: 'Models',
    choices: [
      { name: 'List models', value: 'list' },
      { name: 'Model status', value: 'status' },
      { name: 'Set model', value: 'set' },
      { name: 'Manage aliases', value: 'aliases' },
      { name: 'Back', value: 'back' },
    ],
  });
  if (action === 'back') return;
  switch (action) {
    case 'list':
      await runAndPrint(cfg, 'models list');
      break;
    case 'status':
      await runAndPrint(cfg, 'models status');
      break;
    case 'set': {
      const model = await input({ message: 'Model (provider/model):' });
      await runAndPrint(cfg, `models set ${model}`);
      break;
    }
    case 'aliases': {
      const sub = await select({
        message: 'Alias action',
        choices: [
          { name: 'List aliases', value: 'list' },
          { name: 'Add alias', value: 'add' },
          { name: 'Remove alias', value: 'remove' },
        ],
      });
      if (sub === 'list') {
        await runAndPrint(cfg, 'models aliases list');
      } else if (sub === 'add') {
        const alias = await input({ message: 'Alias name:' });
        const model = await input({ message: 'Model:' });
        await runAndPrint(cfg, `models aliases add ${alias} ${model}`);
      } else {
        const alias = await input({ message: 'Alias to remove:' });
        await runAndPrint(cfg, `models aliases remove ${alias}`);
      }
      break;
    }
  }
}

async function agentMenu(cfg: Config): Promise<void> {
  const action = await select({
    message: 'Agent',
    choices: [
      { name: 'Run agent', value: 'run' },
      { name: 'List agents', value: 'list' },
      { name: 'Back', value: 'back' },
    ],
  });
  if (action === 'back') return;
  if (action === 'list') {
    await runAndPrint(cfg, 'agents list');
  } else {
    const msg = await input({ message: 'Message for agent:' });
    const thinking = await select({
      message: 'Thinking level',
      choices: [
        { name: 'Default', value: '' },
        { name: 'Low', value: 'low' },
        { name: 'Medium', value: 'medium' },
        { name: 'High', value: 'high' },
      ],
    });
    const args = thinking
      ? `agent --message "${msg}" --thinking ${thinking}`
      : `agent --message "${msg}"`;
    await runAndPrint(cfg, args);
  }
}

async function cronMenu(cfg: Config): Promise<void> {
  const action = await select({
    message: 'Scheduler (Cron)',
    choices: [
      { name: 'List jobs', value: 'list' },
      { name: 'Add job', value: 'add' },
      { name: 'Run job', value: 'run' },
      { name: 'View run history', value: 'runs' },
      { name: 'Remove job', value: 'remove' },
      { name: 'Back', value: 'back' },
    ],
  });
  if (action === 'back') return;
  switch (action) {
    case 'list':
      await runAndPrint(cfg, 'cron list');
      break;
    case 'add':
      // Interactive — needs PTY
      await sshInteractive(cfg, 'vps1', `${openclawExecItPrefix(cfg)} cron add`);
      break;
    case 'run': {
      const id = await input({ message: 'Job ID:' });
      await runAndPrint(cfg, `cron run ${id}`);
      break;
    }
    case 'runs': {
      const id = await input({ message: 'Job ID:' });
      await runAndPrint(cfg, `cron runs --id ${id}`);
      break;
    }
    case 'remove': {
      const id = await input({ message: 'Job ID to remove:' });
      await runAndPrint(cfg, `cron remove ${id}`);
      break;
    }
  }
}

async function nodesMenu(cfg: Config): Promise<void> {
  const action = await select({
    message: 'Nodes',
    choices: [
      { name: 'List nodes', value: 'list' },
      { name: 'Pending requests', value: 'pending' },
      { name: 'Back', value: 'back' },
    ],
  });
  if (action === 'back') return;
  if (action === 'list') await runAndPrint(cfg, 'nodes list');
  else await runAndPrint(cfg, 'nodes pending');
}

export async function openclawMenu(cfg: Config): Promise<void> {
  while (true) {
    header('OpenClaw');
    const action = await select({
      message: 'OpenClaw commands',
      choices: [
        { name: 'Status & Health', value: 'status' },
        { name: 'Configuration', value: 'config' },
        { name: 'Channels', value: 'channels' },
        { name: 'Models', value: 'models' },
        { name: 'Agent', value: 'agent' },
        { name: 'Skills', value: 'skills' },
        { name: 'Sessions', value: 'sessions' },
        { name: 'Scheduler (Cron)', value: 'cron' },
        { name: 'Nodes', value: 'nodes' },
        { name: 'Logs', value: 'logs' },
        { name: 'Security audit', value: 'security' },
        { name: 'Run custom command', value: 'custom' },
        { name: 'Back', value: 'back' },
      ],
    });

    if (action === 'back') return;

    switch (action) {
      case 'status':
        await statusHealthMenu(cfg);
        break;
      case 'config':
        await configMenu(cfg);
        break;
      case 'channels':
        await channelsMenu(cfg);
        break;
      case 'models':
        await modelsMenu(cfg);
        break;
      case 'agent':
        await agentMenu(cfg);
        break;
      case 'skills': {
        const eligible = await select({
          message: 'List skills',
          choices: [
            { name: 'All skills', value: 'list' },
            { name: 'Eligible skills', value: 'eligible' },
            { name: 'Back', value: 'back' },
          ],
        });
        if (eligible === 'list') await runAndPrint(cfg, 'skills list');
        else if (eligible === 'eligible') await runAndPrint(cfg, 'skills list --eligible');
        break;
      }
      case 'sessions': {
        const min = await input({ message: 'Active within N minutes (leave blank for all):' });
        const args = min ? `sessions --active ${min}` : 'sessions';
        await runAndPrint(cfg, args);
        break;
      }
      case 'cron':
        await cronMenu(cfg);
        break;
      case 'nodes':
        await nodesMenu(cfg);
        break;
      case 'logs': {
        const follow = await select({
          message: 'Logs',
          choices: [
            { name: 'Recent (tail)', value: 'tail' },
            { name: 'Follow (live)', value: 'follow' },
          ],
        });
        if (follow === 'follow') {
          info('Streaming logs... Press Ctrl+C to stop.');
          await sshStream(cfg, 'vps1', `${openclawExecPrefix(cfg)} logs --follow`);
        } else {
          await runAndPrint(cfg, 'logs');
        }
        break;
      }
      case 'security': {
        const deep = await select({
          message: 'Security audit',
          choices: [
            { name: 'Standard', value: 'standard' },
            { name: 'Deep scan', value: 'deep' },
          ],
        });
        await runAndPrint(cfg, deep === 'deep' ? 'security audit --deep' : 'security audit');
        break;
      }
      case 'custom': {
        const cmd = await input({ message: 'openclaw' });
        if (cmd.trim()) await runAndPrint(cfg, cmd);
        break;
      }
    }
  }
}

/**
 * Direct command mode: `./cli.mjs oc <args>`
 */
export async function openclawDirect(cfg: Config, args: string): Promise<void> {
  const result = await openclawCmdSafe(cfg, args);
  if (result.stdout) console.log(result.stdout);
  if (result.stderr) console.error(result.stderr);
  process.exitCode = result.exitCode;
}
