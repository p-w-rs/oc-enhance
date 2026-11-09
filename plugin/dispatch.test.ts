import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { execFile } from "node:child_process"
import { promisify } from "node:util"

// This is engine dispatch, not execution of a captured tool.list() executor.
// Only the provider transport is fake: the SDK parses SSE and dispatches tools.
test("isolated SDK dispatch enforces Pixi and durable checkpoint hooks with fake model SSE", { timeout: 90_000 }, async () => {
  const repository = fileURLToPath(new URL("../", import.meta.url))
  await mkdir(path.join(repository, ".local"), { recursive: true })
  const home = await realpath(await mkdtemp(path.join(repository, ".local", "dispatch-")))
  const root = path.join(home, "synthetic-workspace")
  await mkdir(root)
  const pixi = (await promisify(execFile)("/usr/bin/which", ["pixi"])).stdout.trim()
  assert.ok(path.isAbsolute(pixi))
  const script = `
    let stage = 'startup';
    process.on('uncaughtException', error => {console.log(JSON.stringify({status:'error',stage,error:String(error),detail:inspect(error,{depth:8}),stack:error.stack}));process.exit(0);});
    import {inspect} from 'node:util';
    import {execFile} from 'node:child_process';
    import {promisify} from 'node:util';
    import assert from 'node:assert/strict';
    import {writeFile, access} from 'node:fs/promises';
    import path from 'node:path';
    const root = ${JSON.stringify(root)};
    const marker = path.join(root, 'forbidden-marker');
    const missing = async () => assert.rejects(access(marker), {code:'ENOENT'});
    let requests = 0, calls = [], contexts = [], shellEvents = [], toolEvents = [], controller, pendingObserved = false, shellCompleted = false;
    await writeFile(path.join(root,'pixi.toml'), '[workspace]\\nname = "synthetic-dispatch"\\nchannels = []\\nplatforms = ["osx-arm64"]\\n[tasks]\\nprobe = "pwd"\\n');
    await promisify(execFile)(${JSON.stringify(pixi)}, ['lock'], {cwd:root,env:process.env});
    const fakeFetch = async (input, init) => {
      const request = new Request(input, init);
      assert.equal(request.url, 'https://dispatch.invalid/v1/chat/completions');
      const body = await request.json();
      assert.equal(body.stream, true);
      requests++;
      const call = calls.shift();
      const chunk = (delta, finish_reason = null) => ({id:'dispatch-'+requests,object:'chat.completion.chunk',created:0,model:'probe',choices:[{index:0,delta,finish_reason}]});
      const chunks = call ? [chunk({role:'assistant',tool_calls:[{index:0,id:'call-'+requests,type:'function',function:{name:call.name,arguments:JSON.stringify(call.input)}}]}),chunk({},'tool_calls')] : [chunk({role:'assistant',content:'done'}),chunk({},'stop')];
      return new Response(chunks.map(x=>'data: '+JSON.stringify(x)+'\\n\\n').join('')+'data: [DONE]\\n\\n',{headers:{'content-type':'text/event-stream'}});
    };
    // Every outbound fetch is intercepted; no listener, credentials or service.
    globalThis.fetch = fakeFetch;
    const {OpenCode} = await import('@opencode/sdk');
    const {installPixiPolicy} = await import(${JSON.stringify(new URL("./pixi-policy.ts", import.meta.url).href)});
    const {installCheckpoints} = await import(${JSON.stringify(new URL("./checkpoint.ts", import.meta.url).href)});
    const createHost = () => OpenCode.create({
      database:{path:${JSON.stringify(path.join(home, "dispatch.sqlite"))}},
      config:{directory:${JSON.stringify(path.join(home, "config"))},project:false,claude:false,content:JSON.stringify({
        model:'dispatch/probe',
        providers:{dispatch:{
          package:'@opencode/ai/providers/openai-compatible',
          settings:{baseURL:'https://dispatch.invalid/v1',apiKey:'synthetic-not-a-secret'},
          models:{probe:{limit:{context:32000,output:1024},capabilities:{tools:true,input:['text'],output:['text']}}},
        }},
      })},
      models:{fetch:false,snapshot:false},fs:{filewatcher:false,fff:false},fetch:fakeFetch,
      plugins:[{id:'dispatch-probe',setup:async ctx => {
        await ctx.session.hook('title', event => {event.result='Synthetic dispatch';});
        await ctx.session.hook('context', event => {contexts.push(Object.keys(event.tools));});
        await ctx.tool.hook('execute.before', event => {toolEvents.push({tool:event.tool,input:event.input});});
        await ctx.shell.hook('create.before', event => {shellEvents.push(event.command);});
        const policy = await installPixiPolicy({...ctx,options:{pixiGuard:true}});
        controller = await installCheckpoints({...ctx,options:{checkpoints:true}});
        await ctx.tool.transform(editor => editor.update('shell', tool => {
          const execute = tool.execute;
          tool.execute = async (input, context) => {
            const status = await controller.status(context.sessionID);
            assert.ok(status.journal.some(entry=>entry.call===context.id && entry.outcome==='pending'),'durable pending journal precedes native tool execution');
            pendingObserved = true;
            return execute(input,context);
          };
        }));
        await ctx.tool.hook('execute.after', event => {
          if(event.tool==='shell' && event.status==='completed') {
            assert.ok(JSON.stringify(event.result.content).includes(root),'real pwd output contains synthetic workspace');
            shellCompleted = true;
          }
        });
        return async () => {await controller.dispose();await policy?.();};
      }}],
    });
    let host = await createHost();
    try {
      stage = 'maintenance tool denied by native permissions';
      const restricted = await host.session.create({location:{directory:root}});
      await host.session.update({sessionID:restricted.id,permissions:[{action:'open_enhance_checkpoint',resource:'*',effect:'deny'}]});
      const beforeRestricted = requests;
      try {
        await host.session.prompt({sessionID:restricted.id,text:'Synthetic restricted checkpoint initialization'});
        await host.session.wait({sessionID:restricted.id});
      } catch { /* Native execution may report the context rejection to wait. */ }
      assert.equal(requests,beforeRestricted,'an unavailable checkpoint tool must not induce rejected-tool model loops');
      assert.ok(contexts.some(tools=>!tools.includes('open_enhance_checkpoint')),'native permissions actually hid the maintenance tool');
      stage = 'create';
      const session = await host.session.create({location:{directory:root}});
      stage = 'permissions';
      await host.session.update({sessionID:session.id,permissions:[{action:'*',resource:'*',effect:'allow'}]});
      const run = async sequence => {
        calls = [...sequence];
        await host.session.prompt({sessionID:session.id,text:'Synthetic deterministic dispatch probe'});
        await host.session.wait({sessionID:session.id});
        assert.equal(calls.length,0,'engine consumed scripted tool calls');
      };
      stage = 'checkpoint';
      await run([{name:'open_enhance_checkpoint',input:{origin:'Synthetic dispatch safety',current:'Ready',next:'Check guarded command',decisions:[],paths:[]}}]);
      assert.ok(contexts.some(tools=>tools.includes('shell') && tools.includes('open_enhance_checkpoint')));
      const command = 'python3 -c \\'open("forbidden-marker", "w").write("bad")\\'';
      const beforeDenied = shellEvents.length;
      stage = 'denied model shell';
      await run([{name:'shell',input:{command,description:'Synthetic forbidden Python'}}]);
      assert.ok(toolEvents.some(event=>event.tool==='shell' && event.input.command===command));
      assert.equal(shellEvents.length,beforeDenied,'tool before rejection prevents reaching shell creation');
      assert.match(JSON.stringify(await host.session.context({sessionID:session.id})),/open-enhance Pixi policy/,'engine records the policy rejection, not an unrelated dispatch failure');
      await missing();
      // The explicit shell API bypasses model tool dispatch; it must still be guarded.
      stage = 'denied explicit shell';
      await assert.rejects(host.session.shell({sessionID:session.id,command}));
      await host.session.wait({sessionID:session.id});
      assert.ok(shellEvents.includes(command),'explicit shell reaches native shell hook');
      await missing();
      stage = 'allowed Pixi model shell';
      await run([{name:'shell',input:{command:'pixi run --locked probe',description:'Synthetic benign pwd task'}}]);
      assert.ok(shellEvents.includes('pixi run --locked probe'));
      assert.equal(pendingObserved,true);
      assert.equal(shellCompleted,true);
      const status = await controller.status(session.id);
      assert.ok(status.journal.some(entry=>entry.tool==='shell' && entry.outcome==='completed'));
      stage = 'pause and explicit resume';
      const paused = await controller.pause(session.id);
      assert.equal(paused.status.state,'paused');
      assert.deepEqual(paused.interruptFailures,[]);
      stage = 'restart while paused';
      await host.close();
      host = await createHost();
      await host.agent.list({location:{directory:root}});
      const restored = await controller.status(session.id);
      assert.equal(restored.state,'paused','pause survives real SDK host close/reopen');
      assert.ok(restored.sessions.some(entry=>entry.id===session.id && entry.origin==='Synthetic dispatch safety'));
      const beforePauseRequests = requests;
      await assert.rejects(host.session.prompt({sessionID:session.id,text:'Ordinary message must not resume'}));
      assert.equal(requests,beforePauseRequests);
      assert.equal((await controller.resume(session.id)).state,'needs-reconciliation');
      const current = await controller.status(session.id);
      assert.equal(current.state,'paused');
      assert.equal((await controller.resume(session.id,{revision:current.revision,reconciliation:'Synthetic workspace checked; no forbidden marker exists',acknowledgeUnknown:true})).state,'running');
      await run([]);
      await missing();
      console.log(JSON.stringify({status:'ok',requests,toolBeforeBlocked:true,shellBeforeBlocked:true,pendingObserved,shellCompleted,pauseResume:true,restartPaused:true}));
    } finally {await host.close();}
  `
  try {
    const { stdout } = await promisify(execFile)(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      cwd: repository,
      env: {
        PATH: `${path.dirname(pixi)}:${path.join(repository, ".pixi", "envs", "default", "bin")}${path.delimiter}/usr/bin:/bin`,
        HOME: home, TMPDIR: home,
        XDG_CONFIG_HOME: path.join(home, "config"), XDG_DATA_HOME: path.join(home, "data"),
        XDG_CACHE_HOME: path.join(home, "cache"), XDG_STATE_HOME: path.join(home, "state"),
        OPENCODE_DISABLE_CLAUDE_CODE: "true", PYTHONNOUSERSITE: "1", PYTHONDONTWRITEBYTECODE: "1",
        HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1",
        PIXI_OFFLINE: "true", PIXI_NO_CONFIG: "true", PIXI_NO_PROGRESS: "true",
      },
      timeout: 75_000, maxBuffer: 1024 * 1024,
    })
    const result = JSON.parse(stdout.trim().split("\n").at(-1)!) as Record<string, unknown>
    assert.equal(result.status, "ok", JSON.stringify(result))
    assert.equal(result.toolBeforeBlocked, true)
    assert.equal(result.shellBeforeBlocked, true)
    assert.equal(result.pendingObserved, true)
    assert.equal(result.shellCompleted, true)
    assert.equal(result.pauseResume, true)
    assert.equal(result.restartPaused, true)
    assert.ok(Number(result.requests) >= 4)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})
