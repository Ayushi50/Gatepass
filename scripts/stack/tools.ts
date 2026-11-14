import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { homedir, arch, platform } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';

/**
 * The observability and load-testing programs, downloaded once into ~/.cache/gatepass/tools
 * (outside the repo), each verified against the checksum its publisher publishes before it is
 * unpacked. Nothing is installed system-wide and nothing is run until it has been verified.
 */
export type ToolName = 'prometheus' | 'grafana' | 'jaeger' | 'k6';

const V = { prometheus: '3.16.0', grafana: '13.3.1', jaeger: '2.23.0', k6: '2.4.0' } as const;

interface Target {
  os: 'darwin' | 'linux';
  cpu: 'arm64' | 'amd64';
}
function target(): Target {
  const os = platform() === 'darwin' ? 'darwin' : platform() === 'linux' ? 'linux' : null;
  const cpu = arch() === 'arm64' ? 'arm64' : arch() === 'x64' ? 'amd64' : null;
  if (!os || !cpu) throw new Error(`unsupported platform ${platform()}/${arch()}`);
  return { os, cpu };
}

interface Plan {
  url: string;
  /** Where the publisher's checksum lives, and the name of the file in it. */
  checksumUrl: string;
  checksumName: string;
  /** Archive type, and the path of the program inside the unpacked folder. */
  kind: 'tgz' | 'zip';
  bin: string;
  /** The publisher lists checksums of the unpacked PROGRAMS, not of the archive (Jaeger). */
  checksumIsOfBinary?: boolean;
}

function plan(tool: ToolName): Plan {
  const { os, cpu } = target();
  const gh = (repo: string, tag: string, file: string) =>
    `https://github.com/${repo}/releases/download/${tag}/${file}`;
  switch (tool) {
    case 'prometheus': {
      const dir = `prometheus-${V.prometheus}.${os}-${cpu}`;
      return {
        url: gh('prometheus/prometheus', `v${V.prometheus}`, `${dir}.tar.gz`),
        checksumUrl: gh('prometheus/prometheus', `v${V.prometheus}`, 'sha256sums.txt'),
        checksumName: `${dir}.tar.gz`,
        kind: 'tgz',
        bin: `${dir}/prometheus`,
      };
    }
    case 'jaeger': {
      const base = `jaeger-${V.jaeger}-${os}-${cpu}`;
      return {
        url: gh('jaegertracing/jaeger', `v${V.jaeger}`, `${base}.tar.gz`),
        checksumUrl: gh('jaegertracing/jaeger', `v${V.jaeger}`, `${base}.sha256sum.txt`),
        checksumName: `${base}/jaeger`,
        kind: 'tgz',
        bin: `${base}/jaeger`,
        checksumIsOfBinary: true,
      };
    }
    case 'k6': {
      const base = `k6-v${V.k6}-${os === 'darwin' ? 'macos' : 'linux'}-${cpu}`;
      return {
        url: gh('grafana/k6', `v${V.k6}`, `${base}.${os === 'darwin' ? 'zip' : 'tar.gz'}`),
        checksumUrl: gh('grafana/k6', `v${V.k6}`, `k6-v${V.k6}-checksums.txt`),
        checksumName: `${base}.${os === 'darwin' ? 'zip' : 'tar.gz'}`,
        kind: os === 'darwin' ? 'zip' : 'tgz',
        bin: `${base}/k6`,
      };
    }
    case 'grafana': {
      const file = `grafana-${V.grafana}.${os}-${cpu}.tar.gz`;
      return {
        url: `https://dl.grafana.com/oss/release/${file}`,
        checksumUrl: `https://dl.grafana.com/oss/release/${file}.sha256`,
        checksumName: file,
        kind: 'tgz',
        bin: `grafana-${V.grafana}/bin/grafana`,
      };
    }
  }
}

const root = () => process.env.GATEPASS_TOOLS_DIR ?? join(homedir(), '.cache', 'gatepass', 'tools');

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
  return res.text();
}

/** The sha256 the publisher lists for `name` (checksum files are "<hash>  <name>" lines, or just a hash). */
export function checksumFor(text: string, name: string): string {
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const hit = lines.find((l) => l.includes(name)) ?? (lines.length === 1 ? lines[0]! : undefined);
  const hash = hit?.match(/\b[a-f0-9]{64}\b/i)?.[0];
  if (!hash) throw new Error(`no sha256 for ${name} in the published checksums`);
  return hash.toLowerCase();
}

async function sha256Of(file: string): Promise<string> {
  const h = createHash('sha256');
  await pipeline((await import('node:fs')).createReadStream(file), h);
  return h.digest('hex');
}

const run = (cmd: string, args: string[], cwd: string) =>
  new Promise<void>((ok, bad) =>
    spawn(cmd, args, { cwd, stdio: 'ignore' }).on('exit', (c) =>
      c === 0 ? ok() : bad(new Error(`${cmd} failed (${c})`)),
    ),
  );

/** Returns the path of the program, downloading and verifying it first if needed. */
export async function ensureTool(
  tool: ToolName,
  log: (m: string) => void = () => undefined,
): Promise<string> {
  const p = plan(tool);
  const home = join(root(), `${tool}-${V[tool]}-${target().os}-${target().cpu}`);
  const bin = join(home, 'unpacked', p.bin);
  if (existsSync(bin)) return bin;

  rmSync(home, { recursive: true, force: true });
  mkdirSync(join(home, 'unpacked'), { recursive: true });
  const archive = join(home, `download.${p.kind === 'zip' ? 'zip' : 'tar.gz'}`);

  log(`downloading ${tool} ${V[tool]}...`);
  const want = checksumFor(await fetchText(p.checksumUrl), p.checksumName);
  // curl retries and resumes a dropped connection, which a large download (Grafana) needs
  await run(
    'curl',
    [
      '-fL',
      '--retry',
      '8',
      '--retry-delay',
      '2',
      '--retry-all-errors',
      '-C',
      '-',
      '-o',
      archive,
      p.url,
    ],
    home,
  );
  const got = p.checksumIsOfBinary ? want : await sha256Of(archive);
  if (got !== want) {
    rmSync(home, { recursive: true, force: true });
    throw new Error(
      `${tool}: checksum mismatch (published ${want}, downloaded ${got}); NOT unpacked`,
    );
  }
  if (!p.checksumIsOfBinary) log(`${tool}: checksum verified`);

  await run(
    p.kind === 'zip' ? 'unzip' : 'tar',
    p.kind === 'zip'
      ? ['-q', archive, '-d', join(home, 'unpacked')]
      : ['xzf', archive, '-C', join(home, 'unpacked')],
    home,
  );
  // some archives unpack without the folder name we expect: find the program by name
  if (!existsSync(bin)) {
    const found = findFile(join(home, 'unpacked'), p.bin.split('/').pop()!);
    if (!found) throw new Error(`${tool}: ${p.bin} not found after unpacking`);
    mkdirSync(join(bin, '..'), { recursive: true });
    renameSync(found, bin);
  }
  if (p.checksumIsOfBinary) {
    // verified BEFORE it is ever run
    const actual = await sha256Of(bin);
    if (actual !== want) {
      rmSync(home, { recursive: true, force: true });
      throw new Error(
        `${tool}: checksum mismatch for the program (published ${want}, found ${actual}); removed`,
      );
    }
    log(`${tool}: program checksum verified`);
  }
  return bin;
}

function findFile(dir: string, name: string): string | undefined {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      const hit = findFile(full, name);
      if (hit) return hit;
    } else if (e.name === name) return full;
  }
  return undefined;
}
