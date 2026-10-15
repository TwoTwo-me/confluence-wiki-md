#!/usr/bin/env node
import { runSkillCli } from '../src/skill-install.mjs';

try { await runSkillCli(process.argv.slice(2)); }
catch (error) { process.stderr.write(error.message + '\n'); process.exitCode = 1; }
