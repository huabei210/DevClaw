const { spawn } = require("node:child_process");

function run(name, command) {
  const child = spawn(command, {
    shell: true,
    stdio: ["inherit", "pipe", "pipe"],
    windowsHide: false
  });

  const prefix = `[${name}]`;
  child.stdout.on("data", (chunk) => {
    process.stdout.write(`${prefix} ${chunk}`);
  });

  child.stderr.on("data", (chunk) => {
    process.stderr.write(`${prefix} ${chunk}`);
  });

  child.on("exit", (code, signal) => {
    const detail = signal ? `signal=${signal}` : `code=${String(code ?? 0)}`;
    process.stderr.write(`${prefix} exited (${detail})\n`);
    shutdown(code ?? 0);
  });

  return child;
}

const children = [
  run("gateway", "npm run dev:gateway"),
  run("agent", "npm run dev:agent")
];

let stopping = false;

function shutdown(exitCode) {
  if (stopping) {
    return;
  }

  stopping = true;
  for (const child of children) {
    if (!child.killed) {
      child.kill("SIGTERM");
    }
  }

  setTimeout(() => process.exit(exitCode), 200);
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
