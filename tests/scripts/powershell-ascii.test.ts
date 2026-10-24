import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The shop PC runs these with Windows PowerShell 5.1, which reads a script
 * without a byte-order mark as Windows-1252. An em dash's UTF-8 bytes include
 * 0x94, a closing curly quote there, so one dash in a string ended it early and
 * setup-desktop-access.ps1 would not even parse on the shop PC. Plain ASCII
 * reads the same in every encoding.
 */
const SCRIPTS = join(process.cwd(), 'scripts');

describe('PowerShell scripts run on the shop PC', () => {
  const files = readdirSync(SCRIPTS).filter((name) => name.endsWith('.ps1'));

  it.each(files)('%s is plain ASCII', (name) => {
    const lines = readFileSync(join(SCRIPTS, name), 'utf8').split('\n');
    const offending = lines.flatMap((line, index) => (/[^\x00-\x7F]/.test(line) ? [`${index + 1}: ${line.trim()}`] : []));
    expect(offending).toEqual([]);
  });
});
