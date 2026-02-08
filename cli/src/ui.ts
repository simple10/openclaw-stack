import chalk from 'chalk';
import type { CheckResult, VpsTarget } from './types.ts';

export const ok = (msg: string) => console.log(chalk.green('  PASS ') + msg);
export const fail = (msg: string) => console.log(chalk.red('  FAIL ') + msg);
export const warn = (msg: string) => console.log(chalk.yellow('  WARN ') + msg);
export const info = (msg: string) => console.log(chalk.blue('  INFO ') + msg);

export function header(title: string): void {
  console.log();
  console.log(chalk.bold.cyan(`── ${title} ──`));
  console.log();
}

export function subheader(title: string): void {
  console.log(chalk.dim(`  ${title}`));
}

export function vpsLabel(target: VpsTarget): string {
  return chalk.magenta('[VPS-1]');
}

export function printResult(r: CheckResult): void {
  const label = vpsLabel(r.target);
  if (r.ok) {
    ok(`${label} ${r.name}${r.detail ? chalk.dim(` — ${r.detail}`) : ''}`);
  } else {
    fail(`${label} ${r.name}${r.detail ? chalk.dim(` — ${r.detail}`) : ''}`);
  }
}

export function printResults(results: CheckResult[]): void {
  const passed = results.filter((r) => r.ok).length;
  const total = results.length;
  for (const r of results) printResult(r);
  console.log();
  if (passed === total) {
    console.log(chalk.green.bold(`  All ${total} checks passed.`));
  } else {
    console.log(
      chalk.yellow.bold(`  ${passed}/${total} checks passed, ${total - passed} failed.`)
    );
  }
  console.log();
}

export function printOutput(output: string): void {
  if (output) console.log(output);
}

export function divider(): void {
  console.log(chalk.dim('  ─────────────────────────────────'));
}
