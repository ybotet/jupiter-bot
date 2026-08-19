import test from 'node:test';
import assert from 'node:assert/strict';

import { MempoolWatcher, resolveDexProgramIds } from './mempoolWatcher';

test('resolveDexProgramIds reads configured DEX program IDs from environment', () => {
  const previous = process.env.DEX_PROGRAM_IDS;
  process.env.DEX_PROGRAM_IDS = 'ProgramA, ProgramB';

  try {
    assert.deepEqual(resolveDexProgramIds(), ['ProgramA', 'ProgramB']);
  } finally {
    if (previous === undefined) {
      delete process.env.DEX_PROGRAM_IDS;
    } else {
      process.env.DEX_PROGRAM_IDS = previous;
    }
  }
});

test('MempoolWatcher filters logs by configured DEX program IDs', () => {
  const watcher = new MempoolWatcher('ws://localhost:8900', ['ProgramA', 'ProgramB']);
  const filtered = (watcher as any).extractProgramIds([
    'ProgramX instruction',
    'ProgramA instruction',
    'ProgramB instruction',
  ]);

  assert.deepEqual(filtered, ['ProgramA', 'ProgramB']);
});
