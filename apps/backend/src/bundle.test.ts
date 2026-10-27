import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { bundle } from '../scripts/bundle.js';
import { inlineKit } from './screens.js';
import { tempDir } from './test-helpers.js';

describe('the single-file gateway',()=>{
  it('runs with plain node from any directory, with the default screen and the kit inside it', async()=>{ const dir=tempDir(); const kitDir=path.join(dir,'kit'); const run=path.join(dir,'run'); fs.mkdirSync(kitDir); fs.mkdirSync(run);
    const kit={ js:'window.MarionetteKit={ bundled:true };', css:'.bundled{color:red}' }; fs.writeFileSync(path.join(kitDir,'marionette-kit.js'),kit.js); fs.writeFileSync(path.join(kitDir,'marionette-kit.css'),kit.css);
    const file=await bundle({ outfile:path.join(dir,'out','marionette-gateway.mjs'), kitDir });
    // No node_modules anywhere near it, and nothing but the environment a robot would set.
    const child=spawn(process.execPath,[file],{ cwd:run, env:{ PATH:process.env.PATH, HOME:run, PORT:'0', MARIONETTE_HOME:path.join(run,'home'), MARIONETTE_MDNS:'off' } });
    try {
      let output=''; child.stdout.on('data',d=>{ output+=d; }); child.stderr.on('data',d=>{ output+=d; });
      const port=await new Promise<number>((resolve,reject)=>{ const timer=setInterval(()=>{ const found=/listening on http:\/\/0\.0\.0\.0:(\d+)/.exec(output); if (found) { clearInterval(timer); resolve(Number(found[1])); } },20); child.once('exit',code=>{ clearInterval(timer); reject(new Error(`exited ${code}: ${output}`)); }); });
      const get=(route: string)=>fetch(`http://127.0.0.1:${port}${route}`);
      expect(await get('/health').then(r=>r.json())).toMatchObject({ ok:true, service:'marionette-gateway' });
      const sample=fs.readFileSync(new URL('./sample-controls.html', import.meta.url),'utf8');
      expect((await get('/api/html-config').then(r=>r.json()) as any).html).toBe(inlineKit(sample,kit)); expect(await get('/marionette-kit.css').then(r=>r.text())).toBe(kit.css);
      await new Promise(resolve=>setTimeout(resolve,100)); expect(output).toMatch(/Pairing code: [0-9A-Z]{4}-[0-9A-Z]{4}/); expect(fs.existsSync(path.join(run,'home','gateway.json'))).toBe(true); expect(fs.readdirSync(path.join(run,'logs')).length).toBe(1);
    } finally { if (child.exitCode === null) { const exited=new Promise(resolve=>child.once('exit',resolve)); child.kill('SIGTERM'); await exited; } fs.rmSync(dir,{ recursive:true, force:true }); }
  }, 20_000);
});
