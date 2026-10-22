import { spawnSync } from 'node:child_process';
import { appendFile, mkdtemp, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { expect, test, type Locator } from '@playwright/test';
import type { BatAPI, ReviewHistory } from '../src/contracts';
import { launch, quit, type RunningShell } from './shell-helpers';
import { cleanupDraftShell, closeWindow, digests, displayedPTS, expand, fixtures, goTo, latestRun, openAt, preparedReview, previewReady,
  reviewProgress, savedReview as review, windowCards as cards } from './ui-helpers';

type Fixture = 'quiet_240' | 'vfr_65' | 'earlier_9' | 'empty_middle' | 'brightness_9';
type BlobCounts = { live: number; peak: number; created: number; revoked: number; imageLive: number; videoLive: number };
type BinaryCounts = { active: number; peak: number; images: number; previews: number; collisions: number; manifests: number };
const SURVEY = 'Synthetic gallery survey';
const PAGE = 24;

async function history(shell: RunningShell, windowID: string): Promise<ReviewHistory> {
  const result = await shell.page.evaluate(id => (window as unknown as { batAPI: BatAPI }).batAPI.reviewHistory(id, 0), windowID);
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

/** Whole-second clock text as the UI shows it (m:ss, or h:mm:ss from one hour). */
function clock(total: number): string {
  const hours = Math.floor(total / 3600), minutes = Math.floor((total % 3600) / 60), secs = total % 60;
  return `${hours ? `${hours}:${String(minutes).padStart(2, '0')}` : minutes}:${String(secs).padStart(2, '0')}`;
}

function filter(shell: RunningShell, label: string): Locator {
  return shell.page.getByRole('toolbar', { name: 'Window filter', exact: true }).getByRole('button', { name: new RegExp(`^${label} \\d+$`) });
}

async function filterCount(shell: RunningShell, label: string): Promise<number> {
  return Number(/(\d+)$/.exec((await filter(shell, label).textContent()) ?? '')?.[1]);
}

async function refresh(shell: RunningShell): Promise<void> {
  await shell.page.getByRole('button', { name: 'Refresh', exact: true }).click();
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
  const sources = fixtures<Fixture>('gallery_fixtures', join(directory, 'originals'));
  const originals = [sources.vfr_65, sources.earlier_9, sources.empty_middle, sources.brightness_9];
  const originalHashes = await digests(originals);
  let shell: RunningShell | undefined;
  try {
    shell = await launch(join(directory, 'data'));
    const sessionID = await preparedReview(shell, originals, SURVEY);
    const run = await latestRun(shell, sessionID);
    expect(run.windows).toHaveLength(8);
    expect(BigInt(run.windows[3]!.stats.first_pts!)).toBeLessThan(BigInt(run.windows[0]!.stats.first_pts!));
    // Every window stays in run order, each named by its own original file.
    const segments = [run.windows[0]!.segment_id, run.windows[3]!.segment_id, run.windows[4]!.segment_id, run.windows[7]!.segment_id];
    const files = run.windows.map(row => basename(originals[segments.indexOf(row.segment_id)]!));
    await expect(cards(shell)).toHaveCount(8);
    const labels = await cards(shell).evaluateAll(elements => elements.map(element => element.getAttribute('aria-label') ?? ''));
    expect(labels.map(label => label.replace(/^Window .* of /, ''))).toEqual(files);
    expect(labels[0]).toBe(`Window 0:00 - 0:30 of ${files[0]}`);
    expect(labels[2]).toBe(`Window 1:00 - 1:05 of ${files[2]}`);
    await expect(cards(shell).nth(5)).toContainText(/incomplete: no decoded frames/);
    expect((await review(shell, run.windows[0]!.id)).revision).toBe(0);

    const view = await openAt(shell, 0);
    await expect(view.getByText('No motion evidence above threshold.', { exact: true })).toBeVisible();
    // Arrow keys move between windows unless focus is in a form control, disclosure or editable element.
    const close = view.getByRole('button', { name: 'Close window', exact: true });
    await close.focus(); await shell.page.keyboard.press('ArrowRight');
    await expect(view.getByText('2 of 8', { exact: true })).toBeVisible();
    await close.focus(); await shell.page.keyboard.press('ArrowLeft');
    await expect(view.getByText('1 of 8', { exact: true })).toBeVisible();

    await view.getByLabel('Reviewer', { exact: true }).fill('Synthetic gallery reviewer');
    await view.getByRole('button', { name: /^Add observation/ }).click();
    await expand(view, 'Exact source PTS');
    const startInput = view.getByLabel('Observation start source PTS', { exact: true });
    const endInput = view.getByLabel('Observation end source PTS (exclusive)', { exact: true });
    const notes = view.getByLabel('Notes', { exact: true });
    await notes.fill('Retain this gallery draft');
    await notes.press('ArrowRight'); await notes.press('u'); await notes.press('g');
    await expect(notes).toHaveValue('Retain this gallery draftug');
    await view.getByLabel('What moved', { exact: true }).focus();
    await shell.page.keyboard.press('ArrowRight'); await shell.page.keyboard.press('u');
    await expect(view.getByText('1 of 8', { exact: true })).toBeVisible();
    // With a draft open, window navigation is refused and the draft stays.
    await close.focus(); await shell.page.keyboard.press('ArrowRight');
    await expect(view.getByRole('alert').filter({ hasText: 'Save or discard your changes before moving to another window.' })).toBeVisible();
    await expect(view.getByText('1 of 8', { exact: true })).toBeVisible();
    await expect(notes).toHaveValue('Retain this gallery draftug');

    await previewReady(view);
    const useStart = view.getByRole('button', { name: 'Use current frame as start', exact: true });
    const useEnd = view.getByRole('button', { name: 'Use current frame as end', exact: true });
    await expect(useStart).toBeEnabled();
    const start = await displayedPTS(view);
    expect(start).toBe(run.windows[0]!.preview_pts);
    await useStart.click();
    await expect(startInput).toHaveValue(start!);
    const video = view.getByLabel('Derived source preview', { exact: true });
    await video.evaluate(element => { (element as HTMLVideoElement).currentTime = 0.24; });
    await expect.poll(() => displayedPTS(view)).not.toBe(start);
    await expect(useEnd).toBeEnabled();
    const end = await displayedPTS(view);
    // The generated source has an explicit frame at 240 ms, independent of nominal FPS.
    const timeBase = run.windows[0]!.time_base;
    const ticks = 240n * BigInt(timeBase.den), divisor = 1000n * BigInt(timeBase.num);
    expect(ticks % divisor).toBe(0n);
    expect(end).toBe(String(BigInt(start!) + ticks / divisor));
    // A paused seek may present its frame callback before seeked. Both directions must
    // restore the exact mapping without a second playback callback or a stale receipt.
    await video.evaluate(element => { (element as HTMLVideoElement).currentTime = 0; });
    await expect.poll(() => displayedPTS(view)).toBe(start);
    await expect(useStart).toBeEnabled();
    await video.evaluate(element => { (element as HTMLVideoElement).currentTime = 0.24; });
    await expect.poll(() => displayedPTS(view)).toBe(end);
    await useEnd.click();
    await expect(endInput).toHaveValue(end!);
    expect((await review(shell, run.windows[0]!.id)).revision).toBe(0);
    expect((await history(shell, run.windows[0]!.id)).events).toEqual([]);
    await view.getByRole('button', { name: 'Save observation', exact: true }).click();
    await expect(view.getByRole('list', { name: 'Saved provisional observations', exact: true })).toContainText('Count unknown');
    await view.getByRole('button', { name: 'Mark reviewed with observations', exact: true }).click();
    await expect.poll(async () => (await review(shell!, run.windows[0]!.id)).decision).toBe('reviewed_with_observations');
    const saved = await review(shell, run.windows[0]!.id);
    expect(saved.observations[0]).toMatchObject({ start_pts: start, end_pts: end, count: null });
    const audit = await history(shell, run.windows[0]!.id);
    expect(audit.events).toHaveLength(2);
    await view.getByRole('button', { name: 'Edit observation', exact: true }).click();
    await expand(view, 'Exact source PTS');
    await expect(endInput).toHaveValue(end!);
    await view.getByRole('button', { name: 'Cancel', exact: true }).click();

    // Disclosures, modified keys, repeats, composition and editable elements never navigate.
    await expand(view, 'Unable to assess, undo, history');
    for (const control of [view.getByLabel('Reviewer', { exact: true }),
      view.locator('summary', { hasText: 'Unable to assess, undo, history' })]) {
      await control.focus(); await shell.page.keyboard.press('ArrowRight'); await shell.page.keyboard.press('u');
      await expect(view.getByText('1 of 8', { exact: true })).toBeVisible();
    }
    for (const key of ['Shift+ArrowRight', 'Control+ArrowRight', 'Alt+ArrowRight', 'Meta+ArrowRight']) {
      await close.focus(); await shell.page.keyboard.press(key); await expect(view.getByText('1 of 8', { exact: true })).toBeVisible();
    }
    await close.evaluate(element => {
      element.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, repeat: true }));
      const editable = document.createElement('div'); editable.contentEditable = 'true'; element.parentElement!.append(editable);
      editable.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })); editable.remove();
    });
    await expect(view.getByText('1 of 8', { exact: true })).toBeVisible();
    expect((await history(shell, run.windows[0]!.id)).events).toEqual(audit.events);
    await close.focus(); await shell.page.keyboard.press('u');
    await expect(view.getByText('2 of 8', { exact: true })).toBeVisible();
    await closeWindow(view);
    await expect(reviewProgress(shell, 1, 8)).toBeVisible();

    const checks = [['All', 8], ['Not reviewed', 7], ['With observations', 1], ['No activity', 0], ['Failed or incomplete', 1], ['Needs re-check', 0]] as const;
    for (const [name, count] of checks) {
      await filter(shell, name).click();
      await expect(filter(shell, name)).toHaveAttribute('aria-pressed', 'true');
      if (count === 0) await expect(shell.page.getByText('No windows match this filter.', { exact: true })).toBeVisible();
      else await expect(cards(shell)).toHaveCount(count);
      await expect(reviewProgress(shell, 1, 8), 'Filters never change coverage').toBeVisible();
    }
    const flagged = await filterCount(shell, 'Flagged');
    expect(flagged).toBeGreaterThan(0);
    await filter(shell, 'Flagged').click();
    await expect(cards(shell)).toHaveCount(flagged);
    await filter(shell, 'All').click();
    expect(await digests(originals)).toEqual(originalHashes);

    await appendFile(sources.vfr_65, 'Synthetic changed source');
    await refresh(shell);
    await expect(reviewProgress(shell, 0, 8)).toBeVisible();
    await filter(shell, 'Needs re-check').click();
    await expect(cards(shell)).toHaveCount(1);
    await expect(cards(shell).first()).toContainText('changed source');
    expect((await history(shell, run.windows[0]!.id)).events).toEqual(audit.events);
    await rename(sources.earlier_9, `${sources.earlier_9}.missing`);
    await refresh(shell);
    await filter(shell, 'All').click();
    await expect(cards(shell)).toHaveCount(8);
    await expect(cards(shell).nth(3)).toContainText('missing source');
    const missing = await openAt(shell, 3);
    await expect(missing.getByText('The original video is missing or changed.', { exact: true })).toBeVisible();
    await expect(missing.getByLabel('Derived source preview', { exact: true })).toHaveCount(0);
    await closeWindow(missing);
    await expect(shell.page.locator('body')).not.toContainText(directory);
    await quit(shell); shell = undefined;
  } finally {
    await cleanupDraftShell(shell);
    await rm(directory, { recursive: true, force: true });
  }
});

test('240 real thirty-second windows keep image requests and Blob lifetimes bounded across gallery pages', async () => {
  test.setTimeout(180_000);
  const directory = await mkdtemp(join(tmpdir(), 'bat-gallery-scale-'));
  const sources = fixtures<Fixture>('gallery_fixtures', join(directory, 'originals'));
  const name = basename(sources.quiet_240);
  const label = (index: number) => `Window ${clock(index * 30)} - ${clock(index * 30 + 30)} of ${name}`;
  let shell: RunningShell | undefined;
  try {
    shell = await launch(join(directory, 'data'));
    await monitor(shell);
    const sessionID = await preparedReview(shell, [sources.quiet_240], SURVEY);
    await expect(shell.page.getByText(/^Second review: 0 agreed, .* 240 pending \(of 240\)\.$/)).toBeVisible();
    const run = await latestRun(shell, sessionID);
    expect(run.counts).toMatchObject({ planned: 240, complete: 240, failed: 0, incomplete: 0 });
    expect(run.windows.at(-1)!.interval.elapsed_end).toEqual({ num: '7200', den: '1' });
    await expect(cards(shell)).toHaveCount(PAGE);
    await expect(reviewProgress(shell, 0, 240)).toBeVisible();
    await cards(shell).first().scrollIntoViewIfNeeded();
    await expect(cards(shell).first().getByRole('img', { name: `Motion summary, ${label(0)}`, exact: true })).toBeVisible();
    // The Process page shows at most 12 thumbnails and the gallery at most one page; nothing else is read.
    expect((await binaryCounts(shell)).images).toBeLessThanOrEqual(12 + PAGE);
    expect((await blobCounts(shell)).live).toBeLessThanOrEqual(PAGE);

    // A draft in the window dialog blocks navigation and leaves no audit record when cancelled.
    const view = await openAt(shell, 0);
    await view.getByRole('button', { name: /^Add observation/ }).click();
    const close = view.getByRole('button', { name: 'Close window', exact: true });
    await close.focus(); await shell.page.keyboard.press('ArrowRight');
    await expect(view.getByText('1 of 240', { exact: true })).toBeVisible();
    await view.getByRole('button', { name: 'Cancel', exact: true }).click();
    await closeWindow(view);
    expect((await history(shell, run.windows[0]!.id)).events).toEqual([]);

    const manifestsBeforePages = (await binaryCounts(shell)).manifests;
    const pageStarted = Date.now();
    const next = shell.page.getByRole('button', { name: 'Next page', exact: true });
    const pages = 240 / PAGE;
    for (let page = 2; page <= pages; page += 1) {
      await next.click();
      await expect(shell.page.getByText(`Page ${page} of ${pages}`, { exact: true })).toBeVisible();
      await expect(cards(shell)).toHaveCount(PAGE);
      await expect(cards(shell).first()).toHaveAttribute('aria-label', label((page - 1) * PAGE));
      await cards(shell).first().scrollIntoViewIfNeeded();
      await expect(cards(shell).first().getByRole('img')).toBeVisible();
      expect((await blobCounts(shell)).live).toBeLessThanOrEqual(PAGE);
    }
    await expect(next).toBeDisabled();
    expect((await binaryCounts(shell)).manifests - manifestsBeforePages).toBeLessThanOrEqual(Math.ceil((Date.now() - pageStarted) / 30000));
    await expect(cards(shell).last()).toHaveAttribute('aria-label', label(239));
    await expect(cards(shell).last()).toContainText('1:59:30 - 2:00:00');

    // The intentionally sparse scale source has 30-second keyframe spacing, so this interior
    // preview correctly hits the pre-roll limit and says so.
    const interior = await openAt(shell, 0);
    await expect(interior.getByText(`217 of 240`, { exact: true })).toBeVisible();
    await expect(interior.getByRole('alert').filter({ hasText: /This preview exceeds the time, frame, memory, dimensions or byte limit/ })).toBeVisible({ timeout: 30_000 });
    await closeWindow(interior);
    await filter(shell, 'Not reviewed').click();
    await expect(cards(shell).first()).toHaveAttribute('aria-label', label(0));
    const first = await openAt(shell, 0);
    await previewReady(first);
    expect(await blobCounts(shell)).toMatchObject({ videoLive: 1 });
    expect((await blobCounts(shell)).peak).toBeLessThanOrEqual(PAGE + 2);
    expect(await binaryCounts(shell)).toMatchObject({ active: 0, peak: 1, previews: 1, collisions: 0 });
    await closeWindow(first);
    await expect.poll(async () => (await blobCounts(shell!)).videoLive).toBe(0);
    // Leaving the survey unmounts the whole review surface and must release every URL.
    await shell.page.getByRole('link', { name: 'Back to surveys' }).click();
    await expect(shell.page.getByRole('heading', { name: 'Surveys', exact: true })).toBeVisible();
    await expect.poll(async () => (await blobCounts(shell!)).live).toBe(0);
    const blobs = await blobCounts(shell);
    expect(blobs.created).toBeGreaterThan(20);
    expect(blobs.revoked).toBe(blobs.created);
    expect((await binaryCounts(shell)).collisions).toBe(0);
    console.info('Real gallery scale evidence:', { windows: 240, seconds: 7200, pages,
      peakBinaryReads: (await binaryCounts(shell)).peak, peakBlobURLs: blobs.peak,
      createdBlobURLs: blobs.created, revokedBlobURLs: blobs.revoked, liveBlobURLsAfterUnmount: blobs.live });
    await quit(shell); shell = undefined;
  } finally {
    await cleanupDraftShell(shell);
    await rm(directory, { recursive: true, force: true });
  }
});

test('a real processing write failure stays visible and unresolved in the gallery', async () => {
  test.setTimeout(90_000);
  const directory = await mkdtemp(join(tmpdir(), 'bat-gallery-failure-'));
  const sources = fixtures<Fixture>('gallery_fixtures', join(directory, 'originals'));
  let shell: RunningShell | undefined;
  try {
    shell = await launch(join(directory, 'data'));
    const sessionID = await preparedReview(shell, [sources.earlier_9], SURVEY);
    const before = await latestRun(shell, sessionID);
    // Negative-only fault injection: a real SQLite error prevents image publication.
    // All successful processing, decoding, API responses and DB writes remain real.
    const injected = spawnSync(process.env.BAT_PYTHON ?? 'python', ['-c',
      'import sqlite3,sys\nwith sqlite3.connect(sys.argv[1]) as db:\n db.execute("CREATE TRIGGER gallery_write_failure BEFORE UPDATE OF status ON summary_window WHEN NEW.status=\'complete\' BEGIN SELECT RAISE(ABORT,\'synthetic disk commit failure\'); END")',
      join(directory, 'data', 'bat_innovation.sqlite3'),
    ], { encoding: 'utf8' });
    expect(injected.status, injected.stderr).toBe(0);
    await goTo(shell, 'Process');
    const status = shell.page.getByRole('status').filter({ hasText: /^Run / });
    await shell.page.getByRole('button', { name: 'Generate motion summaries', exact: true }).click();
    await expect(status).toHaveText(/^Run failed: 0 of 1 windows complete$/, { timeout: 60_000 });
    await expect(shell.page.getByText('1 failed', { exact: true })).toBeVisible();
    await goTo(shell, 'Review');
    await filter(shell, 'Failed or incomplete').click();
    await expect(cards(shell)).toHaveCount(1);
    await expect(cards(shell).first()).toContainText('failed');
    await expect(reviewProgress(shell, 0, 1)).toBeVisible();
    const failed = await latestRun(shell, sessionID);
    expect(failed.windows[0]!.status).toBe('failed');
    expect(failed.windows[0]!.image).toBeNull();
    expect((await history(shell, failed.windows[0]!.id)).events).toEqual([]);
    expect((await review(shell, before.windows[0]!.id)).revision).toBe(0);
    const removed = spawnSync(process.env.BAT_PYTHON ?? 'python', ['-c',
      'import sqlite3,sys\nwith sqlite3.connect(sys.argv[1]) as db:\n db.execute("DROP TRIGGER gallery_write_failure")',
      join(directory, 'data', 'bat_innovation.sqlite3'),
    ], { encoding: 'utf8' });
    expect(removed.status, removed.stderr).toBe(0);
    await goTo(shell, 'Process');
    await shell.page.getByRole('button', { name: 'Generate motion summaries', exact: true }).click();
    await expect(status).toHaveText(/^Run complete: 1 of 1 windows complete$/, { timeout: 60_000 });
    expect((await history(shell, failed.windows[0]!.id)).events).toEqual([]);
    await quit(shell); shell = undefined;
  } finally {
    await cleanupDraftShell(shell);
    await rm(directory, { recursive: true, force: true });
  }
});
