import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFile, mkdtemp, readFile, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { expect, test, type Locator } from '@playwright/test';
import type { BatAPI, ReviewHistory, SummaryDetail, WindowReview } from '../src/contracts';
import { cleanup, launch, quit, type RunningShell } from './shell-helpers';

type Fixtures = Record<'quiet_240' | 'vfr_65' | 'earlier_9' | 'empty_middle' | 'brightness_9', string>;
type BlobCounts = { live: number; peak: number; created: number; revoked: number; imageLive: number; videoLive: number };
type BinaryCounts = { active: number; peak: number; images: number; previews: number; collisions: number; manifests: number };

function sources(directory: string): Fixtures {
  const result = spawnSync(process.env.BAT_PYTHON ?? 'python', ['-m', 'backend.tests.gallery_fixtures', directory], {
    cwd: resolve('.'), encoding: 'utf8', timeout: 45_000,
  });
  expect(result.status, result.stderr || 'Synthetic gallery fixture generation failed').toBe(0);
  return JSON.parse(result.stdout) as Fixtures;
}

async function prepared(shell: RunningShell, originals: string[]): Promise<string> {
  await shell.page.getByRole('button', { name: 'Create session', exact: true }).click();
  await shell.page.getByRole('button', { name: 'Inspect media', exact: true }).click();
  await shell.page.getByRole('button', { name: 'Upgrade media storage', exact: true }).click();
  // Only the physical picker return is substituted. Import, decoding and persistence are real.
  await shell.application.evaluate(({ dialog }, files) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: files })) as typeof dialog.showOpenDialog;
  }, originals);
  await shell.page.getByRole('button', { name: 'Choose original videos', exact: true }).click();
  await expect(shell.page.getByRole('article', { name: /^Segment / })).toHaveCount(originals.length);
  await shell.page.getByRole('button', { name: 'Upgrade summary storage', exact: true }).click();
  await shell.page.getByRole('button', { name: 'Generate motion summaries', exact: true }).click();
  await expect(shell.page.getByRole('status').filter({ hasText: /^Run (complete|incomplete):/ })).toBeVisible();
  await shell.page.getByRole('button', { name: 'Upgrade review storage', exact: true }).click();
  await expect(shell.page.getByRole('heading', { name: 'Manual first review', exact: true })).toBeVisible();
  const sessions = await shell.page.evaluate(() => (window as unknown as { batAPI: BatAPI }).batAPI.listSessions());
  if (!sessions.ok) throw new Error(sessions.error.message);
  return sessions.value[0]!.id;
}

async function latest(shell: RunningShell, sessionID: string): Promise<SummaryDetail> {
  const result = await shell.page.evaluate(async id => {
    const api = (window as unknown as { batAPI: BatAPI }).batAPI;
    const runs = await api.listSummaryRuns(id);
    if (!runs.ok) return runs;
    return api.summaryRun(runs.value[0]!.id);
  }, sessionID);
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

async function review(shell: RunningShell, windowID: string): Promise<WindowReview> {
  const result = await shell.page.evaluate(id => (window as unknown as { batAPI: BatAPI }).batAPI.getWindowReview(id), windowID);
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

async function history(shell: RunningShell, windowID: string): Promise<ReviewHistory> {
  const result = await shell.page.evaluate(id => (window as unknown as { batAPI: BatAPI }).batAPI.reviewHistory(id, 0), windowID);
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

async function cleanupDraft(shell: RunningShell | undefined): Promise<void> {
  if (shell) await shell.application.evaluate(({ dialog }) => {
    dialog.showMessageBoxSync = (() => 1) as typeof dialog.showMessageBoxSync;
  }).catch(() => undefined);
  await cleanup(shell);
}

function cards(shell: RunningShell): Locator {
  return shell.page.getByRole('list', { name: /^(All|Filtered) planned windows$/ }).getByRole('article');
}

function inspection(shell: RunningShell): Locator {
  return shell.page.getByLabel('Selected summary window', { exact: true });
}

async function refresh(shell: RunningShell): Promise<void> {
  await shell.page.getByRole('button', { name: 'Refresh summary runs', exact: true }).click();
  await expect(shell.page.getByRole('status').filter({ hasText: /^Loading summary runs/ })).not.toBeVisible();
}

async function displayedPTS(shell: RunningShell): Promise<string | null> {
  return shell.page.getByText('Displayed source PTS', { exact: true }).evaluate(element => element.nextElementSibling?.textContent ?? null);
}

async function monitor(shell: RunningShell): Promise<void> {
  // Observe real IPC handlers without changing their arguments, scheduling or responses.
  await shell.application.evaluate(({ ipcMain }) => {
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (...args: unknown[]) => Promise<unknown>> })._invokeHandlers;
    const counts = { active: 0, peak: 0, images: 0, previews: 0, collisions: 0, manifests: 0 };
    (globalThis as unknown as { galleryBinary: typeof counts }).galleryBinary = counts;
    for (const channel of ['bat:summary-image', 'bat:preview-content']) {
      const original = handlers.get(channel);
      if (!original) throw new Error('Expected fixed binary IPC handler is absent.');
      handlers.set(channel, async (...args: unknown[]) => {
        counts.active += 1; counts.peak = Math.max(counts.peak, counts.active);
        if (channel === 'bat:summary-image') counts.images += 1; else counts.previews += 1;
        try {
          const response = await original(...args);
          const failure = response as { ok?: boolean; error?: { code?: string } };
          if (!failure.ok && /^(preview_busy|media_busy)$/.test(failure.error?.code ?? '')) counts.collisions += 1;
          return response;
        } finally { counts.active -= 1; }
      });
    }
    const originalManifest = handlers.get('bat:summary-run');
    if (!originalManifest) throw new Error('Expected fixed manifest IPC handler is absent.');
    handlers.set('bat:summary-run', async (...args: unknown[]) => {
      counts.manifests += 1;
      return originalManifest(...args);
    });
  });
  await shell.page.addInitScript(() => {
    const originalCreate = URL.createObjectURL.bind(URL), originalRevoke = URL.revokeObjectURL.bind(URL);
    const active = new Map<string, string>();
    const counts = { peak: 0, created: 0, revoked: 0, active };
    (globalThis as unknown as { galleryBlobs: typeof counts }).galleryBlobs = counts;
    URL.createObjectURL = object => {
      const url = originalCreate(object);
      active.set(url, object instanceof Blob ? object.type : 'other');
      counts.created += 1; counts.peak = Math.max(counts.peak, active.size);
      return url;
    };
    URL.revokeObjectURL = url => {
      if (active.delete(url)) counts.revoked += 1;
      originalRevoke(url);
    };
  });
  await shell.page.reload();
  await expect(shell.page.getByText('Backend ready', { exact: true })).toBeVisible();
}

async function blobCounts(shell: RunningShell): Promise<BlobCounts> {
  return shell.page.evaluate(() => {
    const counts = (globalThis as unknown as { galleryBlobs: { peak: number; created: number; revoked: number; active: Map<string, string> } }).galleryBlobs;
    return { live: counts.active.size, peak: counts.peak, created: counts.created, revoked: counts.revoked,
      imageLive: [...counts.active.values()].filter(type => type === 'image/png').length,
      videoLive: [...counts.active.values()].filter(type => type === 'video/webm').length };
  });
}

async function binaryCounts(shell: RunningShell): Promise<BinaryCounts> {
  return shell.application.evaluate(() => (globalThis as unknown as { galleryBinary: BinaryCounts }).galleryBinary);
}

test.skip(process.platform !== 'linux', 'Gallery media and Electron lifecycle acceptance are locally verified on Linux only.');

test('gallery filters preserve every-window progress and exact displayed source PTS without losing drafts', async () => {
  test.setTimeout(150_000);
  const directory = await mkdtemp(join(tmpdir(), 'bat-gallery-review-'));
  const fixtures = sources(join(directory, 'originals'));
  const originals = [fixtures.vfr_65, fixtures.earlier_9, fixtures.empty_middle, fixtures.brightness_9];
  const originalHashes = await Promise.all(originals.map(async path => createHash('sha256').update(await readFile(path)).digest('hex')));
  let shell: RunningShell | undefined;
  try {
    shell = await launch(join(directory, 'data'));
    const sessionID = await prepared(shell, originals);
    const run = await latest(shell, sessionID);
    expect(run.windows).toHaveLength(8);
    expect(BigInt(run.windows[3]!.stats.first_pts!)).toBeLessThan(BigInt(run.windows[0]!.stats.first_pts!));
    const expectedNames = run.windows.map(row => `Window ${row.index + 1}: ${basename(originals[[run.windows[0]!.segment_id, run.windows[3]!.segment_id, run.windows[4]!.segment_id, run.windows[7]!.segment_id].indexOf(row.segment_id)]!)}`);
    await expect(cards(shell)).toHaveCount(8);
    expect(await cards(shell).evaluateAll(elements => elements.map(element => element.getAttribute('aria-label')))).toEqual(expectedNames);
    await expect(cards(shell).first()).toContainText('[0/1, 30/1)');
    await expect(cards(shell).nth(2)).toContainText('[60/1, 65/1)');
    await expect(cards(shell).first()).toContainText('No motion evidence above threshold.');
    await expect(cards(shell).nth(5)).toContainText('no_decoded_frames');
    expect((await review(shell, run.windows[0]!.id)).revision).toBe(0);

    const selectedHeading = inspection(shell).getByRole('heading', { name: 'Inspect window 1', exact: true });
    await selectedHeading.focus();
    await shell.page.keyboard.press('ArrowRight');
    await expect(inspection(shell).getByRole('heading', { name: 'Inspect window 2', exact: true })).toBeVisible();
    await inspection(shell).getByRole('heading', { name: 'Inspect window 2', exact: true }).focus();
    await shell.page.keyboard.press('ArrowLeft');
    await expect(selectedHeading).toBeVisible();
    await selectedHeading.focus();
    await shell.page.keyboard.press('g');
    await expect(cards(shell).first()).toHaveAttribute('aria-current', 'true');
    await cards(shell).first().getByRole('button', { name: 'Inspect summary', exact: true }).click();

    await shell.page.getByLabel('Reviewer label', { exact: true }).fill('Synthetic gallery reviewer');
    await shell.page.getByRole('button', { name: 'Add provisional observation', exact: true }).click();
    const startInput = shell.page.getByLabel('Observation start source PTS', { exact: true });
    const endInput = shell.page.getByLabel('Observation end source PTS (exclusive)', { exact: true });
    const notes = shell.page.getByLabel('Observation notes', { exact: true });
    await notes.fill('Retain this gallery draft');
    for (const name of ['Next window', 'Next unreviewed window', 'Return to gallery', 'Next gallery page', 'Refresh summary runs', 'Generate motion summaries']) {
      await expect(shell.page.getByRole('button', { name, exact: true })).toBeDisabled();
    }
    await expect(shell.page.getByLabel('Window filter', { exact: true })).toBeDisabled();
    await expect(shell.page.getByLabel('Processing run', { exact: true })).toBeDisabled();
    await expect(cards(shell).last().getByRole('button', { name: 'Inspect summary', exact: true })).toBeDisabled();
    await notes.press('ArrowRight'); await notes.press('u'); await notes.press('g');
    await expect(notes).toHaveValue('Retain this gallery draftug');
    await expect(selectedHeading).toBeVisible();
    await shell.page.getByLabel('Provisional visual category', { exact: true }).focus();
    await shell.page.keyboard.press('ArrowRight'); await shell.page.keyboard.press('u');
    await expect(selectedHeading).toBeVisible();
    await expect(shell.page.getByRole('button', { name: 'Use displayed PTS as start', exact: true })).toBeDisabled();
    await cards(shell).first().getByRole('button', { name: 'Preview window source', exact: true }).click();
    await expect(shell.page.getByLabel('Source PTS', { exact: true })).toHaveValue(run.windows[0]!.preview_pts!);
    await shell.page.getByRole('button', { name: 'Create preview', exact: true }).click();
    await expect(shell.page.getByText('Preview ready', { exact: true })).toBeVisible();
    const useStart = shell.page.getByRole('button', { name: 'Use displayed PTS as start', exact: true });
    const useEnd = shell.page.getByRole('button', { name: 'Use displayed PTS as exclusive end', exact: true });
    await expect(useStart).toBeEnabled();
    const start = await displayedPTS(shell);
    expect(start).toBe(run.windows[0]!.preview_pts);
    await useStart.click();
    await expect(startInput).toHaveValue(start!);
    await shell.page.getByLabel('Derived source preview', { exact: true }).evaluate(element => { (element as HTMLVideoElement).currentTime = 0.24; });
    await expect.poll(() => displayedPTS(shell!)).not.toBe(start);
    await expect(useEnd).toBeEnabled();
    const end = await displayedPTS(shell);
    // The generated source has an explicit frame at 240 ms, independent of nominal FPS.
    const timeBase = run.windows[0]!.time_base;
    const ticks = 240n * BigInt(timeBase.den), divisor = 1000n * BigInt(timeBase.num);
    expect(ticks % divisor).toBe(0n);
    expect(end).toBe(String(BigInt(start!) + ticks / divisor));
    // A paused seek may present its frame callback before seeked. Both directions must
    // restore the exact mapping without a second playback callback or a stale receipt.
    await shell.page.getByLabel('Derived source preview', { exact: true }).evaluate(element => { (element as HTMLVideoElement).currentTime = 0; });
    await expect.poll(() => displayedPTS(shell!)).toBe(start);
    await expect(useStart).toBeEnabled();
    await shell.page.getByLabel('Derived source preview', { exact: true }).evaluate(element => { (element as HTMLVideoElement).currentTime = 0.24; });
    await expect.poll(() => displayedPTS(shell!)).toBe(end);
    await expect(useEnd).toBeEnabled();
    await useEnd.click();
    await expect(endInput).toHaveValue(end!);
    expect((await review(shell, run.windows[0]!.id)).revision).toBe(0);
    expect((await history(shell, run.windows[0]!.id)).events).toEqual([]);
    await shell.page.getByRole('button', { name: 'Save observation', exact: true }).click();
    await expect(shell.page.getByRole('list', { name: 'Saved provisional observations', exact: true })).toContainText('Count unknown');
    await shell.page.getByRole('button', { name: 'Mark reviewed with observations', exact: true }).click();
    await expect(shell.page.getByRole('status').filter({ hasText: /^First review progress: 1\/8 reviewed;/ })).toBeVisible();
    await shell.page.getByRole('button', { name: 'Close preview', exact: true }).click();
    const saved = await review(shell, run.windows[0]!.id);
    expect(saved.observations[0]).toMatchObject({ start_pts: start, end_pts: end, count: null });
    const audit = await history(shell, run.windows[0]!.id);
    expect(audit.events).toHaveLength(2);
    await shell.page.getByRole('button', { name: 'Edit observation', exact: true }).click();
    await expect(shell.page.getByRole('button', { name: 'Use displayed PTS as start', exact: true })).toBeDisabled();
    await expect(shell.page.getByRole('button', { name: 'Use displayed PTS as exclusive end', exact: true })).toBeDisabled();
    await expect(endInput).toHaveValue(end!);
    await shell.page.getByRole('button', { name: 'Discard review draft', exact: true }).click();

    for (const control of [shell.page.getByRole('button', { name: 'Show review audit history', exact: true }), shell.page.getByLabel('Reviewer label', { exact: true })]) {
      await control.focus(); await shell.page.keyboard.press('ArrowRight'); await shell.page.keyboard.press('u');
      await expect(selectedHeading).toBeVisible();
    }
    await expect(shell.page.getByRole('button', { name: 'Return to gallery', exact: true })).toBeDisabled();
    await shell.page.getByRole('button', { name: 'Discard review draft', exact: true }).click();
    await expect(shell.page.getByLabel('Reviewer label', { exact: true })).toHaveValue('Synthetic gallery reviewer');
    await shell.page.getByRole('button', { name: 'Show review audit history', exact: true }).click();
    const auditDisclosure = inspection(shell).locator('.review-history summary').first();
    await expect(auditDisclosure).toBeVisible();
    await auditDisclosure.focus();
    await shell.page.keyboard.press('ArrowRight'); await shell.page.keyboard.press('u');
    await expect(selectedHeading).toBeVisible();
    for (const key of ['Shift+ArrowRight', 'Control+ArrowRight', 'Alt+ArrowRight', 'Meta+ArrowRight']) {
      await selectedHeading.focus(); await shell.page.keyboard.press(key); await expect(selectedHeading).toBeVisible();
    }
    await selectedHeading.evaluate(element => {
      element.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, repeat: true }));
      element.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, isComposing: true }));
      const editable = document.createElement('div'); editable.contentEditable = 'true'; element.parentElement!.append(editable);
      editable.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })); editable.remove();
    });
    await expect(selectedHeading).toBeVisible();
    expect((await history(shell, run.windows[0]!.id)).events).toEqual(audit.events);
    await selectedHeading.focus(); await shell.page.keyboard.press('u');
    await expect(inspection(shell).getByRole('heading', { name: 'Inspect window 2', exact: true })).toBeVisible();
    await shell.page.getByRole('button', { name: 'Previous window', exact: true }).click();
    await expect(selectedHeading).toBeVisible();

    const filter = shell.page.getByLabel('Window filter', { exact: true });
    const checks = [
      ['All windows', 8], ['Unreviewed', 7], ['Reviewed', 1], ['Contains observations', 1],
      ['Quality flagged', run.windows.filter(row => row.flags.length > 0).length], ['Failed/incomplete', 1], ['Requires re-verification', 0],
    ] as const;
    for (const [name, count] of checks) {
      await filter.selectOption({ label: name });
      await expect(cards(shell)).toHaveCount(count);
      await expect(shell.page.getByRole('status').filter({ hasText: /^First review progress: 1\/8 reviewed;/ })).toBeVisible();
    }
    await filter.selectOption({ label: 'All windows' });
    expect(await Promise.all(originals.map(async path => createHash('sha256').update(await readFile(path)).digest('hex')))).toEqual(originalHashes);
    await appendFile(fixtures.vfr_65, 'Synthetic changed source');
    await refresh(shell);
    await filter.selectOption({ label: 'Requires re-verification' });
    await expect(cards(shell)).toHaveCount(1);
    await expect(cards(shell).first()).toContainText('changed_source');
    await expect(shell.page.getByRole('status').filter({ hasText: /^First review progress: 0\/8 reviewed;/ })).toBeVisible();
    expect((await history(shell, run.windows[0]!.id)).events).toEqual(audit.events);
    await rename(fixtures.earlier_9, `${fixtures.earlier_9}.missing`);
    await refresh(shell);
    await filter.selectOption({ label: 'All windows' });
    await expect(cards(shell).nth(3)).toContainText('missing_source');
    await expect(cards(shell).nth(3).getByRole('button', { name: 'Preview window source', exact: true })).toBeDisabled();
    await expect(cards(shell)).toHaveCount(8);
    await expect(shell.page.locator('body')).not.toContainText(directory);
    await quit(shell); shell = undefined;
  } finally {
    await cleanupDraft(shell);
    await rm(directory, { recursive: true, force: true });
  }
});

test('240 real thirty-second windows keep image requests and Blob lifetimes bounded across gallery pages', async () => {
  test.setTimeout(180_000);
  const directory = await mkdtemp(join(tmpdir(), 'bat-gallery-scale-'));
  const fixtures = sources(join(directory, 'originals'));
  let shell: RunningShell | undefined;
  try {
    shell = await launch(join(directory, 'data'));
    await monitor(shell);
    const sessionID = await prepared(shell, [fixtures.quiet_240]);
    const run = await latest(shell, sessionID);
    expect(run.counts).toMatchObject({ planned: 240, complete: 240, failed: 0, incomplete: 0 });
    expect(run.windows.at(-1)!.interval.elapsed_end).toEqual({ num: '7200', den: '1' });
    await expect(cards(shell)).toHaveCount(12);
    await expect(shell.page.getByRole('status').filter({ hasText: /^First review progress: 0\/240 reviewed;/ })).toBeVisible();
    await cards(shell).first().scrollIntoViewIfNeeded();
    await expect(cards(shell).first().getByRole('img', { name: 'Summary thumbnail for window 1', exact: true })).toBeVisible();
    expect((await binaryCounts(shell)).images).toBeLessThanOrEqual(13);
    const manifestsBeforePages = (await binaryCounts(shell)).manifests;
    const pageStarted = Date.now();
    const next = shell.page.getByRole('button', { name: 'Next gallery page', exact: true });
    await expect(next).toBeEnabled();
    await shell.page.getByLabel('Reviewer label', { exact: true }).fill('Unsaved scale reviewer');
    await expect(next).toBeDisabled();
    await expect(shell.page.getByLabel('Window filter', { exact: true })).toBeDisabled();
    const firstHeading = inspection(shell).getByRole('heading', { name: 'Inspect window 1', exact: true });
    await firstHeading.focus(); await shell.page.keyboard.press('ArrowRight');
    await expect(firstHeading).toBeVisible();
    await expect(shell.page.getByLabel('Reviewer label', { exact: true })).toHaveValue('Unsaved scale reviewer');
    await shell.page.getByRole('button', { name: 'Discard review draft', exact: true }).click();
    await expect(shell.page.getByLabel('Reviewer label', { exact: true })).toHaveValue('');
    expect((await history(shell, run.windows[0]!.id)).events).toEqual([]);
    await expect(next).toBeEnabled();
    for (let page = 2; page <= 20; page += 1) {
      await next.click();
      await expect(cards(shell)).toHaveCount(12);
      await expect(cards(shell).first()).toHaveAttribute('aria-label', `Window ${(page - 1) * 12 + 1}: ${basename(fixtures.quiet_240)}`);
      await cards(shell).first().scrollIntoViewIfNeeded();
      await expect(cards(shell).first().getByRole('img')).toBeVisible();
      expect((await blobCounts(shell)).live).toBeLessThanOrEqual(13);
    }
    await expect(next).toBeDisabled();
    expect((await binaryCounts(shell)).manifests - manifestsBeforePages).toBeLessThanOrEqual(Math.ceil((Date.now() - pageStarted) / 30000));
    await expect(cards(shell).last()).toContainText('[7170/1, 7200/1)');
    await shell.page.getByRole('button', { name: 'Previous gallery page', exact: true }).click();
    await expect(cards(shell).first()).toHaveAttribute('aria-label', `Window 217: ${basename(fixtures.quiet_240)}`);
    await cards(shell).first().getByRole('button', { name: 'Inspect summary', exact: true }).click();
    await cards(shell).first().getByRole('button', { name: 'Preview window source', exact: true }).click();
    await expect(shell.page.getByLabel('Source PTS', { exact: true })).toHaveValue(run.windows[216]!.preview_pts!);
    await shell.page.getByRole('button', { name: 'Create preview', exact: true }).click();
    await expect(shell.page.getByRole('alert').filter({ hasText: /This preview exceeds the time, frame, memory, dimensions or byte limit/ })).toBeVisible();
    await shell.page.getByRole('button', { name: 'Close preview', exact: true }).click();
    // The intentionally sparse scale source has 30-second keyframe spacing.
    // Its interior seeks can correctly hit the existing pre-roll limit. Reset
    // the page through a real filter and preview its first frame instead.
    await shell.page.getByLabel('Window filter', { exact: true }).selectOption({ label: 'Unreviewed' });
    await expect(cards(shell).first()).toHaveAttribute('aria-label', `Window 1: ${basename(fixtures.quiet_240)}`);
    await cards(shell).first().getByRole('button', { name: 'Inspect summary', exact: true }).click();
    await cards(shell).first().getByRole('button', { name: 'Preview window source', exact: true }).click();
    await expect(shell.page.getByLabel('Source PTS', { exact: true })).toHaveValue(run.windows[0]!.preview_pts!);
    await shell.page.getByRole('button', { name: 'Create preview', exact: true }).click();
    await expect(shell.page.getByText('Preview ready', { exact: true })).toBeVisible();
    expect(await blobCounts(shell)).toMatchObject({ videoLive: 1 });
    expect((await blobCounts(shell)).peak).toBeLessThanOrEqual(14);
    expect(await binaryCounts(shell)).toMatchObject({ active: 0, peak: 1, previews: 1, collisions: 0 });
    await shell.page.getByRole('button', { name: 'Close preview', exact: true }).click();
    await expect.poll(async () => (await blobCounts(shell!)).videoLive).toBe(0);
    await shell.page.getByRole('button', { name: 'Return to gallery', exact: true }).click();
    // Changing sessions unmounts the entire review surface and must release every URL.
    await shell.page.getByLabel('Display name', { exact: true }).fill('Synthetic empty gallery destination');
    await shell.page.getByRole('button', { name: 'Create session', exact: true }).click();
    const destination = shell.page.getByRole('row').filter({ hasText: 'Synthetic empty gallery destination' });
    await expect(destination).toBeVisible();
    await destination.getByRole('button', { name: 'Inspect media', exact: true }).click();
    await expect(shell.page.getByText('No summary runs saved.', { exact: true })).toBeVisible();
    await expect.poll(async () => (await blobCounts(shell!)).live).toBe(0);
    const blobs = await blobCounts(shell);
    expect(blobs.created).toBeGreaterThan(20);
    expect(blobs.revoked).toBe(blobs.created);
    expect((await binaryCounts(shell)).collisions).toBe(0);
    console.info('Real gallery scale evidence:', { windows: 240, seconds: 7200, pages: 20,
      peakBinaryReads: (await binaryCounts(shell)).peak, peakBlobURLs: blobs.peak,
      createdBlobURLs: blobs.created, revokedBlobURLs: blobs.revoked, liveBlobURLsAfterUnmount: blobs.live });
    await quit(shell); shell = undefined;
  } finally {
    await cleanupDraft(shell);
    await rm(directory, { recursive: true, force: true });
  }
});

test('a real processing write failure stays visible and unresolved in the gallery', async () => {
  test.setTimeout(90_000);
  const directory = await mkdtemp(join(tmpdir(), 'bat-gallery-failure-'));
  const fixtures = sources(join(directory, 'originals'));
  let shell: RunningShell | undefined;
  try {
    shell = await launch(join(directory, 'data'));
    const sessionID = await prepared(shell, [fixtures.earlier_9]);
    const before = await latest(shell, sessionID);
    // Negative-only fault injection: a real SQLite error prevents image publication.
    // All successful processing, decoding, API responses and DB writes remain real.
    const injected = spawnSync(process.env.BAT_PYTHON ?? 'python', ['-c',
      'import sqlite3,sys\nwith sqlite3.connect(sys.argv[1]) as db:\n db.execute("CREATE TRIGGER gallery_write_failure BEFORE UPDATE OF status ON summary_window WHEN NEW.status=\'complete\' BEGIN SELECT RAISE(ABORT,\'synthetic disk commit failure\'); END")',
      join(directory, 'data', 'bat_innovation.sqlite3'),
    ], { encoding: 'utf8' });
    expect(injected.status, injected.stderr).toBe(0);
    await shell.page.getByRole('button', { name: 'Generate motion summaries', exact: true }).click();
    await expect(shell.page.getByRole('status').filter({ hasText: /^Run failed: 0\/1 windows complete; 1 failed;/ })).toBeVisible();
    await shell.page.getByLabel('Window filter', { exact: true }).selectOption({ label: 'Failed/incomplete' });
    await expect(cards(shell)).toHaveCount(1);
    await expect(cards(shell).first()).toContainText('failed');
    await expect(shell.page.getByRole('status').filter({ hasText: /^First review progress: 0\/1 reviewed;/ })).toBeVisible();
    const failed = await latest(shell, sessionID);
    expect(failed.windows[0]!.status).toBe('failed');
    expect(failed.windows[0]!.image).toBeNull();
    expect((await history(shell, failed.windows[0]!.id)).events).toEqual([]);
    expect((await review(shell, before.windows[0]!.id)).revision).toBe(0);
    const removed = spawnSync(process.env.BAT_PYTHON ?? 'python', ['-c',
      'import sqlite3,sys\nwith sqlite3.connect(sys.argv[1]) as db:\n db.execute("DROP TRIGGER gallery_write_failure")',
      join(directory, 'data', 'bat_innovation.sqlite3'),
    ], { encoding: 'utf8' });
    expect(removed.status, removed.stderr).toBe(0);
    await shell.page.getByRole('button', { name: 'Generate motion summaries', exact: true }).click();
    await expect(shell.page.getByRole('status').filter({ hasText: /^Run complete: 1\/1 windows complete;/ })).toBeVisible();
    expect((await history(shell, failed.windows[0]!.id)).events).toEqual([]);
    await quit(shell); shell = undefined;
  } finally {
    await cleanupDraft(shell);
    await rm(directory, { recursive: true, force: true });
  }
});
