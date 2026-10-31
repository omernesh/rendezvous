// Side effect only: import first in an entry point whose stdout is a protocol or JSON output (safeconsole.ts).
import { installSafeConsole } from './safeconsole.js';

installSafeConsole();
