import { readFile, access, mkdtemp, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { diagramSource } from './diagrams.mjs';

let browser;
let running;
let temp;
const cleanup = async () => { running?.kill('SIGKILL'); await browser?.close(); if (temp) await rm(temp, { recursive: true, force: true }); };
process.on('SIGTERM', () => { cleanup().finally(() => process.exit(1)); });

function plantuml(command, args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: temp, env: { ...process.env, PLANTUML_SECURITY_PROFILE: 'SANDBOX', JAVA_TOOL_OPTIONS: '-Xmx256m -Djava.awt.headless=true -DPLANTUML_SECURITY_PROFILE=SANDBOX' }, stdio: ['pipe', 'pipe', 'pipe'] });
    running = child;
    let output = ''; let errors = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 15000);
    child.stdout.on('data', (chunk) => { if (output.length < 10000) output += chunk; });
    child.stderr.on('data', (chunk) => { if (errors.length < 10000) errors += chunk; });
    child.stdin.on('error', () => {});
    child.on('error', () => { clearTimeout(timer); reject(new Error('PlantUML executable is unavailable. Install PlantUML with Java, or set CFWIKI_PLANTUML_PATH.')); });
    child.on('close', (code, signal) => { clearTimeout(timer); running = null; if (code !== 0 || signal) reject(new Error((errors || output || 'PlantUML validation failed or timed out.').replace(/^Picked up JAVA_TOOL_OPTIONS:.*\n/m, '').trim())); else resolve(output); });
    child.stdin.end(input);
  });
}

async function main() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const { blocks, chromePath, plantumlPath } = JSON.parse(Buffer.concat(chunks).toString());
  const checks = [];
  let page;
  let mermaidVersion;
  let plantumlVersion;
  temp = await mkdtemp(path.join(tmpdir(), 'cfwiki-diagrams-'));
  for (const block of blocks) {
    try {
      if (block.engine === 'mermaid') {
        if (!page) {
          const { default: puppeteer } = await import('puppeteer');
          let executablePath = chromePath;
          if (!executablePath && process.platform === 'darwin') {
            const installed = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
            try { await access(installed); executablePath = installed; } catch { /* Puppeteer's installed browser is the fallback. */ }
          }
          browser = await puppeteer.launch({ headless: true, ...(executablePath ? { executablePath } : {}), userDataDir: path.join(temp, 'chrome'), timeout: 20000 });
          page = await browser.newPage();
          await page.setRequestInterception(true);
          page.on('request', (request) => request.abort());
          await page.setContent('<!doctype html><html><body></body></html>');
          const dist = path.dirname(fileURLToPath(import.meta.resolve('mermaid')));
          await page.addScriptTag({ path: path.join(dist, 'mermaid.min.js') });
          mermaidVersion = JSON.parse(await readFile(path.join(dist, '../package.json'), 'utf8')).version;
        }
        const diagramType = await page.evaluate(async (source) => {
          window.mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', maxTextSize: 50000, maxEdges: 500 });
          const parsed = await window.mermaid.parse(source);
          return parsed.diagramType;
        }, block.code);
        checks.push({ language: block.language, line: block.line, engine: 'mermaid', version: mermaidVersion, diagramType });
      } else {
        if (!plantumlVersion) plantumlVersion = (await plantuml(plantumlPath, ['-version'], '')).match(/PlantUML version ([^\s]+)/)?.[1] || 'unknown';
        const starts = block.code.match(/^\s*@start\w+/gm) ?? [];
        const ends = block.code.match(/^\s*@end\w+/gm) ?? [];
        if (starts.length > 1 || ends.length > 1 || starts.length !== ends.length) throw new Error('Use one complete @start…/@end… diagram per code block.');
        const source = diagramSource(block);
        const result = await plantuml(plantumlPath, ['-syntax'], source);
        if (/^ERROR\b/m.test(result)) throw new Error(result.trim());
        checks.push({ language: block.language, line: block.line, engine: 'plantuml', version: plantumlVersion });
      }
    } catch (error) {
      throw new Error(block.language + ' at Markdown line ' + block.line + ': ' + error.message.slice(0, 1600));
    }
  }
  return checks;
}

try { process.stdout.write(JSON.stringify({ checks: await main() })); }
catch (error) { process.stdout.write(JSON.stringify({ error: error.message })); process.exitCode = 1; }
finally { await cleanup(); }
