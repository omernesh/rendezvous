import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { VERSION } from '@rendezvous/core';
import { describe, expect, it } from 'vitest';
import { openApi } from '../src/openapi.js';

describe('release version', () => {
  it('VERSION and the OpenAPI document match the plugin manifest', () => {
    const manifest = JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', '..', '..', 'plugins', 'rendezvous', '.claude-plugin', 'plugin.json'), 'utf8'));
    expect(VERSION).toBe(manifest.version);
    expect((openApi([], 'https://x.example').info as { version: string }).version).toBe(manifest.version);
  });
});
