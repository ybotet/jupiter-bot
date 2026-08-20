import test from 'node:test';
import assert from 'node:assert/strict';

import { MempoolWatcher, resolveDexProgramIds } from './mempoolWatcher';

/** Comprueba que los identificadores DEX se leen desde el entorno. */
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

/** Comprueba que el watcher conserva únicamente programas DEX configurados. */
test('MempoolWatcher filters logs by configured DEX program IDs', () => {
  const watcher = new MempoolWatcher('ws://localhost:8900', ['ProgramA', 'ProgramB']);
  const filtered = watcher.filterProgramIds([
    'ProgramX instruction',
    'ProgramA instruction',
    'ProgramB instruction',
  ]);

  assert.deepEqual(filtered, ['ProgramA', 'ProgramB']);
});
