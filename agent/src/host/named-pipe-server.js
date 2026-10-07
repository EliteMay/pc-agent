import net from "node:net";

const MAX_REQUEST_BYTES = 16 * 1024;
const ALLOWED_METHODS = new Set([
  "hello",
  "get_status",
  "get_health",
  "get_version",
  "get_pending_approval",
  "respond_approval",
  "prepare_shutdown",
  "reload_config"
]);

function pipePath(pipeName) {
  const clean = String(pipeName).replace(/^\\\\\.\\pipe\\/i, "");
  if (!clean || /[\\/]/.test(clean)) {
    throw new Error("Invalid named pipe name.");
  }
  return "\\\\.\\pipe\\" + clean;
}

function encodeResponse(id, ok, payload) {
  const body = ok
    ? { id: id ?? null, ok: true, result: payload }
    : { id: id ?? null, ok: false, error: payload };

  return JSON.stringify(body) + "\n";
}

export function createNamedPipeServer({
  pipeName,
  getHealth,
  getPendingApproval,
  onApprovalResponse,
  onPrepareShutdown
}) {
  if (typeof getHealth !== "function") {
    throw new TypeError("getHealth must be a function.");
  }

  if (getPendingApproval !== undefined && typeof getPendingApproval !== "function") {
    throw new TypeError("getPendingApproval must be a function when provided.");
  }

  if (onApprovalResponse !== undefined && typeof onApprovalResponse !== "function") {
    throw new TypeError("onApprovalResponse must be a function when provided.");
  }

  const server = net.createServer((socket) => {
    socket.setEncoding("utf8");
    let buffer = "";

    socket.on("data", async (chunk) => {
      buffer += chunk;

      if (Buffer.byteLength(buffer, "utf8") > MAX_REQUEST_BYTES) {
        socket.end(encodeResponse(null, false, {
          code: "REQUEST_TOO_LARGE",
          message: "IPC request exceeded the size limit."
        }));
        return;
      }

      const newline = buffer.indexOf("\n");
      if (newline < 0) {
        return;
      }

      const line = buffer.slice(0, newline);
      buffer = "";

      let request;
      try {
        request = JSON.parse(line);
      } catch {
        socket.end(encodeResponse(null, false, {
          code: "INVALID_JSON",
          message: "IPC request must be JSON."
        }));
        return;
      }

      const method = String(request?.method ?? "");

      if (!ALLOWED_METHODS.has(method)) {
        socket.end(encodeResponse(request?.id, false, {
          code: "UNKNOWN_IPC_METHOD",
          message: "IPC method is not allowed."
        }));
        return;
      }

      try {
        let result;

        switch (method) {
          case "hello":
            result = {
              service: "pc-agent",
              ipc_protocol: 1
            };
            break;
          case "get_status":
          case "get_health":
            result = getHealth();
            break;
          case "get_version":
            result = {
              version: getHealth().version,
              protocol_version: getHealth().protocol_version
            };
            break;
          case "get_pending_approval":
            result = getPendingApproval ? getPendingApproval() : null;
            break;
          case "respond_approval": {
            if (!onApprovalResponse) {
              result = {
                accepted: false,
                code: "APPROVAL_NOT_AVAILABLE"
              };
              break;
            }

            const operationId = String(request?.params?.operation_id ?? "");
            const decision = String(request?.params?.decision ?? "");

            result = onApprovalResponse(operationId, decision);
            break;
          }
          case "prepare_shutdown":
            result = { accepted: true };
            if (typeof onPrepareShutdown === "function") {
              onPrepareShutdown();
            }
            break;
          case "reload_config":
            result = {
              accepted: false,
              restart_required: true
            };
            break;
          default:
            throw new Error("Unhandled IPC method.");
        }

        socket.end(encodeResponse(request?.id, true, result));
      } catch (error) {
        socket.end(encodeResponse(request?.id, false, {
          code: "IPC_HANDLER_ERROR",
          message: error?.message ?? String(error)
        }));
      }
    });
  });

  return {
    async listen() {
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(pipePath(pipeName), () => {
          server.off("error", reject);
          resolve();
        });
      });
    },
    async close() {
      await new Promise((resolve) => {
        server.close(() => resolve());
      });
    }
  };
}
