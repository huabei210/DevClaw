import { ChildProcess, spawn } from "node:child_process";

const PROCESS_EXIT_WAIT_MS = 1500;
const FORCE_KILL_WAIT_MS = 500;

function hasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (hasExited(child)) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timer);
      child.off("close", finish);
      child.off("error", finish);
      resolve();
    };

    const timer = setTimeout(finish, timeoutMs);
    child.once("close", finish);
    child.once("error", finish);
  });
}

function sendPosixSignal(child: ChildProcess, signal: NodeJS.Signals): void {
  const pid = child.pid;
  if (!pid) {
    return;
  }

  try {
    process.kill(-Math.abs(pid), signal);
    return;
  } catch {
    // Fall through to direct child kill when the process is not in its own group.
  }

  try {
    child.kill(signal);
  } catch {
    // Ignore kill races when the process already exited.
  }
}

function runWindowsTaskkill(pid: number): Promise<void> {
  return new Promise((resolve) => {
    const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true
    });

    killer.once("error", () => resolve());
    killer.once("close", () => resolve());
  });
}

export function shouldSpawnDetachedForCleanup(platform: NodeJS.Platform = process.platform): boolean {
  return platform !== "win32";
}

export async function terminateChildProcessTree(
  child: ChildProcess,
  platform: NodeJS.Platform = process.platform
): Promise<void> {
  const pid = child.pid;
  if (!pid) {
    return;
  }

  if (hasExited(child)) {
    await waitForChildExit(child, 0);
    return;
  }

  if (platform === "win32") {
    await runWindowsTaskkill(pid);
    await waitForChildExit(child, PROCESS_EXIT_WAIT_MS);

    if (hasExited(child)) {
      return;
    }

    try {
      child.kill("SIGKILL");
    } catch {
      // Ignore kill races when the process already exited.
    }
    await waitForChildExit(child, FORCE_KILL_WAIT_MS);
    return;
  }

  sendPosixSignal(child, "SIGTERM");
  await waitForChildExit(child, PROCESS_EXIT_WAIT_MS);

  if (hasExited(child)) {
    return;
  }

  sendPosixSignal(child, "SIGKILL");
  await waitForChildExit(child, FORCE_KILL_WAIT_MS);
}
