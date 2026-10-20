import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import type { BatAPI, SummaryDetail } from '../src/contracts';
import { launch, quit, cleanup, type RunningShell } from './shell-helpers';

test.skip(process.platform !== 'linux', 'Export process limits and native save acceptance are verified locally on Linux only.');

test('provisional native CSV export includes all windows despite filters, protects drafts and persists a complete bundle', async () => {
  test.setTimeout(120000);
  const directory=await mkdtemp(join(tmpdir(),'bat-export-e2e-')), data=join(directory,'data'), destination=join(directory,'saved');
  await mkdir(destination);
  const generated=spawnSync(process.env.BAT_PYTHON ?? 'python',['-m','backend.tests.summary_fixtures',join(directory,'originals')],{cwd:resolve('.'),encoding:'utf8',timeout:15000});
  expect(generated.status,generated.stderr).toBe(0);
  const fixtures=JSON.parse(generated.stdout) as Record<string,string>;
  const paths=[fixtures.quiet_65!,fixtures.empty_middle!];
  const hashes=await Promise.all(paths.map(async p=>createHash('sha256').update(await readFile(p)).digest('hex')));
  let shell:RunningShell|undefined;
  try {
    shell=await launch(data);
    await shell.page.getByRole('button',{name:'Create session',exact:true}).click();
    await shell.page.getByRole('button',{name:'Inspect media',exact:true}).click();
    await shell.page.getByRole('button',{name:'Upgrade media storage',exact:true}).click();
    await shell.application.evaluate(({dialog}, originals)=>{ dialog.showOpenDialog=(async()=>({canceled:false,filePaths:originals})) as typeof dialog.showOpenDialog; },paths);
    await shell.page.getByRole('button',{name:'Choose original videos',exact:true}).click();
    await expect(shell.page.getByRole('article',{name:/^Segment /})).toHaveCount(2);
    await shell.page.getByRole('button',{name:'Upgrade summary storage',exact:true}).click();
    await shell.page.getByRole('button',{name:'Generate motion summaries',exact:true}).click();
    await expect(shell.page.getByRole('status').filter({hasText:/^Run incomplete:/})).toBeVisible();
    await shell.page.getByRole('button',{name:'Upgrade review storage',exact:true}).click();
    await shell.page.getByRole('button',{name:'Upgrade QA storage',exact:true}).click();
    const run=await shell.page.evaluate(async()=>{
      const api=(window as unknown as {batAPI:BatAPI}).batAPI;
      const sessions=await api.listSessions();if(!sessions.ok)throw new Error(sessions.error.message);
      const runs=await api.listSummaryRuns(sessions.value[0]!.id);if(!runs.ok)throw new Error(runs.error.message);
      const detail=await api.summaryRun(runs.value[0]!.id);if(!detail.ok)throw new Error(detail.error.message);return detail.value;
    }) as SummaryDetail;
    expect(run.windows).toHaveLength(6);
    const action=shell.page.getByRole('button',{name:'Export provisional CSVs',exact:true});
    await expect(action).toBeDisabled();
    await shell.page.getByRole('checkbox',{name:'I understand these CSVs are provisional and not final ecological reports.',exact:true}).check();
    await expect(action).toBeEnabled();
    await shell.page.getByLabel('Reviewer label',{exact:true}).fill('Unsaved synthetic label');
    await expect(action).toBeDisabled();
    const dirtyIPC=await shell.page.evaluate(id=>(window as unknown as {batAPI:BatAPI}).batAPI.startExport(id),run.id);
    expect(dirtyIPC.ok).toBe(false);
    await shell.page.getByRole('button',{name:'Discard review draft',exact:true}).click();
    await expect(action).toBeEnabled();
    await shell.page.getByLabel('QA reviewer label',{exact:true}).fill('Unsaved synthetic QA');
    await expect(action).toBeDisabled();
    expect((await shell.page.evaluate(id=>(window as unknown as {batAPI:BatAPI}).batAPI.startExport(id),run.id)).ok).toBe(false);
    await shell.page.getByRole('button',{name:'Discard QA draft',exact:true}).click();
    await shell.page.getByLabel('Clock anchor segment',{exact:true}).selectOption(run.windows[0]!.segment_id);
    await expect(action).toBeDisabled();
    expect((await shell.page.evaluate(id=>(window as unknown as {batAPI:BatAPI}).batAPI.startExport(id),run.id)).ok).toBe(false);
    await shell.page.getByRole('button',{name:'Discard unsaved changes',exact:true}).click();
    // Save a genuine provisional observation through the existing review UI.
    await shell.page.getByLabel('Reviewer label',{exact:true}).fill('=Synthetic first reviewer');
    await shell.page.getByRole('button',{name:'Add provisional observation',exact:true}).click();
    await shell.page.getByLabel('Observation end source PTS (exclusive)',{exact:true}).fill(String(BigInt(run.windows[0]!.preview_pts!)+1n));
    await shell.page.getByLabel('Observation notes',{exact:true}).fill('=SUM(1,2)\n"Synthetic", provisional');
    await shell.page.getByRole('button',{name:'Save observation',exact:true}).click();
    // Saving an observation records an audit event but never auto-completes review.
    await shell.page.getByLabel('Window filter',{exact:true}).selectOption('Failed/incomplete');
    await expect(shell.page.getByRole('list',{name:'Filtered planned windows',exact:true}).getByRole('article')).toHaveCount(1);
    await expect(action).toBeEnabled();await action.click();
    const exportPanel=shell.page.getByRole('region',{name:'Provisional CSV export',exact:true});
    await expect(exportPanel.getByRole('status').filter({hasText:/^Export snapshot: 6 planned; 6 actual; 0 missing/})).toBeVisible();
    await expect(exportPanel).toContainText('processing INCOMPLETE');
    await expect(exportPanel).toContainText('bat-provisional-csv-v1');
    await shell.application.evaluate(({dialog})=>{dialog.showOpenDialog=(async()=>({canceled:true,filePaths:[]})) as typeof dialog.showOpenDialog;});
    await exportPanel.getByRole('button',{name:'Save provisional CSV bundle...',exact:true}).click();
    await expect(exportPanel.getByText('Save cancelled. Choose a destination when ready.',{exact:true})).toBeVisible();
    expect(await readdir(destination)).toEqual([]);
    await shell.application.evaluate(({dialog},dest)=>{dialog.showOpenDialog=(async()=>({canceled:false,filePaths:[dest]})) as typeof dialog.showOpenDialog;},destination);
    await exportPanel.getByRole('button',{name:'Save provisional CSV bundle...',exact:true}).click();
    await expect(exportPanel.getByRole('status').filter({hasText:/^Saved complete provisional bundle in /})).toBeVisible();
    const folders=await readdir(destination);expect(folders).toHaveLength(1);
    const folder=join(destination,folders[0]!);
    const parse=spawnSync(process.env.BAT_PYTHON ?? 'python',['-c',
      'import csv,json,sys; from pathlib import Path; from backend.app.csv_export import decode_text,NUMERIC; p=Path(sys.argv[1]); print(json.dumps({k:[{a:b if a in NUMERIC else decode_text(b) for a,b in r.items()} for r in csv.DictReader((p/f).open(newline=""))] for k,f in [("audit","technical-window-audit.csv"),("observations","provisional-observations.csv")]}))',folder],{cwd:resolve('.'),encoding:'utf8',timeout:15000});
    expect(parse.status,parse.stderr).toBe(0);
    const records=JSON.parse(parse.stdout) as {audit:Record<string,string>[];observations:Record<string,string>[]};
    expect(records.audit).toHaveLength(6);expect(records.observations).toHaveLength(1);
    expect(records.audit.every(r=>r.run_id===run.id)).toBe(true);
    expect(records.audit.some(r=>r.processing_status==='incomplete')).toBe(true);
    expect(records.observations[0]!.first_review_actor).toBe('=Synthetic first reviewer');
    expect(records.observations[0]!.count).toBe('');
    expect(records.observations[0]!.start_pts).toBe(run.windows[0]!.preview_pts);
    expect(records.observations[0]!.notes).toBe('=SUM(1,2)\n"Synthetic", provisional');
    const allText=await readFile(join(folder,'technical-window-audit.csv'),'utf8');expect(allText).not.toContain(directory);
    await quit(shell);shell=undefined;
    expect(await readdir(join(data,'exports'))).toEqual([]);
    shell=await launch(data);await quit(shell);shell=undefined;
    expect(await readdir(folder)).toEqual(['manifest.json','provisional-observations.csv','technical-window-audit.csv']);
    expect(await Promise.all(paths.map(async p=>createHash('sha256').update(await readFile(p)).digest('hex')))).toEqual(hashes);
  } finally {
    if(shell)await shell.application.evaluate(({dialog})=>{dialog.showMessageBoxSync=(()=>1) as typeof dialog.showMessageBoxSync;}).catch(()=>undefined);
    await cleanup(shell);await rm(directory,{recursive:true,force:true});
  }
});
