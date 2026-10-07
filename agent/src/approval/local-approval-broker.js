export class ApprovalBrokerError extends Error {
  constructor(message, code = "APPROVAL_BROKER_ERROR") {
    super(message);
    this.name = "ApprovalBrokerError";
    this.code = code;
  }
}

export class LocalApprovalBroker {
  #pending = null;
  #maxWaitMs;

  constructor({ maxWaitMs = 120000 } = {}) {
    if (!Number.isSafeInteger(maxWaitMs) || maxWaitMs < 1000 || maxWaitMs > 300000) {
      throw new RangeError("maxWaitMs must be between 1000 and 300000.");
    }
    this.#maxWaitMs = maxWaitMs;
  }

  getPendingApproval() {
    if (!this.#pending) {
      return null;
    }

    const { resolve: _resolve, timer: _timer, ...request } = this.#pending;
    return Object.freeze({ ...request });
  }

  requestApproval(request) {
    if (this.#pending) {
      throw new ApprovalBrokerError(
        "Another approval is already pending.",
        "APPROVAL_BUSY"
      );
    }

    if (!request || typeof request !== "object") {
      throw new TypeError("request must be an object.");
    }

    const expiresAt = Date.parse(request.expires_at);
    const remaining = Number.isFinite(expiresAt)
      ? Math.max(0, expiresAt - Date.now())
      : this.#maxWaitMs;
    const waitMs = Math.min(this.#maxWaitMs, remaining);

    if (waitMs < 1000) {
      return Promise.resolve("expired");
    }

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (this.#pending?.operation_id === request.operation_id) {
          this.#pending = null;
        }
        resolve("timeout");
      }, waitMs);

      this.#pending = {
        command_id: request.command_id,
        operation_id: request.operation_id,
        tool: request.tool,
        risk: request.risk,
        summary: Object.freeze({ ...(request.summary ?? {}) }),
        requested_at: new Date().toISOString(),
        expires_at: request.expires_at,
        resolve,
        timer
      };
    });
  }

  respond(operationId, decision) {
    if (!this.#pending) {
      return { accepted: false, code: "NO_PENDING_APPROVAL" };
    }

    if (this.#pending.operation_id !== operationId) {
      return { accepted: false, code: "APPROVAL_OPERATION_MISMATCH" };
    }

    if (decision !== "approved" && decision !== "denied") {
      return { accepted: false, code: "INVALID_APPROVAL_DECISION" };
    }

    const pending = this.#pending;
    this.#pending = null;
    clearTimeout(pending.timer);
    pending.resolve(decision);

    return { accepted: true };
  }

  cancelPending() {
    if (!this.#pending) {
      return;
    }

    const pending = this.#pending;
    this.#pending = null;
    clearTimeout(pending.timer);
    pending.resolve("cancelled");
  }
}
