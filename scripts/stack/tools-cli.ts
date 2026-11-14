// `pnpm tools [prometheus grafana jaeger k6]`: download and verify the observability / load-test programs.
import { ensureTool, type ToolName } from './tools';

const all: ToolName[] = ['prometheus', 'grafana', 'jaeger', 'k6'];
const wanted = process.argv.slice(2).filter((a) => !a.startsWith('--')) as ToolName[];
(async () => {
  for (const t of wanted.length ? wanted : all)
    console.log(`${t}: ${await ensureTool(t, console.log)}`);
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
