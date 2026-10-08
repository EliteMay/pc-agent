import path from "node:path";

// Do not inherit Agent device credentials or the one-time Manager IPC key
// into Windows helper processes such as tasklist.exe and taskkill.exe.
export function minimalWindowsChildEnvironment(inherited = process.env) {
  const systemRoot = inherited.SystemRoot || inherited.WINDIR || "C:\\Windows";

  if (!path.win32.isAbsolute(systemRoot)) {
    throw new TypeError("A trusted absolute Windows system root is required.");
  }

  const temp = inherited.TEMP || path.win32.join(systemRoot, "Temp");
  const tmp = inherited.TMP || temp;

  return Object.freeze({
    SystemRoot: systemRoot,
    WINDIR: systemRoot,
    TEMP: temp,
    TMP: tmp
  });
}
