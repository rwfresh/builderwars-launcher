// Imported first by main.tsx, before any schema module is evaluated. The production CSP has no
// 'unsafe-eval': tell zod not to probe `new Function` (the probe is caught but logs a CSP error).
import { z } from "zod";

z.config({ jitless: true });
