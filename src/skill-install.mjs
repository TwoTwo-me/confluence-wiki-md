import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, rmdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const bundledSkill = fileURLToPath(new URL('../skills/confluence-wiki/', import.meta.url));
const agents = ['codex', 'claude', 'opencode', 'cursor'];
const skillName = 'confluence-wiki';

export const skillHelp = `Usage: cfwiki skill <install|paths> --agent codex|claude|opencode|cursor|all [options]

  install       Copy the bundled skill to the selected agent's skill directory
  paths         Show exact destinations without writing files

Options:
  --agent NAME  Required; all selects the four supported agents
  --global      Install for the current user (default)
  --project DIR Install inside this project directory instead
  --dry-run     Show the installation plan without changing files
  --overwrite   Back up a different existing skill directory before replacing it
  --json        Return the plan or result as JSON
  --help, -h    Show this help

No account, profile, token, or agent settings are read or changed.
`;

export function skillDestinations({ agent, project, global = false, home = homedir(), env = process.env } = {}) {
  if (!agents.includes(agent) && agent !== 'all') throw new Error('--agent must be codex, claude, opencode, cursor, or all.');
  if (project !== undefined && global) throw new Error('Choose either --project DIR or --global.');
  if (project !== undefined && !project.trim()) throw new Error('--project requires a non-empty directory.');
  const scope = project === undefined ? 'global' : 'project';
  const base = scope === 'global' ? path.resolve(home) : path.resolve(project);
  const configHome = env.XDG_CONFIG_HOME && path.isAbsolute(env.XDG_CONFIG_HOME) ? env.XDG_CONFIG_HOME : path.join(base, '.config');
  const roots = scope === 'global'
    ? { codex: path.join(base, '.agents/skills'), claude: path.join(base, '.claude/skills'), opencode: path.join(configHome, 'opencode/skills'), cursor: path.join(base, '.cursor/skills') }
    : { codex: path.join(base, '.agents/skills'), claude: path.join(base, '.claude/skills'), opencode: path.join(base, '.opencode/skills'), cursor: path.join(base, '.cursor/skills') };
  return (agent === 'all' ? agents : [agent]).map((name) => ({ agent: name, scope, destination: path.join(roots[name], skillName) }));
}

async function entries(directory, prefix = '') {
  const result = [];
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const relative = path.join(prefix, entry.name);
    if (entry.isSymbolicLink()) throw new Error('Refusing a symbolic link inside a skill directory: ' + path.join(directory, entry.name));
    if (entry.isDirectory()) result.push(...await entries(path.join(directory, entry.name), relative));
    else if (entry.isFile()) result.push(relative);
    else throw new Error('Unsupported skill entry: ' + path.join(directory, entry.name));
  }
  return result;
}

async function optionalStat(destination) {
  try { return await lstat(destination); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function classify(destination, files, overwrite) {
  const existing = await optionalStat(destination);
  if (!existing) return 'install';
  if (existing.isSymbolicLink()) throw new Error('Refusing to replace a symbolic link: ' + destination + '. Remove it explicitly before installing a copy.');
  if (!existing.isDirectory()) throw new Error('Skill destination is not a directory: ' + destination);
  const current = await entries(destination);
  const sameNames = current.length === files.size && current.every((file) => files.has(file));
  if (sameNames && (await Promise.all(current.map(async (file) => (await readFile(path.join(destination, file))).equals(files.get(file))))).every(Boolean)) return 'unchanged';
  if (!overwrite) throw new Error('A different skill already exists at ' + destination + '. Review it, then use --overwrite to back it up and replace it.');
  return 'replace';
}

export async function installSkill(options = {}) {
  const destinations = skillDestinations(options);
  const source = options.source ?? bundledSkill;
  const files = new Map(await Promise.all((await entries(source)).map(async (file) => [file, await readFile(path.join(source, file))])));
  if (!files.has('SKILL.md')) throw new Error('The bundled skill is missing SKILL.md.');
  // Preflight every destination before any write, including --agent all.
  const plan = [];
  for (const target of destinations) plan.push({ ...target, action: await classify(target.destination, files, options.overwrite), files: [...files.keys()] });
  if (options.dryRun) return { dryRun: true, skills: plan };
  for (const target of plan) {
    if (target.action === 'unchanged') continue;
    const parent = path.dirname(target.destination);
    await mkdir(parent, { recursive: true });
    const stage = await mkdtemp(path.join(parent, '.' + skillName + '-stage-'));
    let backup;
    let reserved = false;
    try {
      for (const [file, bytes] of files) {
        const destination = path.join(stage, file);
        await mkdir(path.dirname(destination), { recursive: true });
        await writeFile(destination, bytes, { flag: 'wx', mode: 0o644 });
      }
      // Recheck after staging so a concurrently added/changed skill is never
      // silently replaced. Existing symlinks are rejected even with --overwrite.
      const action = await classify(target.destination, files, options.overwrite);
      if (action === 'unchanged') { target.action = action; continue; }
      if (action === 'replace') {
        const backupRoot = path.join(path.dirname(parent), 'skill-backups');
        await mkdir(backupRoot, { recursive: true });
        backup = await mkdtemp(path.join(backupRoot, skillName + '-'));
        await rm(backup, { recursive: true });
        await rename(target.destination, backup);
      } else {
        await mkdir(target.destination);
        reserved = true;
      }
      try { await rename(stage, target.destination); }
      catch (error) {
        if (reserved) await rmdir(target.destination).catch(() => {});
        if (backup && !await optionalStat(target.destination)) await rename(backup, target.destination);
        throw error;
      }
      target.action = action;
      if (backup) target.backup = backup;
    } finally { await rm(stage, { recursive: true, force: true }); }
  }
  return { dryRun: false, skills: plan };
}

export async function runSkillCli(args, { stdout = process.stdout } = {}) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, strict: true, options: {
    agent: { type: 'string' }, project: { type: 'string' }, global: { type: 'boolean' },
    'dry-run': { type: 'boolean' }, overwrite: { type: 'boolean' }, json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
  } });
  if (values.help || args.length === 0) { stdout.write(skillHelp); return; }
  const [command, ...extra] = positionals;
  if (!['install', 'paths'].includes(command) || extra.length) throw new Error('Use skill install or skill paths. See cfwiki skill --help.');
  if (command === 'paths' && (values.overwrite || values['dry-run'])) throw new Error('--overwrite and --dry-run are supported by skill install only.');
  const options = { agent: values.agent, project: values.project, global: values.global, dryRun: values['dry-run'], overwrite: values.overwrite };
  const result = command === 'paths' ? { skills: skillDestinations(options) } : await installSkill(options);
  if (values.json) stdout.write(JSON.stringify(result, null, 2) + '\n');
  else for (const target of result.skills) stdout.write(`${target.agent}: ${target.destination}${target.action ? ' (' + (result.dryRun ? 'would ' : '') + target.action + ')' : ''}${target.backup ? '\n  Backup: ' + target.backup : ''}\n`);
}
