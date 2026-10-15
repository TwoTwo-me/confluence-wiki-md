import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { installSkill, runSkillCli, skillDestinations } from '../src/skill-install.mjs';

async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'cfwiki-skill-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = path.join(directory, 'source');
  await mkdir(path.join(source, 'agents'), { recursive: true });
  await writeFile(path.join(source, 'SKILL.md'), '---\nname: confluence-wiki\ndescription: Work with Confluence.\n---\nUse cfwiki.\n');
  await writeFile(path.join(source, 'agents/openai.yaml'), 'interface:\n  display_name: Confluence\n');
  return { directory, source, home: path.join(directory, 'home'), env: {} };
}

test('skill destinations select the documented user and project locations explicitly', () => {
  const home = path.resolve('/temporary/home');
  const global = skillDestinations({ agent: 'all', home, env: {} });
  assert.deepEqual(global.map((item) => item.destination), [
    '.agents/skills/confluence-wiki', '.claude/skills/confluence-wiki', '.config/opencode/skills/confluence-wiki', '.cursor/skills/confluence-wiki',
  ].map((file) => path.join(home, file)));
  const project = skillDestinations({ agent: 'all', project: '/project', home, env: { XDG_CONFIG_HOME: '/config' } });
  assert.deepEqual(project.map((item) => item.destination), ['.agents', '.claude', '.opencode', '.cursor'].map((prefix) => path.resolve('/project', prefix, 'skills/confluence-wiki')));
  assert.equal(skillDestinations({ agent: 'opencode', home, env: { XDG_CONFIG_HOME: '/custom-config' } })[0].destination, path.resolve('/custom-config/opencode/skills/confluence-wiki'));
  assert.equal(skillDestinations({ agent: 'opencode', home, env: { XDG_CONFIG_HOME: 'relative' } })[0].destination, path.join(home, '.config/opencode/skills/confluence-wiki'));
  assert.throws(() => skillDestinations({ agent: 'all', project: '.', global: true }), /either/);
  assert.throws(() => skillDestinations({ agent: 'all', project: ' ' }), /non-empty/);
  assert.throws(() => skillDestinations(), /--agent/);
});

test('skill installation copies the bundled files for each agent and is idempotent', async (t) => {
  const fixtureOptions = await fixture(t);
  const options = { ...fixtureOptions, agent: 'all' };
  const first = await installSkill(options);
  for (const skill of first.skills) {
    assert.equal(skill.action, 'install');
    assert.deepEqual(await readFile(path.join(skill.destination, 'SKILL.md')), await readFile(path.join(options.source, 'SKILL.md')));
    assert.deepEqual(await readFile(path.join(skill.destination, 'agents/openai.yaml')), await readFile(path.join(options.source, 'agents/openai.yaml')));
    assert.equal((await lstat(skill.destination)).isSymbolicLink(), false);
  }
  assert.deepEqual((await installSkill(options)).skills.map((item) => item.action), ['unchanged', 'unchanged', 'unchanged', 'unchanged']);
});

test('dry runs leave no directories and overwrite requires an explicit flag with a recoverable backup', async (t) => {
  const options = { ...await fixture(t), agent: 'claude' };
  const dryRun = await installSkill({ ...options, dryRun: true });
  assert.equal(dryRun.skills[0].action, 'install');
  await assert.rejects(lstat(options.home), { code: 'ENOENT' });
  const [{ destination }] = skillDestinations(options);
  await mkdir(destination, { recursive: true });
  await writeFile(path.join(destination, 'SKILL.md'), 'Personal instructions');
  await writeFile(path.join(destination, 'personal.txt'), 'Keep me');
  await assert.rejects(installSkill(options), /--overwrite/);
  assert.equal(await readFile(path.join(destination, 'SKILL.md'), 'utf8'), 'Personal instructions');
  const result = await installSkill({ ...options, overwrite: true });
  const skill = result.skills[0];
  assert.equal(skill.action, 'replace');
  assert.equal(await readFile(path.join(skill.backup, 'personal.txt'), 'utf8'), 'Keep me');
  assert.equal(await readFile(path.join(skill.backup, 'SKILL.md'), 'utf8'), 'Personal instructions');
  assert.equal(skill.backup.startsWith(path.dirname(destination) + path.sep), false, 'Backups must stay outside skill discovery roots.');
  assert.deepEqual((await readdir(destination)).sort(), ['SKILL.md', 'agents']);
});

test('all-agent preflight prevents partial writes when one destination conflicts', async (t) => {
  const options = { ...await fixture(t), agent: 'all' };
  const destinations = skillDestinations(options);
  const conflict = destinations.at(-1).destination;
  await mkdir(conflict, { recursive: true });
  await writeFile(path.join(conflict, 'SKILL.md'), 'Existing');
  await assert.rejects(installSkill(options), /--overwrite/);
  await assert.rejects(lstat(destinations[0].destination), { code: 'ENOENT' });
});

test('skill installation refuses destination and source symlinks even with overwrite', async (t) => {
  const options = { ...await fixture(t), agent: 'codex', overwrite: true };
  const [{ destination }] = skillDestinations(options);
  await mkdir(path.dirname(destination), { recursive: true });
  await symlink(options.source, destination, 'dir');
  await assert.rejects(installSkill(options), /symbolic link/);
  await rm(destination);
  await symlink(path.join(options.source, 'SKILL.md'), path.join(options.source, 'linked.md'));
  await assert.rejects(installSkill(options), /symbolic link/);
});

test('standalone skill CLI reports paths and rejects ambiguous or unrelated options', async () => {
  let output = '';
  const stdout = { write(text) { output += text; } };
  await runSkillCli(['paths', '--agent', 'cursor', '--project', '/temporary-project', '--json'], { stdout });
  const result = JSON.parse(output);
  assert.equal(result.skills[0].destination, path.resolve('/temporary-project/.cursor/skills/confluence-wiki'));
  await assert.rejects(runSkillCli(['install', '--project', '/temporary-project'], { stdout }), /--agent/);
  await assert.rejects(runSkillCli(['paths', '--agent', 'all', '--overwrite'], { stdout }), /install only/);
  await assert.rejects(runSkillCli(['install', '--agent', 'all', '--token', 'secret'], { stdout }), /Unknown option/);
});
