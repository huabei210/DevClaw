import { GatewayServer } from "./server";

async function main(): Promise<void> {
  const server = new GatewayServer();
  await server.start();
  process.stdout.write("Gateway started\n");
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
