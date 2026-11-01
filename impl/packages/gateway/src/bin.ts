#!/usr/bin/env node
// rdv-gateway. The commands are in main.ts; this runs them with the process's own terminal check (issue #126).
// First: stdout carries the command's output, never a dependency's console text (review of PR #120).
import '@rendezvous/core/safe-console';
import { gatewayMain } from './main.js';

await gatewayMain(process.argv.slice(2));
