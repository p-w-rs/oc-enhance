import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { releaseFingerprint } from "./release-fingerprint.mjs"

const root = process.cwd()
const pixi = process.env.OPEN_ENHANCE_PIXI ?? process.env.PIXI_EXE ?? execFileSync("/usr/bin/which", ["pixi"], { encoding: "utf8" }).trim()
const release = path.join(root, ".local/release")
mkdirSync(release, { recursive: true, mode: 0o700 })
const cache = JSON.parse(execFileSync(pixi, ["info", "--json"], { encoding: "utf8" })).cache_dir
const packed = JSON.parse(execFileSync("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", release, "--cache", ".local/npm-cache"], { encoding: "utf8" }))[0]
const archive = path.join(release, packed.filename)
const archiveSha256 = createHash("sha256").update(readFileSync(archive)).digest("hex")
const stage = mkdtempSync(path.join(root, ".local/package-acceptance-"))
execFileSync("/usr/bin/tar", ["-xzf", archive, "-C", stage])
const installation = path.join(stage, "package")
const home = path.join(stage, "home")
const workspace = path.join(stage, "synthetic")
for (const directory of [home, workspace]) mkdirSync(directory, { mode: 0o700 })
writeFileSync(path.join(workspace, "guide.md"), "# Synthetic package acceptance\nThe amber kestrel uses nineteen pulses.\n")
const env = {
  HOME: home, TMPDIR: home, PATH: "/usr/bin:/bin", SHELL: "/bin/bash",
  XDG_CONFIG_HOME: path.join(home, "config"), XDG_DATA_HOME: path.join(home, "data"),
  XDG_STATE_HOME: path.join(home, "state"), XDG_CACHE_HOME: path.join(home, "cache"),
  PIXI_CACHE_DIR: cache, PIXI_NO_CONFIG: "true", OPEN_ENHANCE_PIXI: pixi,
  PYTHONNOUSERSITE: "1", PYTHONDONTWRITEBYTECODE: "1",
  OPENCODE_DISABLE_CLAUDE_CODE: "true", HF_HUB_OFFLINE: "1",
}
function run(args, timeout = 180_000) {
  return execFileSync(pixi, args, { cwd: installation, env, encoding: "utf8", timeout, maxBuffer: 4 * 1024 * 1024 })
}
const manifest = path.join(installation, "pixi.toml")
const report = { schema: 1, passed: false, archiveSha256, fingerprint: releaseFingerprint(root), note: "Fresh extracted package, isolated HOME and system-only initial PATH; reused dependency caches. Not a clean-machine or desktop acceptance test." }
try {
  run(["install", "--locked", "--offline", "--manifest-path", manifest])
  const prefix = ["run", "--locked", "--offline", "--manifest-path", manifest]
  run([...prefix, "npm", "ci", "--offline", "--ignore-scripts", "--cache", path.join(root, ".local/npm-cache")])
  run([...prefix, "npm", "run", "check"])
  run([...prefix, "npm", "audit", "--json"])
  const script = `
    import assert from 'node:assert/strict';
    globalThis.fetch = async () => { throw new Error('network disabled'); };
    const {OpenCode} = await import('@opencode/sdk');
    const {createPlugin} = await import('./plugin/index.ts');
    let context;
    const adapter = createPlugin();
    const host = await OpenCode.create({database:{path:':memory:'},config:{directory:${JSON.stringify(path.join(home, "config"))},project:false,claude:false,content:'{}'},models:{fetch:false,snapshot:false},fs:{filewatcher:false,fff:false},fetch:globalThis.fetch,plugins:[{id:adapter.id,setup:async ctx=>{context=ctx;return adapter.setup({...ctx,options:{evidence:true,checkpoints:true,pixiExecutable:${JSON.stringify(pixi)},dataDirectory:${JSON.stringify(path.join(stage, "evidence"))}}})}}]});
    try {
      const session=await host.session.create({location:{directory:${JSON.stringify(workspace)}}});
      await host.session.update({sessionID:session.id,permissions:[{action:'read',resource:'*',effect:'allow'}]});
      await host.agent.list({location:{directory:${JSON.stringify(workspace)}}});
      const tools=await context.tool.list();
      for (const name of ['read','grep','shell','open_enhance_checkpoint','open_enhance_handoff','open_enhance_search']) assert.ok(tools.some(t=>t.id===name),name);
      const execution={sessionID:session.id,agent:'build',messageID:'package-smoke',id:'package-smoke',signal:new AbortController().signal,progress:async()=>{}};
      const checkpoint=tools.find(t=>t.id==='open_enhance_checkpoint');
      const notes={origin:'Packaged task',current:'Prepared',next:'Inspect',decisions:[],paths:[]};
      await checkpoint.execute(notes,execution);
      await checkpoint.execute({...notes,origin:'Updated objective'},execution);
      const handoff=JSON.parse((await tools.find(t=>t.id==='open_enhance_handoff').execute({action:'export'},execution)).content);
      assert.equal(handoff.notes.origin,'Updated objective');
      const result=JSON.parse((await tools.find(t=>t.id==='open_enhance_search').execute({query:'amber kestrel',mode:'lexical'},execution)).content);
      assert.ok(result.results.some(hit=>hit.evidence.path==='guide.md'));
      const commands=await context.command.list();
      for(const name of ['enhance-pause','enhance-resume','enhance-status']) assert.ok(commands.data.some(command=>command.name===name));
      console.log(JSON.stringify({passed:true,modelRequests:0,backend:'pixi-lexical'}));
    } finally {await host.close();}
  `
  const result = run([...prefix, "node", "--import", "tsx", "--input-type=module", "-e", script], 90_000)
  if (!JSON.parse(result.trim()).passed) throw new Error("Packaged adapter acceptance failed")
  report.passed = true
} finally {
  writeFileSync(path.join(release, "packaged-install.json"), JSON.stringify(report, null, 2) + "\n", { mode: 0o600 })
  console.log(JSON.stringify(report))
}
