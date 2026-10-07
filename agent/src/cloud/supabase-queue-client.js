const DEFAULT_WAIT_MS = 15000;
const MAX_WAIT_MS = 15000;

export class QueueClientError extends Error {
  constructor(message, code = "QUEUE_CLIENT_ERROR", options = undefined) {
    super(message, options);
    this.name = "QueueClientError";
    this.code = code;
  }
}

function requireString(value, name) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(name + " must be a non-empty string.");
  }
  return value.trim();
}

function boundedWaitMs(value) {
  const resolved = value ?? DEFAULT_WAIT_MS;

  if (!Number.isSafeInteger(resolved) || resolved < 0 || resolved > MAX_WAIT_MS) {
    throw new RangeError(
      "waitMs must be an integer between 0 and " + MAX_WAIT_MS + "."
    );
  }

  return resolved;
}

function normalizeEndpoint(value) {
  const raw = requireString(value, "endpointUrl").replace(/\/+$/, "");
  let parsed;

  try {
    parsed = new URL(raw);
  } catch (error) {
    throw new TypeError("endpointUrl must be a valid HTTPS URL.", {
      cause: error
    });
  }

  if (parsed.protocol !== "https:") {
    throw new TypeError("endpointUrl must use HTTPS.");
  }

  return parsed.toString().replace(/\/$/, "");
}

async function parseJsonResponse(response) {
  const text = await response.text();
  let body;

  try {
    body = text ? JSON.parse(text) : {};
  } catch (error) {
    throw new QueueClientError(
      "Queue endpoint returned invalid JSON.",
      "INVALID_JSON_RESPONSE",
      { cause: error }
    );
  }

  if (!response.ok) {
    const remoteCode =
      typeof body?.error === "string"
        ? body.error
        : typeof body?.code === "string"
          ? body.code
          : "HTTP_" + response.status;

    const message =
      typeof body?.message === "string"
        ? body.message
        : "Queue request failed with HTTP " + response.status + ".";

    throw new QueueClientError(message, remoteCode);
  }

  return body;
}

export class SupabaseQueueClient {
  #endpointUrl;
  #deviceToken;
  #deviceId;
  #agentVersion;
  #fetch;

  constructor({
    endpointUrl,
    deviceToken,
    deviceId,
    agentVersion = "0.1.0",
    fetchImpl = globalThis.fetch
  }) {
    this.#endpointUrl = normalizeEndpoint(endpointUrl);
    this.#deviceToken = requireString(deviceToken, "deviceToken");
    this.#deviceId = requireString(deviceId, "deviceId");
    this.#agentVersion = requireString(agentVersion, "agentVersion");

    if (typeof fetchImpl !== "function") {
      throw new TypeError("fetchImpl must be a function.");
    }

    this.#fetch = fetchImpl;
  }

  async #post(pathname, body) {
    let response;

    try {
      response = await this.#fetch(this.#endpointUrl + pathname, {
        method: "POST",
        headers: {
          authorization: "Bearer " + this.#deviceToken,
          "content-type": "application/json",
          accept: "application/json"
        },
        body: JSON.stringify(body)
      });
    } catch (error) {
      throw new QueueClientError(
        "Unable to reach the queue endpoint.",
        "NETWORK_ERROR",
        { cause: error }
      );
    }

    return parseJsonResponse(response);
  }

  async poll({ waitMs = DEFAULT_WAIT_MS } = {}) {
    const response = await this.#post("/poll", {
      wait_ms: boundedWaitMs(waitMs),
      agent_version: this.#agentVersion
    });

    if (response?.success !== true) {
      throw new QueueClientError(
        "Queue poll was not successful.",
        "POLL_REJECTED"
      );
    }

    if (response.command === null || response.command === undefined) {
      return null;
    }

    if (
      !response.command
      || typeof response.command !== "object"
      || Array.isArray(response.command)
    ) {
      throw new QueueClientError(
        "Queue endpoint returned an invalid command.",
        "INVALID_COMMAND_RESPONSE"
      );
    }

    if (response.command.device_id !== this.#deviceId) {
      throw new QueueClientError(
        "Queue command device_id does not match the configured device.",
        "DEVICE_ID_MISMATCH"
      );
    }

    return Object.freeze({
      ...response.command,
      args: Object.freeze({ ...(response.command.args ?? {}) }),
      request_metadata: Object.freeze({
        ...(response.command.request_metadata ?? {})
      })
    });
  }

  async submitResult({
    commandId,
    operationId,
    status,
    result,
    error
  }) {
    const command_id = requireString(commandId, "commandId");
    const operation_id = requireString(operationId, "operationId");

    if (!["succeeded", "failed"].includes(status)) {
      throw new TypeError("status must be succeeded or failed.");
    }

    const body = {
      command_id,
      operation_id,
      status
    };

    if (status === "succeeded") {
      body.result = result ?? null;
    } else {
      body.error = error ?? {
        code: "UNKNOWN_ERROR",
        message: "Unknown Agent error.",
        retryable: false
      };
    }

    const response = await this.#post("/result", body);

    if (response?.success !== true) {
      throw new QueueClientError(
        "Queue result submission was not successful.",
        "RESULT_REJECTED"
      );
    }

    return response;
  }
}

export const queueClientDefaults = Object.freeze({
  waitMs: DEFAULT_WAIT_MS,
  maxWaitMs: MAX_WAIT_MS
});
