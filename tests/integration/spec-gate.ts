import { env } from 'fino:process';
export const specSuitesEnabled = env.FINO_SPEC_TESTS === '1';
export const specSuiteSkipReason = 'set FINO_SPEC_TESTS=1 to run external spec validation suites';
