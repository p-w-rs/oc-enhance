import test from "node:test"
import assert from "node:assert/strict"
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { execFile } from "node:child_process"
import { promisify } from "node:util"

// Real location activation, shared durable KV, session deletion and interruption.
// The live-call case invokes registered checkpoint callbacks explicitly: it is
// not engine tool dispatch (which the separate dispatch test exercises).
test("isolated SDK checkpoint controllers coordinate across locations and deleted history", { timeout: 60_000 }, async () => {
  const repository = fileURLToPath(new URL("../", import.meta.url))
  await mkdir(path.join(repository, ".local"), { recursive: true })
  const home = await realpath(await mkdtemp(path.join(repository, ".local", "locations-")))
  const roots = [path.join(home, "synthetic-a"), path.join(home, "synthetic-b")]
  await Promise.all(roots.map(root => mkdir(root)))
  const script = `
    import assert from 'node:assert/strict';
    import {access} from 'node:fs/promises';
    let stage = 'startup';
    process.on('uncaughtException', error => {
      console.log(JSON.stringify({status:'error',stage,error:String(error),stack:error.stack}));
      process.exit(0);
    });
    const blockedFetches = [];
    globalThis.fetch = async input => { blockedFetches.push(String(input instanceof Request ? input.url : input)); throw new Error('network disabled in location test'); };
    const {OpenCode} = await import('@opencode/sdk');
    const {installCheckpoints} = await import(${JSON.stringify(new URL("./checkpoint.ts", import.meta.url).href)});
    const roots = ${JSON.stringify(roots)};
    const instances = new Map();
    const host = await OpenCode.create({
      database:{path:${JSON.stringify(path.join(home, "locations.sqlite"))}},
      config:{directory:${JSON.stringify(path.join(home, "config"))},project:false,claude:false,content:'{}'},
      models:{fetch:false,snapshot:false},fs:{filewatcher:false,fff:false},fetch:globalThis.fetch,
      plugins:[{id:'location-checkpoints-probe',setup:async ctx => {
        const hooks = new Map();
        const controller = await installCheckpoints({...ctx,options:{checkpoints:true},tool:{
          ...ctx.tool,
          hook:async (name, callback) => {
            hooks.set(name, callback);
            return ctx.tool.hook(name, callback);
          },
        }});
        instances.set(ctx.location.directory, {ctx,controller,hooks});
        return () => controller.dispose();
      }}],
    });
    try {
      const activate = async root => {
        await host.agent.list({location:{directory:root}});
        const instance = instances.get(root);
        assert.ok(instance, 'SDK activated plugin at requested location');
        return instance;
      };
      const notes = {origin:'Synthetic multi-location objective',current:'Ready',next:'Inspect',decisions:[],paths:[]};
      const update = async (instance, sessionID, current) => {
        const tool = (await instance.ctx.tool.list()).find(tool => tool.id === 'open_enhance_checkpoint');
        assert.ok(tool);
        // Deliberate direct executor invocation: no model, fabricated transport,
        // or assertion that tool.list executors pass through dispatch hooks.
        await tool.execute({...notes,current}, {sessionID,agent:'build',messageID:'location-message',id:'location-update',signal:new AbortController().signal,progress:async()=>{}});
      };
      stage = 'activate A and record live hook';
      const a = await activate(roots[0]);
      const sessionA = await host.session.create({location:{directory:roots[0]}});
      await update(a, sessionA.id, 'A initialized');
      const event = {sessionID:sessionA.id,agent:'build',messageID:'location-message',id:'live-location-call',tool:'location_probe',input:{}};
      await a.hooks.get('execute.before')(event);
      assert.equal((await a.controller.status(sessionA.id)).journal.find(j => j.call === event.id).outcome, 'pending');

      stage = 'activate B while A hook remains live';
      assert.equal(instances.has(roots[1]), false);
      const b = await activate(roots[1]);
      assert.notEqual(a.ctx.storage, b.ctx.storage, 'host provides distinct location storage wrappers');
      assert.deepEqual(await a.ctx.storage.get('checkpoints/v1'), await b.ctx.storage.get('checkpoints/v1'), 'location wrappers share the real plugin KV namespace');
      const live = (await a.controller.status(sessionA.id)).journal.find(j => j.call === event.id);
      assert.equal(live.outcome, 'pending', 'new location startup must not classify another live controller call as unknown');
      await a.hooks.get('execute.after')({...event,status:'completed',result:{content:'Synthetic callback completed'}});
      assert.equal((await a.controller.status(sessionA.id)).journal.find(j => j.call === event.id).outcome, 'completed');

      stage = 'concurrent A pause and B checkpoint writes';
      const sessionB = await host.session.create({location:{directory:roots[1]}});
      await update(b, sessionB.id, 'B initialized');
      for (let i = 0; i < 12; i++) {
        await Promise.all([
          a.controller.pause(sessionA.id),
          update(b, sessionB.id, 'B progress '+i),
        ]);
        const paused = await a.controller.status(sessionA.id);
        assert.equal(paused.state, 'paused');
        assert.ok(paused.blockedBy.includes(sessionA.id));
        const shared = await b.ctx.storage.get('checkpoints/v1');
        assert.equal(shared.sessions.find(s => s.id === sessionA.id).paused, true);
        assert.equal(shared.sessions.find(s => s.id === sessionB.id).current, 'B progress '+i);
        assert.ok(!JSON.stringify(paused).includes(sessionB.id), 'A status excludes unrelated B history');
        await assert.rejects(host.session.prompt({sessionID:sessionA.id,text:'Ordinary input cannot reopen A'}));
        if (i === 0) {
          const child = await host.session.create({parentID:sessionA.id,location:{directory:roots[1]}});
          const marker = roots[1]+'/manual-native-shell-marker';
          assert.ok((await b.controller.status(child.id)).blockedBy.includes(sessionA.id));
          // Manual native shells are outside checkpoint tool-dispatch coverage.
          // In particular, A's pause must never block unrelated B shell work.
          await host.session.shell({sessionID:sessionB.id,command:'/usr/bin/touch '+marker});
          await host.session.wait({sessionID:sessionB.id});
          await access(marker);
        }
        // B activity must not stale A's scoped Resume revision.
        await update(b, sessionB.id, 'B independent progress '+i);
        assert.equal((await a.controller.status(sessionA.id)).revision, paused.revision);
        const resumed = await a.controller.resume(sessionA.id,{revision:paused.revision});
        assert.equal(resumed.state, 'running');
      }

      stage = 'native deletion B does not poison A';
      await host.session.remove({sessionID:sessionB.id});
      await assert.rejects(host.session.get({sessionID:sessionB.id}));
      assert.ok((await a.ctx.storage.get('checkpoints/v1')).sessions.some(s => s.id === sessionB.id), 'deleted native session remains in checkpoint history for this regression');
      assert.equal((await a.controller.status(sessionA.id)).state, 'running');
      const paused = await a.controller.pause(sessionA.id);
      assert.equal(paused.status.state, 'paused');
      assert.deepEqual(paused.interruptFailures, []);
      const resumed = await a.controller.resume(sessionA.id,{revision:paused.status.revision});
      assert.equal(resumed.state, 'running');
      assert.deepEqual(resumed.blockedBy, []);
      // SDK activation may probe local-provider discovery even with model
      // snapshot/fetch disabled. The stub rejects BEFORE any network I/O; no
      // completion/generation request is allowed, not even a mocked one.
      const discovery = new Set(['http://127.0.0.1:1234/api/v1/models','http://127.0.0.1:11434/api/tags','http://127.0.0.1:8000/health']);
      assert.ok(blockedFetches.every(url => discovery.has(url)), 'unexpected/model fetch attempted: '+JSON.stringify(blockedFetches));
      console.log(JSON.stringify({status:'ok',sharedStorage:true,liveCallPreserved:true,concurrentPausePreserved:true,deletedHistoryIsolated:true,networkDisabled:true,modelRequests:0}));
    } finally { await host.close(); }
  `
  try {
    const { stdout } = await promisify(execFile)(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      cwd: repository,
      env: {
        PATH: path.dirname(process.execPath), HOME: home, TMPDIR: home,
        XDG_CONFIG_HOME: path.join(home, "config"), XDG_DATA_HOME: path.join(home, "data"),
        XDG_CACHE_HOME: path.join(home, "cache"), XDG_STATE_HOME: path.join(home, "state"),
        OPENCODE_DISABLE_CLAUDE_CODE: "true", PYTHONNOUSERSITE: "1", PYTHONDONTWRITEBYTECODE: "1",
        HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1",
      },
      timeout: 45_000, maxBuffer: 1024 * 1024,
    })
    const result = JSON.parse(stdout.trim().split("\n").at(-1)!)
    assert.deepEqual(result, { status: "ok", sharedStorage: true, liveCallPreserved: true, concurrentPausePreserved: true, deletedHistoryIsolated: true, networkDisabled: true, modelRequests: 0 })
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})
