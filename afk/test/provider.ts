import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

// Fake provider CLIs. They answer the official preflight interfaces from FIXTURE_*
// variables and otherwise behave like the model executable used by the run tests.
const codexScript = `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('codex-cli 0.0.0-fixture'); process.exit(0); }
if (args[0] === 'login' && args[1] === 'status') {
  if (process.env.FIXTURE_LOGIN === 'none') { console.log('Not logged in'); process.exit(1); }
  console.log('Logged in using ChatGPT'); process.exit(0);
}
if (args[0] === 'app-server') {
  if (process.env.FIXTURE_APP_SERVER === 'fail') { console.error('emergency_ro: EROFS read-only file system token=sk-live-secret-value'); process.exit(1); }
  const servers = JSON.parse(process.env.FIXTURE_MCP || '[]');
  let buffer = '', initialized = false;
  if (process.env.FIXTURE_PROBE_STARTED) fs.writeFileSync(process.env.FIXTURE_PROBE_STARTED, String(process.pid));
  if (process.env.FIXTURE_PROBE_DESCENDANTS) {
    const descendant = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {stdio:'ignore'});
    fs.writeFileSync(process.env.FIXTURE_PROBE_DESCENDANTS, JSON.stringify([process.pid, descendant.pid]));
  }
  process.stdin.on('data', chunk => {
    buffer += chunk;
    const lines = buffer.split('\\n'); buffer = lines.pop();
    for (const line of lines) {
      const message = JSON.parse(line);
      if (message.method === 'initialize') {
        const mode = process.env.FIXTURE_PROTOCOL;
        if (mode === 'hang') continue;
        if (mode === 'null') { console.log('null'); continue; }
        if (mode === 'empty') { console.log('{}'); continue; }
        if (mode === 'bad-init') { console.log(JSON.stringify({id:message.id,result:{}})); continue; }
        if (mode === 'partial-init') { console.log(JSON.stringify({id:message.id,result:{userAgent:'fixture'}})); continue; }
        if (mode === 'large-line') { console.log(JSON.stringify({id:message.id,result:{userAgent:'x'.repeat(1024*1024)}})); continue; }
        if (mode === 'many-lines') { for(let i=0;i<10000;i++) console.log(JSON.stringify({method:'notice',params:{text:'x'.repeat(1024)}})); continue; }
        console.log(JSON.stringify({id: message.id, result: {userAgent: 'fixture', codexHome: process.env.CODEX_HOME, platformFamily: 'unix', platformOs: 'linux'}}));
      }
      else if (message.method === 'initialized') initialized = true;
      else if (message.method === 'mcpServerStatus/list') {
        if (!initialized) { console.log(JSON.stringify({id:message.id,error:{code:-32600,message:'initialized notification required'}})); continue; }
        const page = message.params.cursor ? 1 : 0;
        const data = process.env.FIXTURE_MCP_PAGES ? servers.slice(page, page + 1) : servers;
        const nextCursor = process.env.FIXTURE_MCP_PAGES && page === 0 && servers.length > 1 ? 'next' : null;
        if (process.env.FIXTURE_MCP_MALFORMED) console.log(JSON.stringify({id: message.id, result: {data: 'bad'}}));
        else console.log(JSON.stringify({id: message.id, result: {data, nextCursor}}));
      }
    }
  });
  process.stdin.on('end', () => process.exit(0));
  setInterval(() => {}, 1000);
  return;
}
let prompt = '';
process.stdin.on('data', chunk => prompt += chunk);
process.stdin.on('end', () => {
 fs.writeFileSync(process.env.FIXTURE_READY, String(process.pid));
 const finish = () => {
  if(process.env.FIXTURE_RELEASE && !fs.existsSync(process.env.FIXTURE_RELEASE)) return setTimeout(finish, 50);
  if(process.env.FIXTURE_FAILURE) { console.error('401 authentication failed'); process.exit(1); }
  const response = {findings: process.env.FIXTURE_FINDING ? [{id:'one',file:'source.txt',description:'fixture finding',repair:'repair fixture'}] : [], blockers: [], coverage:[{criterion:'Preserve source', evidence:'Observed source check', status:'verified'}]};
  console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'<berry_result>'+JSON.stringify(response)+'</berry_result>'}}));
 };
 setTimeout(finish, Number(process.env.FIXTURE_DELAY || 0));
});
`;

const claudeScript = `#!${process.execPath}
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('2.0.0 (Claude Code fixture)'); process.exit(0); }
if (args[0] === 'auth' && args[1] === 'status') {
  if (process.env.FIXTURE_LOGIN === 'none') { console.log(JSON.stringify({loggedIn: false})); process.exit(1); }
  if (process.env.FIXTURE_AUTH_MALFORMED) { console.log('<html>'); process.exit(0); }
  console.log(JSON.stringify({loggedIn: true, email: 'private@example.invalid', orgId: 'org-private'})); process.exit(0);
}
if (args[0] === 'mcp' && args[1] === 'list') {
  console.log(process.env.FIXTURE_CLAUDE_MCP ?? '');
  process.exit(0);
}
process.exit(0);
`;

/** Install fake provider CLIs in bin and return the environment overrides that select them. */
export async function installProviders(root: string, bin: string) {
  await mkdir(bin, { recursive: true });
  await writeFile(join(bin, "codex"), codexScript, { mode: 0o700 });
  await writeFile(join(bin, "claude"), claudeScript, { mode: 0o700 });
  const codexHome = join(root, "codex-home"),
    claudeHome = join(root, "claude-home");
  for (const home of [codexHome, claudeHome]) {
    await mkdir(join(home, "skills", "ask-matt"), { recursive: true });
    await writeFile(join(home, "skills", "ask-matt", "SKILL.md"), "# router\n");
  }
  return {
    CODEX_HOME: codexHome,
    CLAUDE_CONFIG_DIR: claudeHome,
    PATH: `${bin}:${process.env.PATH}`,
  } satisfies NodeJS.ProcessEnv;
}
