import { AgentService } from "./service";

async function main(): Promise<void> {
  const service = new AgentService();
  await service.start();
  process.stdout.write("Agent started\n");
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
