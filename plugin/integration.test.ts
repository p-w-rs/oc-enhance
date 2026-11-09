import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { WorkerPool } from "./worker.js"
import { resolvePixi } from "./runtime.js"
import { execFile } from "node:child_process"
import { promisify } from "node:util"

function isolatedEnvironment(home: string, repository: string): NodeJS.ProcessEnv {
  return {
    PATH: `${path.join(repository, ".pixi", "envs", "default", "bin")}${path.delimiter}${path.dirname(process.execPath)}`,
    HOME: home, TMPDIR: home,
    XDG_CONFIG_HOME: path.join(home, "config"),
    XDG_DATA_HOME: path.join(home, "data"),
    XDG_CACHE_HOME: path.join(home, "cache"),
    XDG_STATE_HOME: path.join(home, "state"),
    OPENCODE_DISABLE_CLAUDE_CODE: "true",
    PYTHONNOUSERSITE: "1", PYTHONDONTWRITEBYTECODE: "1",
    HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1",
  }
}

test("isolated SDK loads adapter and executes search without a model request", { timeout: 60_000 }, async () => {
  const home = await realpath(await mkdtemp(path.join(os.tmpdir(), "open-enhance-sdk-")))
  const root = path.join(home, "synthetic-workspace")
  await mkdir(root)
  const repository = fileURLToPath(new URL("../", import.meta.url))
  // Fresh process: environment isolation precedes all SDK imports. Never inherit
  // provider keys, user's HOME/XDG paths, global config, or service discovery.
  const env: NodeJS.ProcessEnv = {
    PATH: path.dirname(process.execPath), HOME: home, TMPDIR: home,
    XDG_CONFIG_HOME: path.join(home, "config"),
    XDG_DATA_HOME: path.join(home, "data"),
    XDG_CACHE_HOME: path.join(home, "cache"),
    XDG_STATE_HOME: path.join(home, "state"),
    OPENCODE_DISABLE_CLAUDE_CODE: "true",
  }
  const script = `
    process.on('uncaughtException', error => { console.log(JSON.stringify({smokeError:String(error),stack:error.stack})); process.exit(0); });
    import assert from 'node:assert/strict';
    globalThis.fetch = async () => { throw new Error('network disabled in integration smoke'); };
    const { OpenCode } = await import('@opencode/sdk');
    const { createPlugin } = await import(${JSON.stringify(new URL("./index.ts", import.meta.url).href)});
    let pluginContext;
    const adapter = createPlugin({worker: () => ({executable: process.execPath, args: ['-e', 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>console.log(JSON.stringify(JSON.parse(s).operation==="inventory"?{paths:[]}:{results:[]})))'], cwd: ${JSON.stringify(root)}})});
    const host = await OpenCode.create({
      database: {path: ':memory:'},
      config: {directory: ${JSON.stringify(path.join(home, "config"))}, project: false, claude: false, content: '{}'},
      models: {fetch: false, snapshot: false},
      fs: {filewatcher: false, fff: false},
      fetch: globalThis.fetch,
      plugins: [{id: adapter.id, setup: async ctx => { pluginContext = ctx; return adapter.setup({...ctx, options: {evidence: true}}); }}],
    });
    try {
      const session = await host.session.create({location: {directory: ${JSON.stringify(root)}}});
      await host.session.update({sessionID: session.id, permissions: [{action:'read',resource:'*',effect:'allow'}]});
      await host.agent.list({location:{directory:${JSON.stringify(root)}}});
      const tools = await pluginContext.tool.list();
      assert.ok(tools.some(t => t.id === 'read'));
      const search = tools.find(t => t.id === 'open_enhance_search');
      assert.ok(search);
      const result = await search.execute({query:'synthetic',mode:'lexical',limit:1}, {sessionID:session.id,agent:'build',messageID:'smoke-message',id:'smoke-call',signal:new AbortController().signal,progress:async()=>{}});
      assert.deepEqual(JSON.parse(result.content), {results:[]});
      console.log(JSON.stringify({status:'ok', nativeReadPreserved:true, modelRequests:0}));
    } finally { await host.close(); }
  `
  const pool = new WorkerPool()
  try {
    const result = await pool.run({}, {
      executable: process.execPath,
      args: ["--import", "tsx", "--input-type=module", "-e", script],
      cwd: repository, env, timeoutMs: 45_000,
    }, new AbortController().signal)
    assert.deepEqual(result, { status: "ok", nativeReadPreserved: true, modelRequests: 0 })
  } finally {
    await pool.close()
    await rm(home, { recursive: true, force: true })
  }
})

test("isolated SDK searches and reads real Python lexical evidence without modifying sources", { timeout: 90_000 }, async () => {
  const home = await realpath(await mkdtemp(path.join(os.tmpdir(), "open-enhance-python-sdk-")))
  const root = path.join(home, "synthetic-workspace")
  await mkdir(root)
  const repository = fileURLToPath(new URL("../", import.meta.url))
  const script = `
    process.on('uncaughtException', error => { console.log(JSON.stringify({smokeError:String(error),stack:error.stack})); process.exit(0); });
    import assert from 'node:assert/strict';
    import {writeFile, readFile, readdir, stat} from 'node:fs/promises';
    import path from 'node:path';
    globalThis.fetch = async () => { throw new Error('network disabled in real backend smoke'); };
    const { OpenCode } = await import('@opencode/sdk');
    const { createPlugin } = await import(${JSON.stringify(new URL("./index.ts", import.meta.url).href)});
    const root = ${JSON.stringify(root)};
    const dataDirectory = ${JSON.stringify(path.join(home, "evidence-data"))};
    const text = '# Synthetic navigation\\nThe cobalt otter calibration uses exactly seventeen pulses.\\n';
    await writeFile(path.join(root, 'navigation.md'), text);
    await writeFile(path.join(root, 'unrelated.txt'), 'Synthetic ordinary weather observations.\\n');
    const snapshot = async directory => {
      let names;
      try { names = (await readdir(directory, {recursive:true})).sort(); }
      catch(error) { if (error.code === 'ENOENT') return []; throw error; }
      return Promise.all(names.map(async name => {
        const target = path.join(directory,name), info = await stat(target);
        return {name,mode:info.mode,size:info.size,mtime:info.mtimeMs,content:info.isFile() ? (await readFile(target)).toString('base64') : null};
      }));
    };
    const before = await snapshot(root);
    let pluginContext;
    // No worker injection: uses the real repo-owned Pixi Python executable and RPC.
    const adapter = createPlugin();
    const host = await OpenCode.create({
      database: {path: ':memory:'},
      config: {directory:${JSON.stringify(path.join(home, "config"))},project:false,claude:false,content:'{}'},
      models: {fetch:false,snapshot:false}, fs:{filewatcher:false,fff:false}, fetch:globalThis.fetch,
      plugins:[{id:adapter.id,setup:async ctx => {
        pluginContext = ctx;
        return adapter.setup({...ctx,options:{evidence:true,dataDirectory,pixiExecutable:${JSON.stringify(resolvePixi())}}});
      }}],
    });
    try {
      const session = await host.session.create({location:{directory:root}});
      await host.session.update({sessionID:session.id,permissions:[{action:'read',resource:'*',effect:'allow'}]});
      await host.agent.list({location:{directory:root}});
      const tools = await pluginContext.tool.list();
      for (const name of ['read','grep','shell']) assert.ok(tools.some(tool => tool.id === name), 'native tool preserved: '+name);
      const search = tools.find(tool => tool.id === 'open_enhance_search');
      const read = tools.find(tool => tool.id === 'open_enhance_read');
      assert.ok(search); assert.ok(read);
      const context = {sessionID:session.id,agent:'build',messageID:'python-smoke-message',id:'python-smoke-call',signal:new AbortController().signal,progress:async()=>{}};
      const found = JSON.parse((await search.execute({query:'cobalt otter calibration',mode:'lexical',limit:2},context)).content);
      assert.equal(found.route,'lexical');
      assert.ok(found.results.length > 0);
      const hit = found.results.find(hit => hit.evidence.path === 'navigation.md');
      assert.ok(hit);
      assert.equal(path.isAbsolute(hit.evidence.path),false);
      assert.match(hit.evidence.sha256,/^[a-f0-9]{64}$/);
      const verified = JSON.parse((await read.execute({evidence:hit.evidence},context)).content);
      assert.equal(verified.status,'verified');
      assert.deepEqual(verified.evidence,hit.evidence);
      assert.match(verified.text,/cobalt otter calibration uses exactly seventeen pulses/);
      assert.deepEqual(await snapshot(root),before,'source files and workspace entries must remain unchanged');
      const indexedBeforeDenial = await snapshot(dataDirectory);
      await host.session.update({sessionID:session.id,permissions:[
        {action:'read',resource:'*',effect:'allow'},
        {action:'read',resource:path.join(root,'navigation.md'),effect:'deny'},
      ]});
      await assert.rejects(search.execute({query:'cobalt',mode:'lexical',limit:1},context),/read-deny/);
      await assert.rejects(read.execute({evidence:hit.evidence},context),/read-deny/);
      assert.deepEqual(await snapshot(dataDirectory),indexedBeforeDenial,'denial must not invoke indexing or mutate evidence data');
      assert.deepEqual(await snapshot(root),before);
      console.log(JSON.stringify({status:'ok',backend:'python-lexical',verified:true,sourcesUnchanged:true,nativeToolsPreserved:true,denialBlocked:true,modelRequests:0}));
    } finally { await host.close(); }
  `
  const pool = new WorkerPool()
  try {
    const result = await pool.run({}, {
      executable: process.execPath,
      args: ["--import", "tsx", "--input-type=module", "-e", script],
      cwd: repository, env: isolatedEnvironment(home, repository), timeoutMs: 75_000,
    }, new AbortController().signal)
    assert.deepEqual(result, { status: "ok", backend: "python-lexical", verified: true, sourcesUnchanged: true, nativeToolsPreserved: true, denialBlocked: true, modelRequests: 0 })
  } finally {
    await pool.close()
    await rm(home, { recursive: true, force: true })
  }
})

test("repo-owned native CLI reports pinned version in an isolated environment", { skip: process.platform !== "darwin" || process.arch !== "arm64", timeout: 15_000 }, async () => {
  const home = await realpath(await mkdtemp(path.join(os.tmpdir(), "open-enhance-cli-")))
  const repository = fileURLToPath(new URL("../", import.meta.url))
  try {
    const { readFile } = await import("node:fs/promises")
    const packageDirectory = path.join(repository, "node_modules", "@opencode", "cli-darwin-arm64")
    const metadata = JSON.parse(await readFile(path.join(packageDirectory, "package.json"), "utf8"))
    const { stdout } = await promisify(execFile)(path.join(packageDirectory, "bin", "opencode"), ["--version"], {
      cwd: home, env: isolatedEnvironment(home, repository), timeout: 10_000, maxBuffer: 64 * 1024,
    })
    assert.equal(stdout.trim(), `opencode v${metadata.version}`)
  } finally { await rm(home, { recursive: true, force: true }) }
})
