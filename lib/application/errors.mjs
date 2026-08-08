export class CortexError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "CortexError";
    this.code = code;
    this.details = details;
  }
}

export function fail(code, message, details) {
  throw new CortexError(code, message, details);
}
