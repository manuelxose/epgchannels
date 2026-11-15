// Regenerate the licence-clean demo media (owned, ffmpeg-generated).
// Produces HLS renditions plus deliberately broken assets used by the error tests.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const FFMPEG = process.env['FFMPEG'] ?? 'ffmpeg';
const outRoot = 'public/demo/media';

function run(args) {
  execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: 'inherit' });
}

/** Builds one HLS variant from the testsrc2 pattern with a labelled overlay. */
function buildVariant({ outDir, width, height, bitrate, label, color }) {
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  const filter = [
    `testsrc2=size=${width}x${height}:rate=25:duration=24`,
    `drawbox=x=0:y=0:w=iw:h=ih:color=${color}@0.18:t=fill`,
    `drawtext=text='TDT PLAYER DEMO':fontcolor=white:fontsize=${Math.round(height / 8)}:x=(w-text_w)/2:y=(h-text_h)/2-40:box=1:boxcolor=black@0.35:boxborderw=18`,
    `drawtext=text='${label} ${width}x${height}':fontcolor=white:fontsize=${Math.round(height / 20)}:x=(w-text_w)/2:y=(h-text_h)/2+60:box=1:boxcolor=black@0.35:boxborderw=12`,
  ].join(',');
  run([
    '-f', 'lavfi', '-i', filter,
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=24',
    '-c:v', 'libx264', '-preset', 'veryfast', '-profile:v', 'main', '-pix_fmt', 'yuv420p',
    '-b:v', bitrate, '-maxrate', bitrate, '-bufsize', '1200k',
    '-c:a', 'aac', '-b:a', '96k', '-ac', '2',
    '-g', '50', '-keyint_min', '50', '-sc_threshold', '0',
    '-f', 'hls', '-hls_time', '4', '-hls_playlist_type', 'event',
    '-hls_segment_filename', join(outDir, 'segment-%03d.ts'),
    join(outDir, 'index.m3u8'),
  ]);
  return readdirSync(outDir).length;
}

mkdirSync(outRoot, { recursive: true });

const variants = [
  { name: 'high', width: 1280, height: 720, bitrate: '1600k', label: 'Alta', color: '#7c5cff' },
  { name: 'low', width: 640, height: 360, bitrate: '500k', label: 'Baja', color: '#fbbf24' },
];

const counts = {};
for (const variant of variants) {
  counts[variant.name] = buildVariant({ outDir: join(outRoot, variant.name), ...variant });
  console.log(`built ${variant.name}: ${counts[variant.name]} files`);
}

// Master playlist with relative URLs so it resolves from any host.
writeFileSync(
  join(outRoot, 'master.m3u8'),
  [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    '#EXT-X-INDEPENDENT-SEGMENTS',
    '#EXT-X-STREAM-INF:BANDWIDTH=1800000,RESOLUTION=1280x720,CODECS="avc1.4d401f,mp4a.40.2"',
    'high/index.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=620000,RESOLUTION=640x360,CODECS="avc1.4d401e,mp4a.40.2"',
    'low/index.m3u8',
    '',
  ].join('\n'),
);

counts.single = buildVariant({
  outDir: join(outRoot, 'single'),
  width: 854,
  height: 480,
  bitrate: '900k',
  label: 'Secundaria',
  color: '#34d399',
});
console.log(`built single: ${counts.single} files`);

// A playlist whose only segment does not exist: used by the failure-path tests.
mkdirSync(join(outRoot, 'broken'), { recursive: true });
writeFileSync(
  join(outRoot, 'broken', 'index.m3u8'),
  ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:4', '#EXTINF:4.0,', 'missing-000.ts', '#EXT-X-ENDLIST', ''].join('\n'),
);
writeFileSync(join(outRoot, 'broken', 'not-a-video.mp4'), 'this is not a video file');

writeFileSync(
  join(outRoot, 'manifest.json'),
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      license: 'Self-generated with ffmpeg (testsrc2 + sine). No third-party content.',
      variants,
      counts,
    },
    null,
    2,
  ),
);
console.log('demo media ready');
