// One line per event, prefixed like the rest of the server's logs ([email], [webhooks]...). Callers pass ids and fixed
// codes only: never a token, an authorization code, a state, a nonce or a key.

export interface Logger {
  info(detail: Record<string, unknown>, message: string): void;
  warn(detail: Record<string, unknown>, message: string): void;
  error(detail: Record<string, unknown>, message: string): void;
}

function line(message: string, detail: Record<string, unknown>): string {
  return `[workeasy360] ${message} ${JSON.stringify(detail)}`;
}

// The test suites drive hundreds of requests; their logs stay quiet unless asked for (W360_TEST_LOGS=1).
const quiet = () => process.env.NODE_ENV === 'test' && process.env.W360_TEST_LOGS !== '1';

export const log: Logger = {
  info: (detail, message) => { if (!quiet()) console.log(line(message, detail)); },
  warn: (detail, message) => { if (!quiet()) console.warn(line(message, detail)); },
  error: (detail, message) => { if (!quiet()) console.error(line(message, detail)); },
};
