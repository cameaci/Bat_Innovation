import type { ClockAnchor, GateCounts, MediaSegment, ReviewProgress, SampleCheck, TrackingRun, TrackLabels } from '../../../electron/src/contracts';

/** Everything the evidence report shows; gathered by the Export page, turned into one static HTML page here. */
export interface ReportData {
  generatedUTC: string;
  session: { display_name: string; camera_ref: string };
  segments: MediaSegment[];
  anchor: ClockAnchor | null;
  review: ReviewProgress | null;
  windows: number;
  tracking: TrackingRun;
  counts: GateCounts[];
  sampleChecks: Record<string, SampleCheck[]>;
  labels: TrackLabels | null;
  /** All non-noise tracks per video as [x, y] points (within the display budget: shown of total). */
  tracks: { segmentID: string; shown: number; total: number; paths: { index: number; uncertain: boolean; points: [number, number][] }[] }[];
}

export const REPORT_SECTIONS = ['Survey and videos', 'Gates', 'Counts per gate and layer', 'Emergence profile and flow', 'Sample checks',
  'Review coverage', 'Tracks and labels', 'Settings and versions', 'Limitations'] as const;

export const LIMITATIONS = [
  'This report is provisional. It is not an ecologically finalised report, and nothing in it is an ecological conclusion.',
  'Tracks, crossings and counts are candidate evidence produced by an algorithm for human review. A track is not an animal, and counts are not final counts.',
  'The algorithm, reviewer and QA count layers are kept separate. A reviewer name is a local audit label, not a verified identity.',
  'A video window without tracks is not proof that no bats were present. Every recorded window stays accessible and the original video is the evidence.',
  'Counts are per camera. Animals are not matched across cameras, and emergence is not inferred from a motion trail alone.',
  'Species entries are typed by a person and are never inferred. The sunset time is typed with its source and is not computed.',
  'Final ecological classifications and survey conclusions belong to appropriately authorised reviewers.',
];

const COLOURS = ['#E69F00', '#56B4E9', '#009E73', '#D55E00', '#CC79A7', '#0072B2', '#999999'];

export function escape(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
}

const seconds = (value: { num: string; den: string } | null | undefined) => value ? Number(value.num) / Number(value.den) : null;
const minutes = (value: number | null) => value === null ? 'unknown' : `${Math.floor(value / 60)}:${String(Math.round(value % 60)).padStart(2, '0')}`;
const table = (head: string[], rows: unknown[][]) => `<table><thead><tr>${head.map(cell => `<th>${escape(cell)}</th>`).join('')}</tr></thead><tbody>${
  rows.map(row => `<tr>${row.map(cell => `<td>${escape(cell)}</td>`).join('')}</tr>`).join('') || `<tr><td colspan="${head.length}">None</td></tr>`}</tbody></table>`;

function gateSVG(counts: GateCounts): string {
  const { frame_w: width, frame_h: height, points, kind } = counts.gate;
  const shape = points.map(([x, y]) => `${x},${y}`).join(' ');
  return `<svg class="figure small" viewBox="0 0 ${width} ${height}" role="img" aria-label="Gate ${escape(counts.gate.name)}"><rect width="${width}" height="${height}" fill="#1e293b"/>${
    kind === 'line' ? `<polyline points="${shape}" fill="none" stroke="#facc15" stroke-width="${Math.max(2, width / 200)}"/>` : `<polygon points="${shape}" fill="#facc1533" stroke="#facc15" stroke-width="${Math.max(2, width / 200)}"/>`}</svg>`;
}

function profileSVG(counts: GateCounts, segments: MediaSegment[]): string {
  const layer = counts.profile.layers.reviewer;
  const columns: { exited: number; entered: number; video: number }[] = [];
  segments.forEach((segment, video) => {
    const length = Math.max(1, Math.ceil((seconds(segment.metadata.elapsed_end) ?? seconds(segment.metadata.elapsed_last_time) ?? 0) / 60),
      ...layer.bins.filter(bin => bin.segment_id === segment.id).map(bin => bin.minute + 1));
    for (let minute = 0; minute < length; minute += 1) {
      const bin = layer.bins.find(item => item.segment_id === segment.id && item.minute === minute);
      columns.push({ exited: bin?.exited ?? 0, entered: bin?.entered ?? 0, video });
    }
  });
  const peak = Math.max(1, ...columns.map(column => Math.max(column.exited, column.entered)));
  const step = 600 / Math.max(1, columns.length), bar = Math.min(step * 0.8, 20);
  return `<svg class="figure" viewBox="0 0 600 160" role="img" aria-label="Emergence profile of ${escape(counts.gate.name)}"><line x1="0" x2="600" y1="90" y2="90" stroke="#94a3b8"/>${
    columns.map((column, index) => `${column.exited ? `<rect x="${index * step + (step - bar) / 2}" width="${bar}" y="${90 - column.exited / peak * 84}" height="${column.exited / peak * 84}" fill="#c026d3"/>` : ''}${
      column.entered ? `<rect x="${index * step + (step - bar) / 2}" width="${bar}" y="90" height="${column.entered / peak * 66}" fill="#0891b2"/>` : ''}${
      index > 0 && column.video !== columns[index - 1]!.video ? `<line x1="${index * step}" x2="${index * step}" y1="0" y2="160" stroke="#64748b" stroke-dasharray="3 3"/>` : ''}`).join('')}
    <text x="4" y="12" font-size="10">exits per minute (up), entries (down), reviewer layer; max ${peak}</text></svg>`;
}

function tracksSVG(segment: MediaSegment, paths: ReportData['tracks'][number]['paths']): string {
  const { width, height } = segment.metadata;
  const r = Math.max(2, width / 250);
  return `<svg class="figure" viewBox="0 0 ${width} ${height}" role="img" aria-label="All tracks of ${escape(segment.metadata.filename)}"><rect width="${width}" height="${height}" fill="#0f172a"/>${
    paths.map(path => `<polyline points="${path.points.map(([x, y]) => `${x},${y}`).join(' ')}" fill="none" stroke="${COLOURS[path.index % COLOURS.length]}" stroke-width="${r / 1.5}"${path.uncertain ? ` stroke-dasharray="${r * 2} ${r}"` : ''}/>${
      path.points.length ? `<circle cx="${path.points[0]![0]}" cy="${path.points[0]![1]}" r="${r}" fill="none" stroke="#f8fafc" stroke-width="${r / 2}"/>` : ''}`).join('')}</svg>`;
}

function densitySVG(segment: MediaSegment, paths: ReportData['tracks'][number]['paths']): string {
  const { width, height } = segment.metadata;
  const columns = 32, rows = Math.max(1, Math.round(columns * height / width));
  const grid = new Array<number>(columns * rows).fill(0);
  for (const path of paths) {
    const start = path.points[0];
    if (!start) continue;
    grid[Math.min(rows - 1, Math.floor(start[1] / height * rows)) * columns + Math.min(columns - 1, Math.floor(start[0] / width * columns))]! += 1;
  }
  const max = Math.max(1, ...grid), cw = width / columns, ch = height / rows;
  return `<svg class="figure" viewBox="0 0 ${width} ${height}" role="img" aria-label="Start points of ${escape(segment.metadata.filename)}"><rect width="${width}" height="${height}" fill="#0f172a"/>${
    grid.map((value, cell) => value ? `<rect x="${(cell % columns) * cw}" y="${Math.floor(cell / columns) * ch}" width="${cw}" height="${ch}" fill="#f97316" fill-opacity="${(0.2 + 0.8 * value / max).toFixed(2)}"/>` : '').join('')}</svg>`;
}

/** One static, script-free HTML page; every value is escaped and figures are inline SVG. */
export function reportHTML(data: ReportData): string {
  const video = (id: string) => `${data.segments.findIndex(item => item.id === id) + 1}`;
  const sections: Record<(typeof REPORT_SECTIONS)[number], string> = {
    'Survey and videos': `<p>Survey <b>${escape(data.session.display_name)}</b>, camera ${escape(data.session.camera_ref)}. ${data.anchor
      ? `Declared recording clock: ${escape(data.anchor.utc)} at the first frame of video ${video(data.anchor.segment_id)} (${escape(data.anchor.provenance)}).` : 'No declared recording clock: times are elapsed time in each video.'}</p>${
      table(['#', 'File', 'SHA-256', 'Duration', 'Frame', 'Modality', 'State'], data.segments.map((segment, index) => [index + 1, segment.metadata.filename, segment.metadata.sha256,
        minutes(seconds(segment.metadata.elapsed_end) ?? seconds(segment.metadata.elapsed_last_time)), `${segment.metadata.width} x ${segment.metadata.height}`, segment.modality ?? 'active_ir', segment.source_state]))}`,
    'Gates': data.counts.map(counts => `<div class="gate"><p><b>${escape(counts.gate.name)}</b> (${escape(counts.gate.kind)}, revision ${counts.gate.revision}, entering ${escape(counts.gate.entry_direction.replaceAll('_', ' '))}, hysteresis ${counts.gate.hysteresis_px} px, ${counts.invalid_spans.length} paused span${counts.invalid_spans.length === 1 ? '' : 's'})</p>${gateSVG(counts)}</div>`).join('') || '<p>No active gates.</p>',
    'Counts per gate and layer': table(['Gate', 'Layer', 'Entered', 'Exited', 'Net', 'State'], data.counts.flatMap(counts => {
      const { algorithm, reviewer, qa } = counts.layers;
      return [[counts.gate.name, 'algorithm (unverified)', algorithm.entered, algorithm.exited, algorithm.net, `${algorithm.coherent} coherent, ${algorithm.uncertain} uncertain crossings, rule ${counts.algorithm_version}`],
        [counts.gate.name, 'reviewer', reviewer.entered, reviewer.exited, reviewer.net, `${reviewer.state}${reviewer.accepted ? `, accepted by ${reviewer.accepted.actor}${reviewer.accepted.current ? '' : ' (stale)'}` : ''}, ${reviewer.unresolved} unresolved`],
        [counts.gate.name, 'QA', qa?.counts?.entered ?? '-', qa?.counts?.exited ?? '-', qa?.counts?.net ?? '-', qa ? `${qa.decision} by ${qa.actor}${qa.stale ? ' (stale)' : ''}` : 'no QA decision']];
    })) + (data.counts.length > 1 ? '<p>Gates are counted separately; a bat may cross several gates, so gate totals are not added up here.</p>' : ''),
    'Emergence profile and flow': data.counts.map(counts => {
      const profile = counts.profile, layer = profile.layers.reviewer, after = profile.minutes_after_sunset?.reviewer;
      return `<p><b>${escape(counts.gate.name)}</b>: first exit ${layer.first_exit ? `video ${video(layer.first_exit.segment_id)} at ${minutes(layer.first_exit.seconds)}` : 'none'}, last exit ${
        layer.last_exit ? `video ${video(layer.last_exit.segment_id)} at ${minutes(layer.last_exit.seconds)}` : 'none'}, peak ${layer.peak_minute ? `${layer.peak_minute.exited} exits in minute ${layer.peak_minute.minute + 1} of video ${video(layer.peak_minute.segment_id)}` : 'none'}, busiest second ${layer.peak_exits_per_second}. ${
        profile.sunset ? `Sunset ${escape(profile.sunset.sunset)} (${escape(profile.sunset.source)}, entered by ${escape(profile.sunset.actor)})${!profile.clock_segment_id ? '; no declared recording clock, so no time after sunset' : after?.first_exit != null ? `; first exit ${after.first_exit} min after sunset` : '; no exit in the video with the declared clock'}.` : 'No sunset entered.'}</p>${profileSVG(counts, data.segments)}`;
    }).join('') || '<p>No active gates.</p>',
    'Sample checks': table(['Gate', 'Video', 'By', 'Manual in/out', 'Algorithm in/out', 'Matched', 'Missed by algorithm', 'Extra in algorithm'],
      data.counts.flatMap(counts => (data.sampleChecks[counts.gate.id] ?? []).map(check => [counts.gate.name, video(check.segment_id), check.actor,
        `${check.result.manual.entry}/${check.result.manual.exit}`, `${check.result.algorithm.entry}/${check.result.algorithm.exit}`, check.result.matched.length,
        check.result.missed_by_algorithm.length, check.result.extra_in_algorithm.length]))),
    'Review coverage': `<p>${data.review ? `${data.review.reviewed} of ${data.review.total} planned windows have a first review (${data.review.unreviewed} unreviewed). The denominator is every recorded window, with or without tracks.` : 'No review progress available.'} ${data.windows} windows were planned in the processing run.</p>`,
    'Tracks and labels': `<p>${Object.values(data.tracking.track_counts).reduce((sum, value) => sum + value, 0)} tracks in tracking run ${escape(data.tracking.id)}. Hollow circles mark where each track was first seen; the density figure counts track start points (not individuals).</p>${
      data.tracks.map(item => {
        const segment = data.segments.find(entry => entry.id === item.segmentID);
        return segment ? `<p>Video ${video(item.segmentID)}: ${item.shown} of ${item.total} non-noise tracks drawn${item.shown < item.total ? ' (display limit, steadiest first)' : ''}.</p><div class="pair">${tracksSVG(segment, item.paths)}${densitySVG(segment, item.paths)}</div>` : '';
      }).join('')}${data.labels && Object.keys(data.labels.tracks).length ? table(['Label', 'Tracks', 'Species entered'], Object.entries(Object.values(data.labels.tracks).reduce((groups, label) => {
        const group = groups[label.category] ?? { tracks: 0, species: new Set<string>() };
        group.tracks += 1; if (label.species) group.species.add(label.species);
        return { ...groups, [label.category]: group };
      }, {} as Record<string, { tracks: number; species: Set<string> }>)).map(([category, group]) => [category.replaceAll('_', ' '), group.tracks, [...group.species].join(', ')])) : '<p>No track labels.</p>'}`,
    'Settings and versions': table(['Item', 'Value'], [['Tracking algorithm', data.tracking.algorithm_version], ['Tracking parameter SHA-256', data.tracking.parameter_hash],
      ['Tracking settings', JSON.stringify(data.tracking.parameters.settings ?? data.tracking.parameters)], ['Gate rule', [...new Set(data.counts.map(counts => counts.algorithm_version))].join(', ') || '-'],
      ['Tracking run finished', data.tracking.finished_at_utc ?? '-'], ['Report generated', data.generatedUTC]]),
    'Limitations': `<ul>${LIMITATIONS.map(item => `<li>${escape(item)}</li>`).join('')}</ul>`,
  };
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>PROVISIONAL evidence report - ${escape(data.session.display_name)}</title><style>
body{font:11px/1.4 system-ui,sans-serif;color:#0f172a;margin:0}h1{font-size:18px;margin:0 0 4px}h2{font-size:14px;margin:16px 0 6px;border-bottom:1px solid #cbd5e1}
.banner{border:3px solid #b91c1c;color:#b91c1c;font-weight:700;padding:6px 10px;margin:0 0 10px;font-size:13px}table{border-collapse:collapse;width:100%;margin:4px 0}
th,td{border:1px solid #cbd5e1;padding:2px 4px;text-align:left;vertical-align:top;overflow-wrap:anywhere}.figure{width:100%;max-width:600px;display:block;margin:4px 0}
.figure.small{max-width:220px}.pair{display:flex;gap:8px}.pair .figure{width:49%}.gate{display:inline-block;margin:0 12px 8px 0;vertical-align:top}
</style></head><body><p class="banner">PROVISIONAL - NOT ECOLOGICALLY FINALISED. Algorithm and review state at ${escape(data.generatedUTC)}; not final counts.</p>
<h1>Bat emergence review evidence report</h1>${REPORT_SECTIONS.map(name => `<section><h2>${escape(name)}</h2>${sections[name]}</section>`).join('')}</body></html>`;
}
