const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { createHash, randomUUID } = require('node:crypto');
const { mkdtemp, mkdir, readdir, readFile, rm, writeFile } = require('node:fs/promises');
const { createServer } = require('node:http');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { BackendClient, BackendRuntime } = require('../dist/backend.js');
const { ExportSaver, EXPORT_FILES, validExportManifest } = require('../dist/export_saver.js');
const repoRoot=path.resolve(__dirname,'../..'), python=process.env.BAT_PYTHON || 'python';
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function terminal(read, active) {
  for(let i=0;i<1000;i++) { const r=await read(); assert.equal(r.ok,true,JSON.stringify(r)); if(!active.includes(r.value.state))return r.value; await delay(20); }
  assert.fail('Real job timed out');
}

test('real export runtime saves bounded three-file snapshot atomically, private IPC IDs, source unchanged', {timeout:45000},async t=>{
  const directory=await mkdtemp(path.join(tmpdir(),'bat-export-node-'));
  const dataDir=path.join(directory,'data'), destination=path.join(directory,'destination');await mkdir(destination);
  const runtime=new BackendRuntime(); let saver;
  t.after(async()=>{await saver?.close();await runtime.stop();await rm(directory,{recursive:true,force:true});});
  const generated=spawnSync(python,['-m','backend.tests.summary_fixtures',path.join(directory,'originals')],{cwd:repoRoot,encoding:'utf8',timeout:15000});
  assert.equal(generated.status,0,generated.stderr);const source=JSON.parse(generated.stdout).quiet_65, before=await readFile(source);
  assert.equal((await runtime.start({python,repoRoot,dataDir})).ok,true);
  await runtime.upgradeMedia(); const session=await runtime.createSession({display_name:'Synthetic export',camera_ref:'Synthetic camera'});
  const imported=await runtime.importSelectedMedia(session.value.id,[source]);
  assert.equal((await terminal(()=>runtime.importStatus(imported.value.id),['running'])).state,'complete');
  await runtime.upgradeSummaries();await runtime.upgradeReviews();await runtime.upgradeQA();
  const started=await runtime.startSummaries({session_id:session.value.id,window_seconds:30});
  const run=await terminal(()=>runtime.summaryRun(started.value.id),['queued','running']);
  const job=await runtime.startExport(run.id);const done=await terminal(()=>runtime.exportStatus(job.value.id),['working']);
  assert.equal(done.state,'ready',JSON.stringify(done));assert.equal(done.manifest.counts.planned,3);
  saver=new ExportSaver(runtime,repoRoot,dataDir);await saver.recover();
  assert.equal((await saver.save('/unselected',async()=>destination)).error.code,'invalid');
  assert.equal((await saver.save(job.value.id,async()=>repoRoot)).ok,false);
  assert.equal((await saver.save(job.value.id,async()=>dataDir)).ok,false);
  assert.equal((await saver.save(job.value.id,async()=>null)).value.cancelled,true);
  const saved=await saver.save(job.value.id,async()=>destination);
  assert.equal(saved.ok,true,JSON.stringify(saved));assert.equal(saved.value.cancelled,false);
  assert.deepEqual((await readdir(destination)),[saved.value.folder_name]);
  for(const kind of Object.keys(EXPORT_FILES)) {
    const bytes=await readFile(path.join(destination,saved.value.folder_name,EXPORT_FILES[kind]));
    assert.equal(createHash('sha256').update(bytes).digest('hex'),done.manifest.files[kind].sha256);
    assert.equal(bytes.length,done.manifest.files[kind].bytes);
  }
  assert.deepEqual(await readFile(source),before);
  await saver.close();await runtime.stop();
  assert.deepEqual(await readdir(path.join(dataDir,'exports')),[]);
  assert.deepEqual((await readdir(destination)),[saved.value.folder_name]); // published exports survive quit
});

for (const mode of ['wrong-mime','wrong-length','wrong-hash','truncated','oversized']) {
  test(`bounded privileged stream rejects ${mode}`,async t=>{
    const directory=await mkdtemp(path.join(tmpdir(),'bat-export-stream-'));t.after(()=>rm(directory,{recursive:true,force:true}));
    const id=randomUUID(), bytes=Buffer.from('safe synthetic CSV\r\n');
    const server=createServer((req,res)=>{
      assert.equal(req.url,`/api/exports/${id}/files/audit`);assert.equal(req.headers['x-bat-token'],'synthetic-token');
      res.writeHead(200,{'Content-Type':mode==='wrong-mime'?'text/html':'text/csv; charset=utf-8','Content-Length':mode==='wrong-length'?bytes.length+1:bytes.length});
      if(mode==='truncated'){res.write(bytes.subarray(0,3));setTimeout(()=>res.destroy(),5);}else res.end(bytes);
    });await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
    const client=new BackendClient(server.address().port,'synthetic-token');
    const descriptor={name:EXPORT_FILES.audit,bytes:mode==='oversized'?8*1024*1024+1:bytes.length,sha256:mode==='wrong-hash'?'0'.repeat(64):createHash('sha256').update(bytes).digest('hex')};
    await assert.rejects(client.downloadExportFile(id,'audit',descriptor,path.join(directory,'out.csv'),new AbortController().signal));
    assert.equal((await client.startExport('/unselected')).error.code,'invalid');
  });
}

function manifest(run) {
  return {schema_version:'bat-provisional-csv-v1',provisional_label:'PROVISIONAL — NOT ECOLOGICALLY FINALISED',run_id:run,
    files:Object.fromEntries(Object.entries(EXPORT_FILES).map(([key,name])=>[key,{name,bytes:10,sha256:'0'.repeat(64)}]))};
}
for(const mode of ['enospc','rename-obstruction','cancel']) {
  test(`native publication ${mode} removes stages and retains originals`,async t=>{
    const directory=await mkdtemp(path.join(tmpdir(),'bat-export-save-failure-')),data=path.join(directory,'data'),dest=path.join(directory,'dest');
    await mkdir(data);await mkdir(dest);await writeFile(path.join(dest,'synthetic-original.mp4'),'unchanged');
    t.after(()=>rm(directory,{recursive:true,force:true}));
    const run=randomUUID(),id=randomUUID();let saver;
    const backend={exportStatus:async()=>({ok:true,value:{state:'ready',run_id:run,manifest:manifest(run)}}),downloadExportFile:async(_id,_kind,_file,p,signal)=>{
      if(mode==='enospc')throw Object.assign(new Error('synthetic full disk'),{code:'ENOSPC'});
      if(mode==='cancel'){await writeFile(p,'partial');await new Promise((resolve,reject)=>{signal.addEventListener('abort',()=>reject(new Error('aborted')),{once:true});setTimeout(()=>void saver.close(),5);});}
      else {await writeFile(p,'synthetic');const record=JSON.parse(await readFile(path.join(data,'export-save-pending.json'),'utf8'));await writeFile(path.join(dest,`bat-provisional-${record.nonce}`,'obstruction'),'synthetic');}
    }};
    saver=new ExportSaver(backend,repoRoot,data);t.after(()=>saver.close());
    const result=await saver.save(id,async()=>dest);assert.equal(result.ok,false);
    assert.deepEqual(await readdir(dest),['synthetic-original.mp4']);assert.equal(await readFile(path.join(dest,'synthetic-original.mp4'),'utf8'),'unchanged');
    assert.deepEqual(await readdir(data),[]);
  });
}

test('native restart cleans interrupted stages and empty reservations, preserves atomic completed bundle',async t=>{
  const directory=await mkdtemp(path.join(tmpdir(),'bat-export-recover-')),data=path.join(directory,'data');await mkdir(data);
  t.after(()=>rm(directory,{recursive:true,force:true}));
  await writeFile(path.join(data,'export-save-pending.json.part'),'interrupted intent write');
  const interrupted=new ExportSaver({},repoRoot,data);await interrupted.recover();await interrupted.close();
  assert.deepEqual(await readdir(data),[]);
  for(const complete of [false,true]) {
    const nonce=randomUUID(),stage=path.join(directory,`.bat-provisional-${nonce}.part`),target=path.join(directory,`bat-provisional-${nonce}`);
    await mkdir(stage);await writeFile(path.join(stage,'partial'),'synthetic');await mkdir(target);
    if(complete)await writeFile(path.join(target,'manifest.json'),'synthetic completed bundle');
    await writeFile(path.join(data,'export-save-pending.json'),JSON.stringify({parent:directory,nonce}));
    const saver=new ExportSaver({},repoRoot,data);await saver.recover();await saver.close();
    assert.equal((await readdir(directory)).includes(path.basename(stage)),false);
    assert.equal((await readdir(directory)).includes(path.basename(target)),complete);
  }
  const valid=manifest(randomUUID());assert.equal(validExportManifest(valid,valid.run_id),true);
  for(const change of [{name:'../../source.mp4'},{bytes:8*1024*1024+1},{sha256:'invalid'}])assert.equal(validExportManifest({...valid,files:{...valid.files,audit:{...valid.files.audit,...change}}},valid.run_id),false);
});
