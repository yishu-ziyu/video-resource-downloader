import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

const root = path.resolve('.');
const artifacts = path.resolve(process.env.TEST_ARTIFACTS || path.join(root, 'artifacts', 'download-fix-0.4.0'));
const fixtures = await mkdtemp(path.join(tmpdir(), 'video-fixtures-'));
const profile = await mkdtemp(path.join(tmpdir(), 'video-extension-'));
await mkdir(path.join(artifacts, 'downloads'), { recursive: true });
await mkdir(path.join(profile, 'Default'));
await writeFile(path.join(profile, 'Default', 'Preferences'), JSON.stringify({
  download: { default_directory: path.join(artifacts, 'downloads'), prompt_for_download: false },
}));
execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i',
  'testsrc=size=160x90:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '3',
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '25', '-c:a', 'aac',
  '-movflags', '+faststart', path.join(fixtures, 'sample.mp4')]);
execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', path.join(fixtures, 'sample.mp4'),
  '-c', 'copy', '-hls_time', '1', '-hls_list_size', '0', path.join(fixtures, 'stream.m3u8')]);
execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', path.join(fixtures, 'sample.mp4'), '-frames:v', '1', path.join(fixtures, 'poster.jpg')]);
execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', path.join(fixtures, 'sample.mp4'), '-vn', '-c:a', 'libmp3lame', '-t', '3', path.join(fixtures, 'music.mp3')]);
execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', path.join(fixtures, 'sample.mp4'), '-frames:v', '1', '-vf', 'scale=640:360', '-q:v', '2', path.join(fixtures, 'photo.jpg')]);
execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=red:size=16x16', '-frames:v', '1', path.join(fixtures, 'icon.png')]);
// Images under 30 KiB are treated as icons and filtered; pad the photo above it.
const photoBytes = await readFile(path.join(fixtures, 'photo.jpg'));
if (photoBytes.length < 40960) await writeFile(path.join(fixtures, 'photo.jpg'), Buffer.concat([photoBytes, Buffer.alloc(40960 - photoBytes.length)]));
execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', path.join(fixtures, 'sample.mp4'), '-vf', 'scale=80:46', '-c:v', 'libx264', '-g', '25', '-c:a', 'aac', '-hls_time', '1', '-hls_list_size', '0', path.join(fixtures, 'low.m3u8')]);
await writeFile(path.join(fixtures, 'old.mp4'), await readFile(path.join(fixtures, 'sample.mp4')));
execFileSync('ffmpeg', ['-hide_banner','-loglevel','error','-i',path.join(fixtures,'sample.mp4'),'-vf','scale=80:46','-c:v','libx264','-c:a','copy',path.join(fixtures,'new.mp4')]);
for (const [type, prefix] of [['v', 'v'], ['a', 'a']]) {
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', path.join(fixtures, 'sample.mp4'),
    '-map', `0:${type}`, '-c', 'copy', '-hls_time', '1', '-hls_list_size', '0', '-hls_segment_type', 'fmp4',
    '-hls_fmp4_init_filename', `${prefix}-init.mp4`, '-hls_segment_filename', path.join(fixtures, `${prefix}%d.m4s`),
    path.join(fixtures, `${prefix}-fmp4.m3u8`)]);
}
execFileSync('ffmpeg', ['-hide_banner','-loglevel','error','-i',path.join(fixtures,'sample.mp4'),'-c:v','libvpx','-c:a','libopus',path.join(fixtures,'mp4-demo.webm')]);
execFileSync('ffmpeg', ['-hide_banner','-loglevel','error','-i',path.join(fixtures,'sample.mp4'),'-c:v','mpeg2video','-c:a','aac',
  '-hls_time','1','-hls_list_size','0','-hls_segment_filename',path.join(fixtures,'mpeg2-%d.ts'),path.join(fixtures,'mpeg2.m3u8')]);
const tsReference = path.join(fixtures, 'reference.ts');
await writeFile(tsReference, Buffer.concat(await Promise.all([0, 1, 2].map(i => readFile(path.join(fixtures, `stream${i}.ts`))))));
// Hash every decoded frame, so a remuxed MP4 can be compared with its source TS.
function decoded(file, stream) {
  const lines = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-map', `0:${stream}`, '-f', 'framemd5', '-']).toString().split('\n');
  const frames = lines.filter(line => line && !line.startsWith('#')).map(line => line.split(',').pop().trim());
  return { count: frames.length, digest: createHash('md5').update(frames.join('\n')).digest('hex') };
}
const fmp4Video = await readFile(path.join(fixtures, 'v-fmp4.m3u8'), 'utf8');
const fmp4Audio = await readFile(path.join(fixtures, 'a-fmp4.m3u8'), 'utf8');
const playlist = await readFile(path.join(fixtures, 'stream.m3u8'), 'utf8');
const padding = Buffer.alloc(188 * 4096, 0xff);
for (let i = 0; i < padding.length; i += 188) padding.set([0x47, 0x1f, 0xff, 0x10], i);
const paddingCount = 360; // 264 MiB of valid null TS packets, without holding a large fixture in memory.
const requests = [];
let largeServed = 0;
const abortedRequests = [];
const refererRequests = [];
const gates = new Map();
const gateEvents = [];
function blockGate(name, fail = false) { gates.set(name, { open: false, fail, pending: new Set(), active: 0 }); }
function holdResponse(name, res, finish) {
  const gate = gates.get(name);
  if (!gate || gate.open) { void finish(); return; }
  const release = () => { gate.pending.delete(release); if (!res.destroyed) void finish(); };
  gate.active++; gate.pending.add(release); gateEvents.push({ name, event: 'blocked', time: Date.now() });
  res.on('close', () => { gate.active--; gate.pending.delete(release); gateEvents.push({ name, event: 'closed', time: Date.now() }); });
}
function releaseGate(name) {
  const gate = gates.get(name); gate.open = true;
  for (const finish of [...gate.pending]) finish();
}
async function waitGate(name) {
  const deadline = Date.now() + 10000;
  while (!gates.get(name)?.active) {
    if (Date.now() > deadline) throw new Error(`没有到达服务器闸门：${name}`);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  requests.push(url.pathname);
  res.setHeader('Access-Control-Allow-Origin', '*');
  try {
    if (url.pathname.startsWith('/referer-')) {
      const [, group, name] = url.pathname.split('/');
      const actual = req.headers.referer || '';
      const allowed = [base + '/', ...(group === 'referer-shared' ? [base.replace('127.0.0.1', 'localhost') + '/'] : [])];
      const status = allowed.includes(actual) ? 200 : 412;
      refererRequests.push({ path: url.pathname, referer: actual, status });
      if (status !== 200) { res.writeHead(status); res.end('Referer required'); return; }
      if (name === 'master.m3u8') {
        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
        res.end(group === 'referer-fmp4'
          ? '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="sound",NAME="Audio",DEFAULT=YES,URI="a-fmp4.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=200000,RESOLUTION=160x90,CODECS="avc1.64000b,mp4a.40.2",AUDIO="sound"\nv-fmp4.m3u8\n'
          : '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=200000,RESOLUTION=160x90\nstream.m3u8\n');
      } else if (group === 'referer-redirect' && name === 'stream.m3u8') {
        res.writeHead(302, { Location: 'redirected-stream.m3u8' }); res.end();
      } else if (name === 'stream.m3u8' || name === 'redirected-stream.m3u8') {
        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl'); res.end(playlist);
      } else {
        const reply = async () => {
          if (group === 'referer-fail' && name === 'stream1.ts') { res.writeHead(404); res.end(); return; }
          res.setHeader('Content-Type', name.endsWith('.ts') ? 'video/mp2t' : name.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp4');
          res.end(await readFile(path.join(fixtures, name)));
        };
        if ((group === 'referer-cancel' || group === 'referer-shared') && name === 'stream1.ts') holdResponse(group, res, reply);
        else await reply();
      }
    } else if (/^\/concurrent-[\w-]+\.m3u8$/.test(url.pathname)) {
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      const name = path.basename(url.pathname, '.m3u8');
      res.end(playlist.replaceAll(/stream(\d).ts/g, `${name}-$1.ts`));
    } else if (/^\/concurrent-[\w-]+-\d\.ts$/.test(url.pathname)) {
      const name = path.basename(url.pathname).replace(/-\d\.ts$/, '');
      const index = url.pathname.match(/-(\d)\.ts$/)[1];
      const reply = async () => {
        if (gates.get(name)?.fail) { res.writeHead(404); res.end(); }
        else { res.setHeader('Content-Type', 'video/mp2t'); res.end(await readFile(path.join(fixtures, `stream${index}.ts`))); }
      };
      if (index === '0' && !gates.get(name)?.fail) await reply();
      else holdResponse(name, res, reply);
    } else if (url.pathname === '/concurrent-direct.mp4') {
      holdResponse('concurrent-direct', res, async () => {
        const bytes = await readFile(path.join(fixtures, 'sample.mp4'));
        res.setHeader('Content-Type', 'video/mp4'); res.setHeader('Content-Length', bytes.length); res.end(bytes);
      });
    } else if (url.pathname === '/') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(`<title>下载验收视频</title><article><h2>彩色测试片 · 完整音画</h2><video controls aria-label="彩色测试片 · 完整音画" poster="/poster.jpg" src="/sample.mp4"></video></article>
        <button onclick="document.querySelector('video').play()">播放</button>
        <button onclick="fetch('/master.m3u8')">请求 HLS</button>
        <button onclick="fetch('/encrypted.m3u8')">请求加密视频</button>
        <button onclick="fetch('/live.m3u8')">请求直播</button>
        <button onclick="fetch('/loop.m3u8')">请求循环清单</button>
        <button onclick="fetch('/broken.m3u8')">请求错误片段</button>
        <button onclick="fetch('/split.m3u8')">请求分离音轨</button>
        <button onclick="fetch('/slow.m3u8')">请求慢速视频</button>
        <button onclick="fetch('/map.m3u8')">请求 fMP4</button>
        <button onclick="fetch('/incomplete.m3u8')">请求不完整 TS</button>
        <button onclick="fetch('/fake.m3u8')">请求伪视频片段</button>
        <button onclick="fetch('/large.m3u8')">请求大体积 TS</button>
        <button onclick="fetch('/huge.m3u8')">请求截断大文件</button>
        <button onclick="fetch('/opaque')">请求无后缀视频</button>
        <button onclick="fetch('/clip.mpd')">请求 DASH</button>
        <button onclick="fetch('/mp4-demo.webm')">请求 WebM</button>
        <button onclick="fetch('/fmp4-master.m3u8')">请求完整分片视频</button>
        <button onclick="fetch('/opaque-init.mp4')">请求伪完整 MP4</button>
        <button onclick="fetch('/fmp4-broken.m3u8')">请求缺失音频分片</button>
        <button onclick="fetch('/expired.m3u8')">请求随后过期的清单</button>
        <button onclick="fetch('/progress.m3u8')">请求进度视频</button>
        <button onclick="fetch('/slow-file.mp4')">请求慢速文件</button>
        <button onclick="fetch('/unknown-size.mp4')">请求未知大小文件</button>`);
    } else if (url.pathname === '/spa.html') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(`<title>旧页面</title><article></article>
        <button onclick="fetch('/late-old.m3u8').finally(()=>window.oldRequestDone=true);history.pushState({},'', '/spa-new');render()">切到新视频</button>
        <button onclick="history.back()">返回旧视频</button>
        <script>function render(){const isNew=location.pathname==='/spa-new';document.title=isNew?'新页面':'旧页面';document.querySelector('article').innerHTML='<h2>'+(isNew?'新视频':'旧视频')+'</h2><video controls poster="/poster.jpg" src="/'+(isNew?'new':'old')+'.mp4"></video>'}addEventListener('popstate',render);render()</script>`);
    } else if (url.pathname === '/late-old.m3u8') {
      setTimeout(()=>{res.setHeader('Content-Type','application/vnd.apple.mpegurl');res.end(playlist)},900);
    } else if (url.pathname === '/gallery.html') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(`<title>两段视频</title>
        <article><h2>第一段 · 彩色画面</h2><video aria-label="第一段 · 彩色画面" controls poster="/poster.jpg" src="/sample.mp4?clip=1"></video></article>
        <article><h2>第二段 · 完整音画</h2><video aria-label="第二段 · 完整音画" controls src="/sample.mp4?clip=2"></video></article>`);
    } else if (url.pathname === '/preview-failure.html') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end('<title>失效预览测试</title><video aria-label="失效的视频" poster="/poster.jpg" src="/missing.mp4"></video>');
    } else if (url.pathname === '/progress.m3u8') {
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      res.end(playlist.replaceAll(/stream(\d).ts/g, 'delayed-stream$1.ts'));
    } else if (url.pathname.startsWith('/delayed-stream')) {
      const data = await readFile(path.join(fixtures, path.basename(url.pathname).replace('delayed-', '')));
      setTimeout(() => { res.setHeader('Content-Type', 'video/mp2t'); res.end(data); }, 600);
    } else if (url.pathname === '/slow-file.mp4' || url.pathname === '/unknown-size.mp4') {
      const data = await readFile(path.join(fixtures, 'sample.mp4'));
      res.setHeader('Content-Type', 'video/mp4'); res.setHeader('Cache-Control', 'no-store');
      if (url.pathname === '/slow-file.mp4') res.setHeader('Content-Length', data.length);
      res.flushHeaders();
      let offset = 0;
      const timer = setInterval(() => {
        res.write(data.subarray(offset, offset + 4096)); offset += 4096;
        if (offset >= data.length) { clearInterval(timer); res.end(); }
      }, 250);
      res.on('close', () => { clearInterval(timer); if (offset < data.length) abortedRequests.push(url.pathname); });
    } else if (url.pathname === '/x-fixture.html') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(`<title>X 媒体关联模拟</title>
        <article><div data-testid="tweetText">第一条帖子的视频</div><video aria-label="Embedded video" controls poster="https://pbs.twimg.com/ext_tw_video_thumb/1111/pu/img/poster.jpg"></video></article>
        <article><div data-testid="tweetText">第二条帖子的视频</div><video controls poster="https://pbs.twimg.com/ext_tw_video_thumb/2222/pu/img/poster.jpg"></video></article>`);
    } else if (url.pathname === '/douyin-fixture.html') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      const track = file => `${base}/dy-cdn/sign-${Math.random().toString(16).slice(2)}/6ae4d802/video/tos/cn/tos-cn-vd-0026/${file}${file.includes('?') ? '&' : '?'}mime_type=video_mp4`;
      const render = encodeURIComponent(JSON.stringify({ app: { videoDetail: {
        awemeId: '7700117223133711654', desc: '抖音夹具视频 · 访谈节目',
        video: { duration: 3000, cover: `${base}/poster.jpg`,
          playAddr: [{ src: track('oAAA111/media-video-avc1/?br=326') }, { src: track('oAAA111/media-video-avc1/?br=326&mirror=1') }],
          bitRateAudioList: [{ urlList: [{ src: track('oAAA111/media-audio-und-mp4a/?br=53') }] },
            { urlList: [{ src: track('oBBB222/media-audio-und-mp4a/?br=189') }] }],
          bitRateList: [{ playAddr: [{ src: track('oCCC333/media-video-avc1/?br=222') }] },
            { playAddr: [{ src: track('oBBB222/media-video-hvc1/?br=162') }] }] } } } }));
      res.end(`<title>抖音夹具</title><script id="RENDER_DATA" type="application/json">${render}</script>
        <video controls src="/sample.mp4"></video>`);
    } else if (url.pathname.startsWith('/dy-cdn/')) {
      res.setHeader('Content-Type', 'video/mp4');
      res.end(await readFile(path.join(fixtures, 'sample.mp4')));
    } else if (url.pathname === '/bili-fixture.html') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      const sig = () => Math.random().toString(16).slice(2);
      const m4s = (id, code) => `${base}/bili-cdn/h${sig()}/upgcxcode/23/17/${id}/${id}-1-${code}.m4s?e=${sig()}`;
      const playinfo = JSON.stringify({ code: 0, data: { dash: { duration: 3,
        video: [{ id: 80, codecs: 'avc1.640028', bandwidth: 400000, baseUrl: m4s(555000111, 30080),
            backup_url: [m4s(555000111, 30080), m4s(555000111, 30080)] },
          { id: 80, codecs: 'hvc1.1.6.L120.90', bandwidth: 300000, baseUrl: m4s(555000111, 30081), backup_url: [] },
          { id: 32, codecs: 'avc1.64001F', bandwidth: 159043, baseUrl: m4s(555000111, 30032), backup_url: [] }],
        audio: [{ id: 30216, codecs: 'mp4a.40.2', bandwidth: 65674, baseUrl: m4s(555000111, 30216),
          backup_url: [m4s(555000111, 30216)] }] } } });
      res.end(`<title>B站夹具</title>
        <meta property="og:title" content="B站夹具视频 · 芯片横评"><meta property="og:image" content="${base}/poster.jpg">
        <script>window.__playinfo__=${playinfo}</script>
        <video controls src="/sample.mp4"></video>`);
    } else if (url.pathname.startsWith('/bili-cdn/')) {
      res.setHeader('Content-Type', 'video/mp4');
      res.end(await readFile(path.join(fixtures, 'sample.mp4')));
    } else if (url.pathname === '/xhs-fixture.html') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      const sig = () => Math.random().toString(16).slice(2);
      const stream = (file, type) => `${base}/xhs-cdn/h${sig()}/stream/79/110/${type}/${file}_${type}.mp4?sign=${sig()}`;
      const state = JSON.stringify({ note: { noteDetailMap: { note1: { note: {
        title: '小红书夹具视频 · 收纳技巧', type: 'video', video: { duration: 3,
          media: { stream: { EF4: [{ masterUrl: stream('0aaa111ccc', 258),
              backupUrls: [stream('0aaa111ccc', 258), stream('0aaa111ccc', 258)],
              videoDuration: 3000, height: 720, videoCodec: 'EF4', format: 'mp4' },
            { masterUrl: stream('0bbb222ddd', 261), backupUrls: [],
              videoDuration: 3000, height: 1080, videoCodec: 'EF4', format: 'mp4' }],
            EF5: [], EF6: [], EF7: [] } } },
        imageList: [{ urlDefault: `${base}/poster.jpg` }] } } } } });
      // Real pages serialize raw JS: undefined values and constructor calls.
      res.end(`<title>小红书夹具</title><script>window.__INITIAL_STATE__=${state.slice(0, -1)},"tailMap":new Map([]),"bad":undefined,"x":NaN}</script>
        <video controls src="/sample.mp4"></video>`);
    } else if (url.pathname.startsWith('/xhs-cdn/')) {
      res.setHeader('Content-Type', 'video/mp4');
      res.end(await readFile(path.join(fixtures, 'sample.mp4')));
    } else if (url.pathname === '/audio-fixture.html') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(`<title>音频夹具</title><audio controls aria-label="夹具音频 · 夜航钢琴" src="/music.mp3"></audio>
        <script>fetch('/audio-stream')</script>`);
    } else if (url.pathname === '/audio-stream') {
      const data = await readFile(path.join(fixtures, 'music.mp3'));
      res.setHeader('Content-Type', 'audio/mpeg'); res.end(data);
    } else if (url.pathname === '/image-fixture.html') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(`<title>图片夹具</title><img src="/photo.jpg" alt="夹具照片"><img src="/icon.png" alt="小图标"><img src="/photo-stream" alt="无后缀照片">`);
    } else if (url.pathname === '/photo-stream') {
      const data = await readFile(path.join(fixtures, 'photo.jpg'));
      res.setHeader('Content-Type', 'image/jpeg'); res.end(data);
    } else if (/^\/note-img\d\.jpg$/.test(url.pathname)) {
      const data = await readFile(path.join(fixtures, 'photo.jpg'));
      res.setHeader('Content-Type', 'image/jpeg'); res.end(data);
    } else if (url.pathname === '/xhs-image-fixture.html') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      const state = JSON.stringify({ note: { noteDetailMap: { noteImg: { note: {
        title: '小红书图文夹具 · 城市漫步', type: 'normal',
        imageList: [1, 2, 3].map(i => ({ urlDefault: `${base}/note-img${i}.jpg`,
          urlPre: `${base}/note-img${i}.jpg?size=pre`, infoList: [{ url: `${base}/note-img${i}.jpg?size=hd` }] })) } } } } });
      res.end(`<title>小红书图文</title><script>window.__INITIAL_STATE__=${state}</script>
        ${[1, 2, 3].map(i => `<img src="/note-img${i}.jpg">`).join('')}`);
    } else if (url.pathname === '/expired.m3u8') {
      if (requests.filter(value => value === url.pathname).length > 1) { res.writeHead(403); res.end(); }
      else { res.setHeader('Content-Type', 'application/vnd.apple.mpegurl'); res.end(playlist); }
    } else if (url.pathname === '/fmp4-master.m3u8' || url.pathname === '/fmp4-broken.m3u8') {
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      const audio = url.pathname.includes('broken') ? 'broken-a.m3u8' : 'a-fmp4.m3u8';
      res.end(`#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="sound",NAME="Audio",DEFAULT=YES,URI="${audio}"\n#EXT-X-STREAM-INF:BANDWIDTH=200000,RESOLUTION=160x90,CODECS="avc1.64000b,mp4a.40.2",AUDIO="sound"\nv-fmp4.m3u8\n`);
    } else if (url.pathname === '/broken-a.m3u8') {
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      res.end(fmp4Audio.replace('a0.m4s', 'missing-a.m4s'));
    } else if (url.pathname === '/opaque-init.mp4') {
      res.setHeader('Content-Type', 'video/mp4'); res.end(await readFile(path.join(fixtures, 'a-init.mp4')));
    } else if (url.pathname === '/master.m3u8') {
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      res.end('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=100000,RESOLUTION=80x46\nlow.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=200000,RESOLUTION=160x90\nstream.m3u8\n');
    } else if (url.pathname === '/loop.m3u8') {
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      res.end('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=200000\nloop.m3u8\n');
    } else if (url.pathname === '/split.m3u8') {
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      res.end('#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",URI="audio.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=200000,AUDIO="audio"\nstream.m3u8\n');
    } else if (url.pathname === '/encrypted.m3u8') {
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      res.end(playlist.replace('#EXTM3U', '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="secret.key"'));
    } else if (url.pathname === '/live.m3u8') {
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      res.end(playlist.replace('#EXT-X-ENDLIST', ''));
    } else if (url.pathname === '/broken.m3u8') {
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      res.end(playlist.replace('stream1.ts', 'missing.ts'));
    } else if (url.pathname === '/slow.m3u8') {
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      res.end(playlist.replaceAll(/stream\d.ts/g, 'slow.ts'));
    } else if (url.pathname === '/slow.ts') {
      res.setHeader('Content-Type', 'video/mp2t');
      res.write(await readFile(path.join(fixtures, 'stream0.ts')));
      const timer = setTimeout(() => res.end(), 3000);
      res.on('close', () => { clearTimeout(timer); abortedRequests.push('/slow.ts'); });
    } else if (url.pathname === '/map.m3u8') {
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      res.end(playlist.replace('#EXTM3U', '#EXTM3U\n#EXT-X-MAP:URI="init.mp4"'));
    } else if (url.pathname === '/fake.m3u8' || url.pathname === '/huge.m3u8') {
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      res.end(playlist.replace('stream0.ts', url.pathname === '/fake.m3u8' ? 'fake.ts' : 'huge.ts'));
    } else if (url.pathname === '/incomplete.m3u8') {
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      res.end(playlist.replace('stream1.ts', 'incomplete.ts'));
    } else if (url.pathname === '/incomplete.ts') {
      res.setHeader('Content-Type', 'video/mp2t'); res.end(padding.subarray(0, 189));
    } else if (url.pathname === '/fake.ts') {
      res.setHeader('Content-Type', 'text/html'); res.end('<html>login required</html>');
    } else if (url.pathname === '/no-source.html') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end('<title>还没加载的视频</title><video controls aria-label="还没加载的视频" style="width:320px;height:180px"></video>');
    } else if (url.pathname === '/huge-fmp4.m3u8') {
      // 1 Gbit/s for the 3-second fMP4 playlist: an estimate above the 256 MiB merge limit.
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      res.end('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000000000,RESOLUTION=1920x1080\nv-fmp4.m3u8\n');
    } else if (url.pathname === '/longer.m3u8') {
      // The playlist claims ten times the real duration, so the remux check must reject the MP4.
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      res.end(playlist.replace(/#EXTINF:([\d.]+)/g, (_, seconds) => `#EXTINF:${Number(seconds) * 10}`));
    } else if (url.pathname === '/large.m3u8') {
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      res.end(playlist.replace('stream0.ts', 'large0.ts'));
    } else if (url.pathname === '/large0.ts') {
      const first = await readFile(path.join(fixtures, 'stream0.ts'));
      res.setHeader('Content-Type', 'video/mp2t');
      res.setHeader('Content-Length', first.length + padding.length * paddingCount);
      res.write(first); largeServed = first.length;
      for (let i = 0; i < paddingCount && !res.destroyed; i++) {
        largeServed += padding.length;
        if (!res.write(padding)) await new Promise(resolve => {
          const finish = () => { res.off('drain', finish); res.off('close', finish); resolve(); };
          res.once('drain', finish); res.once('close', finish);
        });
      }
      res.end();
    } else if (url.pathname === '/huge.ts') {
      res.setHeader('Content-Length', String(257 * 1024 * 1024));
      res.write(padding.subarray(0, 188));
      setTimeout(() => res.destroy(), 100);
    } else if (url.pathname === '/opaque') {
      res.setHeader('Content-Type', 'video/mp4'); res.end(await readFile(path.join(fixtures, 'sample.mp4')));
    } else if (url.pathname === '/clip.mpd') {
      res.setHeader('Content-Type', 'application/dash+xml'); res.end('<MPD/>');
    } else {
      const name = path.basename(url.pathname);
      const data = await readFile(path.join(fixtures, name));
      res.setHeader('Content-Type', name.endsWith('.jpg') ? 'image/jpeg' : name.endsWith('.png') ? 'image/png' : name.endsWith('.mp3') ? 'audio/mpeg' : name.endsWith('.webm') ? 'video/webm' : name.endsWith('.mp4') ? 'video/mp4' : name.endsWith('.m4s') ? 'video/iso.segment' : name.endsWith('.ts') ? 'video/mp2t' : 'application/vnd.apple.mpegurl');
      res.end(data);
    }
  } catch { res.writeHead(404); res.end('missing'); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const report = { started: new Date().toISOString(), filter: process.env.CHECK_FILTER || null, checks: [] };
let context;
async function check(name, fn) {
  if (process.env.CHECK_FILTER && !name.includes(process.env.CHECK_FILTER)) return;
  try { await fn(); report.checks.push({ name, result: 'pass' }); console.log(`PASS ${name}`); }
  catch (error) { report.checks.push({ name, result: 'fail', error: String(error) }); throw error; }
}
try {
  assert.ok((await readdir(path.join(root, 'extension'))).includes('manifest.json'), '插件尚未实现');
  context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium', headless: true, acceptDownloads: true, timeout: 45000,
    ...(process.env.TEST_PROXY ? { proxy: { server: process.env.TEST_PROXY, bypass: '127.0.0.1,localhost' } } : {}),
    args: [`--disable-extensions-except=${root}/extension`, `--load-extension=${root}/extension`],
  });
  context.setDefaultTimeout(15000);
  await context.tracing.start({ screenshots: true, snapshots: true });
  let [worker] = context.serviceWorkers();
  worker ||= await context.waitForEvent('serviceworker');
  const id = worker.url().split('/')[2];
  const player = await context.newPage();
  await player.goto(base);
  await player.getByText('播放', { exact: true }).click();
  await player.waitForFunction(() => document.querySelector('video').currentTime > 0);
  const tabId = await worker.evaluate(async base => (await chrome.tabs.query({})).find(t => t.url === base + '/').id, base);
  const panel = await context.newPage();
  await panel.setViewportSize({ width: 560, height: 600 });
  // The query selects the fixture tab; normal toolbar use resolves the active tab.
  await panel.goto(`chrome-extension://${id}/popup.html?tab=${tabId}`);
  const cdp = await context.newCDPSession(panel);
  // Restore native browser downloads so chrome.downloads filenames are not
  // replaced by Playwright/CDP's URL-based download interception.
  await cdp.send('Browser.setDownloadBehavior', { behavior: 'default' });
  // Most checks drive unmatched resources; keep the folded "其他资源" section open for them.
  // localStorage is shared by every page of this extension, so one write covers all panels.
  await panel.evaluate(() => localStorage.setItem('otherResourcesOpen', '1')); await panel.reload();
  const rowIn = (view, name) => view.locator('article').filter({ has: view.locator('.resource-name', { hasText: new RegExp('^' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$') }) });
  const row = name => rowIn(panel, name);
  let currentJobId;
  const jobStatus = (jobId = currentJobId, view = panel) => view.locator(`.status[data-job-id="${jobId}"]`);
  async function getJob(jobId = currentJobId) {
    return worker.evaluate(async id => (await chrome.storage.session.get('jobs')).jobs?.find(job => job.id === id), jobId);
  }
  async function waitJob(state, contains, jobId = currentJobId, view = panel) {
    await view.waitForFunction(({ state, contains, jobId }) => {
      const status = document.querySelector(`.status[data-job-id="${jobId}"]`);
      return status?.dataset.state === state && (!contains || status.textContent.includes(contains));
    }, { state, contains, jobId });
  }
  // A finished task folds the version row behind "更多操作", as a user would see it.
  async function revealActions(card) {
    // Wait until the card has settled on one of the two rows before deciding.
    await card.locator('.card-actions:visible, .more-actions:visible').first().waitFor();
    if (!(await card.locator('.card-actions').isVisible())) await card.getByRole('button', { name: '更多操作' }).click();
  }
  async function clickDownload(card) {
    const previous = await worker.evaluate(async () => ((await chrome.storage.session.get('jobs')).jobs || []).map(job => job.id));
    await revealActions(card);
    await card.locator('.download').click();
    // Wait for existence in the panel, then read the added ids from the worker:
    // the waitForFunction JSHandle's jsonValue is not reliable on this path.
    await card.page().waitForFunction(async previous => {
      const jobs = (await chrome.storage.session.get('jobs')).jobs || [];
      return jobs.some(job => !previous.includes(job.id));
    }, previous);
    const ids = await worker.evaluate(async previous =>
      ((await chrome.storage.session.get('jobs')).jobs || []).filter(job => !previous.includes(job.id)).map(job => job.id), previous);
    assert.equal(ids.length, 1, '一次点击必须只创建一个下载任务');
    currentJobId = ids[0];
    return currentJobId;
  }
  async function chooseVersion(card, label) {
    await card.getByRole('combobox', { name: '下载版本' }).click();
    await card.getByRole('option', { name: label, exact: true }).click();
  }
  async function waitTempEmpty() {
    await panel.waitForFunction(async () => {
      const root = await navigator.storage.getDirectory();
      try { const dir = await root.getDirectoryHandle('hls-downloads'); for await (const entry of dir.keys()) return false; }
      catch (e) { if (e.name !== 'NotFoundError') throw e; }
      return true;
    });
  }
  async function discover(names, page = player) {
    for (const name of names) await page.evaluate(name => fetch(`/${name}.m3u8`), name);
  }
  async function assertTsOutput(jobId, view = panel) {
    const filename = await downloaded(jobId, view);
    assert.ok(filename.endsWith('.mp4'), `TS HLS 必须转为 MP4：${filename}`);
    assert.match(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=format_name', '-of', 'csv=p=0', filename]).toString(), /mp4/);
    for (const stream of ['v', 'a']) {
      const actual = decoded(filename, stream), expected = decoded(tsReference, stream);
      assert.ok(expected.count > 0);
      assert.deepEqual(actual, expected, '每个任务必须保存自己的完整、有序音画，且与原 TS 逐帧一致');
    }
    return filename;
  }
    await panel.evaluate(async () => {
      const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('hls-downloads', { create: true });
      const writer = await (await dir.getFileHandle('abandoned.ts', { create: true })).createWritable();
      await writer.write('abandoned'); await writer.close();
    });
  await check('并发：三个 HLS 实际重叠，第四排队接续，取消独立且重开保留', async () => {
    const names = ['concurrent-slot-a', 'concurrent-slot-b', 'concurrent-slot-c', 'concurrent-slot-d', 'concurrent-slot-e'];
    for (const name of names) blockGate(name);
    await discover(names);
    const ids = [];
    for (const name of names) ids.push(await clickDownload(row(`${name}.m3u8`)));
    for (const name of names.slice(0, 3)) await waitGate(name);
    for (const jobId of ids.slice(3)) await waitJob('queued', undefined, jobId);
    assert.equal(gates.get(names[3]).active, 0, '第四个任务不能提前请求片段');
    assert.equal(gates.get(names[4]).active, 0);
    const taskCount = await worker.evaluate(async () => (await chrome.storage.session.get('jobs')).jobs.length);
    const duplicate = await panel.evaluate(args => chrome.runtime.sendMessage({ type: 'start', ...args }), { tabId, url: `${base}/${names[1]}.m3u8` });
    assert.equal(duplicate.ok, false); assert.match(duplicate.error, /已有|正在|重复/);
    assert.equal(await worker.evaluate(async () => (await chrome.storage.session.get('jobs')).jobs.length), taskCount, '拒绝重复资源不能创建任务');
    await panel.reload();
    for (const jobId of ids) await jobStatus(jobId).waitFor();
    assert.equal(await panel.locator('.status[data-job-id]').count(), 5);
    await panel.locator('#task-overview').waitFor();
    for (const jobId of ids.slice(0, 3)) {
      await jobStatus(jobId).locator('.job-progress').waitFor();
      assert.ok((await jobStatus(jobId).locator('.job-metrics').innerText()).length > 0);
    }
    assert.equal(await panel.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await panel.screenshot({ path: path.join(artifacts, 'concurrent-light.png'), fullPage: true });
    await panel.emulateMedia({ colorScheme: 'dark' });
    await panel.waitForTimeout(300); // let colour transitions settle
    await panel.screenshot({ path: path.join(artifacts, 'concurrent-dark.png'), fullPage: true });
    await panel.emulateMedia({ colorScheme: 'light' });
    const opened = context.waitForEvent('page');
    await panel.getByRole('button', { name: '展开下载面板' }).click();
    const workspace = await opened;
    await workspace.waitForURL(/view=workspace/); await workspace.setViewportSize({ width: 1160, height: 980 });
    for (const jobId of ids) await jobStatus(jobId, workspace).waitFor();
    assert.equal(await workspace.locator('#workspace-open').isVisible(), false);
    assert.equal(await workspace.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    assert.equal(await workspace.locator('main').evaluate(main => main.scrollHeight > main.clientHeight), false, '展开页不能沿用弹窗的内部滚动限制');
    const tasks = workspace.locator('#task-list tbody tr[data-task-id]');
    const filter = name => workspace.locator('.task-filter').filter({ hasText: name });
    assert.equal(await tasks.count(), 5);
    assert.equal(await workspace.locator('#task-overview').isVisible(), false, '展开页用任务列表代替摘要条');
    await filter('排队中').click();
    assert.deepEqual(await tasks.evaluateAll(rows => rows.map(row => row.dataset.taskId).sort()), ids.slice(3).sort());
    await filter('下载中').click();
    assert.equal(await tasks.count(), 3);
    await filter('全部').click();
    await workspace.screenshot({ path: path.join(artifacts, 'workspace-light.png'), fullPage: true });
    await workspace.emulateMedia({ colorScheme: 'dark' });
    await workspace.waitForTimeout(300); // let colour transitions settle
    await workspace.screenshot({ path: path.join(artifacts, 'workspace-dark.png'), fullPage: true });
    await workspace.emulateMedia({ colorScheme: 'light' });
    // Cancel a queued task from the list; the popup card must follow.
    await workspace.locator(`#task-list tr[data-task-id="${ids[4]}"]`).getByRole('button', { name: '取消' }).click();
    await waitJob('cancelled', undefined, ids[4]);
    await workspace.locator(`#task-list tr[data-task-id="${ids[4]}"][data-state="cancelled"]`).waitFor();
    await workspace.close();
    const cancelledCard = row(`${names[4]}.m3u8`);
    await cancelledCard.getByRole('button', { name: '重新下载' }).waitFor();
    assert.equal(await jobStatus(ids[4]).isVisible(), false, '取消后卡片回到版本选择，不再显示状态行');
    await jobStatus(ids[0]).locator('.cancel').click();
    await waitJob('cancelled', undefined, ids[0]);
    await waitGate(names[3]);
    for (const jobId of ids.slice(1, 4)) assert.ok(!['failed', 'cancelled', 'complete'].includes((await getJob(jobId)).state));
    assert.ok(gates.get(names[1]).active && gates.get(names[2]).active, '取消一个任务不能中止其他任务的请求');
    assert.equal(gates.get(names[4]).active, 0, '取消排队任务不能产生片段请求');
    for (const name of names.slice(1, 4)) releaseGate(name);
    for (const jobId of ids.slice(1, 4)) await assertTsOutput(jobId);
    releaseGate(names[0]);
    const retry = await clickDownload(row(`${names[0]}.m3u8`));
    assert.notEqual(retry, ids[0]); await assertTsOutput(retry);
    await waitTempEmpty();
  });
  await check('并发：坏片段只失败本任务，直接文件与 HLS 重叠且可以独立重试', async () => {
    const good = 'concurrent-good', bad = 'concurrent-bad';
    blockGate(good); blockGate(bad, true);
    await discover([good, bad]);
    await player.evaluate(() => fetch('/concurrent-direct.mp4'));
    blockGate('concurrent-direct');
    const before = await worker.evaluate(async () => (await chrome.downloads.search({})).length);
    const goodId = await clickDownload(row(`${good}.m3u8`));
    const badId = await clickDownload(row(`${bad}.m3u8`));
    const directId = await clickDownload(row('concurrent-direct.mp4'));
    for (const name of [good, bad, 'concurrent-direct']) await waitGate(name);
    releaseGate(bad); await waitJob('failed', 'HTTP 404', badId);
    assert.ok(gates.get(good).active && gates.get('concurrent-direct').active, '失败任务不能结束其他 HTTP 请求');
    assert.equal(await worker.evaluate(async () => (await chrome.downloads.search({})).length), before, '坏片段不能保存残缺文件');
    await jobStatus(directId).locator('.cancel').click(); await waitJob('cancelled', undefined, directId);
    assert.ok(gates.get(good).active, '直接文件取消不能影响 HLS');
    releaseGate(good); await assertTsOutput(goodId);
    gates.get(bad).fail = false;
    const retryBad = await clickDownload(row(`${bad}.m3u8`));
    assert.notEqual(retryBad, badId); await assertTsOutput(retryBad);
    releaseGate('concurrent-direct');
    const retryDirect = await clickDownload(row('concurrent-direct.mp4'));
    assert.notEqual(retryDirect, directId);
    const file = await downloaded(retryDirect);
    assert.deepEqual(await readFile(file), await readFile(path.join(fixtures, 'sample.mp4')));
    await waitTempEmpty();
  });
  await check('并发：不同标签页同时下载，其他页提示不阻止本页任务', async () => {
    const first = 'concurrent-page-a', second = 'concurrent-page-b';
    blockGate(first); blockGate(second); await discover([first]);
    const firstId = await clickDownload(row(`${first}.m3u8`)); await waitGate(first);
    const other = await context.newPage();
    const otherPanel = await context.newPage();
    try {
      await other.goto(base + '/?other=concurrent');
      const otherId = await worker.evaluate(async url => (await chrome.tabs.query({})).find(tab => tab.url === url).id, base + '/?other=concurrent');
      await discover([second], other);
      await otherPanel.setViewportSize({ width: 560, height: 600 });
      await otherPanel.goto(`chrome-extension://${id}/popup.html?tab=${otherId}`);
      await otherPanel.locator('#other-job').waitFor();
      assert.equal(await rowIn(otherPanel, `${second}.m3u8`).locator('.download').isEnabled(), true);
      const secondId = await clickDownload(rowIn(otherPanel, `${second}.m3u8`));
      await waitGate(second);
      assert.ok(gates.get(first).active && gates.get(second).active);
      assert.equal(await jobStatus(firstId, otherPanel).count(), 0, '本页面板不应混入其他标签任务');
      await otherPanel.reload(); await jobStatus(secondId, otherPanel).waitFor();
      releaseGate(first); releaseGate(second);
      await assertTsOutput(firstId); await assertTsOutput(secondId, otherPanel);
      await waitTempEmpty();
    } finally { await otherPanel.close(); await other.close(); }
  });
  await check('并发：刚启动就取消，不会晚到重启或遗留临时文件', async () => {
    const name = 'concurrent-immediate-cancel'; blockGate(name); await discover([name]);
    for (let attempt = 0; attempt < 3; attempt++) {
      const id = await clickDownload(row(`${name}.m3u8`));
      const result = await panel.evaluate(id => chrome.runtime.sendMessage({ type: 'cancel', id }), id);
      assert.equal(result.ok, true); await waitJob('cancelled', undefined, id);
      await waitTempEmpty();
      assert.equal((await getJob(id)).state, 'cancelled');
      const downloads = await worker.evaluate(async id => (await chrome.downloads.search({})).filter(download => download.id === id), (await getJob(id)).downloadId ?? -1);
      assert.equal(downloads.length, 0);
    }
  });
  await check('大体积 TS 超过 256 MiB 仍完整转为 MP4、逐帧一致并清理临时磁盘', async () => {
    await player.getByText('请求大体积 TS', { exact: true }).click();
    await clickDownload(row('large.m3u8'));
    panel.setDefaultTimeout(120000);
    await panel.waitForFunction(id => ['complete', 'failed'].includes(document.querySelector(`.status[data-job-id="${id}"]`)?.dataset.state), currentJobId);
    assert.equal(await jobStatus().getAttribute('data-state'), 'complete', await jobStatus().innerText());
    const started = Date.now();
    const filename = await assertTsOutput(currentJobId);
    panel.setDefaultTimeout(15000);
    const inputBytes = largeServed + (await readFile(path.join(fixtures, 'stream1.ts'))).length + (await readFile(path.join(fixtures, 'stream2.ts'))).length;
    assert.ok(inputBytes > 256 * 1024 * 1024, `下载的 TS 必须超过 256 MiB：${inputBytes}`);
    const probe = JSON.parse(execFileSync('ffprobe', ['-v','error','-show_streams','-show_format','-of','json',filename]));
    assert.equal(probe.streams.filter(s => ['video','audio'].includes(s.codec_type)).length, 2);
    assert.ok(Math.abs(Number(probe.format.duration) - 3) < 0.2);
    await waitTempEmpty();
    report.largeTs = { filename, inputBytes, outputBytes: (await readFile(filename)).length, framesIdentical: true, verifyMs: Date.now() - started };
    await panel.screenshot({ path: path.join(artifacts, 'large-ts-complete.png') });
  });
  await check('MP4 无法原样容纳的 TS 编码保留完整原始 TS 并说明原因', async () => {
    await player.evaluate(() => fetch('/mpeg2.m3u8'));
    await clickDownload(row('mpeg2.m3u8'));
    await waitJob('complete', '已保存为原始 TS');
    const job = await getJob();
    const item = await worker.evaluate(async id => (await chrome.downloads.search({ id }))[0], job.downloadId);
    assert.ok(item.filename.endsWith('.ts'), item.filename);
    const segments = (await readFile(path.join(fixtures, 'mpeg2.m3u8'), 'utf8')).split('\n').filter(line => line.endsWith('.ts'));
    assert.deepEqual(await readFile(item.filename), Buffer.concat(await Promise.all(segments.map(name => readFile(path.join(fixtures, name))))));
    assert.ok((await jobStatus().locator('.job-message').innerText()).includes(path.basename(item.filename)), '保留 TS 时也要显示实际文件名');
    await waitTempEmpty();
  });
  await check('转换后时长与清单不一致时保留完整原始 TS', async () => {
    await player.evaluate(() => fetch('/longer.m3u8'));
    await clickDownload(row('longer.m3u8'));
    await waitJob('complete', '时长');
    const item = await worker.evaluate(async id => (await chrome.downloads.search({ id }))[0], (await getJob()).downloadId);
    assert.ok(item.filename.endsWith('.ts'), item.filename);
    assert.deepEqual(await readFile(item.filename), await readFile(tsReference));
    await waitTempEmpty();
  });
  await check('下载完成后可直接打开文件或在文件夹中显示', async () => {
    const card = row('sample.mp4');
    const jobId = await clickDownload(card);
    const filename = await downloaded(jobId);
    const { downloadId } = await getJob(jobId);
    await panel.evaluate(() => {
      // Record calls instead of launching QuickTime or Finder on the test machine.
      window.fileCalls = [];
      chrome.downloads.open = id => { window.fileCalls.push(['open', id]); return Promise.resolve(); };
      chrome.downloads.show = id => { window.fileCalls.push(['show', id]); return true; };
    });
    const status = jobStatus(jobId);
    assert.match(await status.locator('.job-message').innerText(), new RegExp(path.basename(filename).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    await status.getByRole('button', { name: '打开' }).click();
    await status.getByRole('button', { name: '在文件夹中显示' }).click();
    assert.deepEqual(await panel.evaluate(() => window.fileCalls), [['open', downloadId], ['show', downloadId]]);
    assert.equal(await panel.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await status.scrollIntoViewIfNeeded();
    await panel.screenshot({ path: path.join(artifacts, 'open-actions.png') });
    await panel.emulateMedia({ colorScheme: 'dark' });
    await panel.waitForTimeout(300); // let the 0.14 s button color transitions finish
    await panel.screenshot({ path: path.join(artifacts, 'open-actions-dark.png') });
    await panel.emulateMedia({ colorScheme: 'light' });
    await panel.evaluate(() => { chrome.downloads.open = () => Promise.reject(new Error('Download file already deleted')); });
    await status.getByRole('button', { name: '打开' }).click();
    await panel.locator('#error').filter({ hasText: '已被移动或删除' }).waitFor();
  });
  await check('空状态区分“有视频没地址”和“没有视频”，可定位和刷新', async () => {
    const page = await context.newPage();
    const popup = await context.newPage();
    try {
      await page.goto(base + '/no-source.html');
      const pageTab = await worker.evaluate(async url => (await chrome.tabs.query({})).find(tab => tab.url === url).id, base + '/no-source.html');
      await popup.setViewportSize({ width: 560, height: 600 });
      await popup.goto(`chrome-extension://${id}/popup.html?tab=${pageTab}`);
      await popup.getByText('网页上有 1 个视频，还没找到下载地址').waitFor();
      assert.equal(await popup.locator('#task-overview').isVisible(), false, '没有任务时不显示任务总览');
      await popup.screenshot({ path: path.join(artifacts, 'empty-has-video.png') });
      await popup.getByRole('button', { name: '定位到视频' }).click();
      await page.waitForFunction(() => document.querySelector('video').hasAttribute('data-downloader-highlight'));
      await page.evaluate(() => { window.beforeReload = true; });
      await popup.getByRole('button', { name: '刷新网页' }).click();
      await page.waitForFunction(() => !window.beforeReload);
      await page.goto(base + '/missing.html').catch(() => {});
      await popup.getByText('这个网页没有找到视频').waitFor();
      assert.equal(await popup.getByRole('button', { name: '定位到视频' }).isVisible(), false);
      await popup.screenshot({ path: path.join(artifacts, 'empty-no-video.png') });
    } finally { await popup.close(); await page.close(); }
  });
  await check('未对应网页视频的资源默认折叠进“其他资源”，展开状态会被记住', async () => {
    await player.evaluate(() => fetch('/longer.m3u8')); await row('longer.m3u8').waitFor();
    await panel.evaluate(() => localStorage.setItem('otherResourcesOpen', '0')); await panel.reload();
    const other = panel.locator('#other-resources');
    await panel.locator('#other-resources > summary').filter({ hasText: /^其他资源 \d+ 个/ }).waitFor();
    assert.equal(await other.evaluate(node => node.open), false);
    assert.equal(await row('sample.mp4').isVisible(), true, '网页视频卡片不能被折叠');
    assert.equal(await row('longer.m3u8').isVisible(), false);
    await panel.screenshot({ path: path.join(artifacts, 'other-folded.png') });
    await panel.locator('#other-resources > summary').click();
    await row('longer.m3u8').waitFor();
    await panel.reload();
    await row('longer.m3u8').waitFor();
    assert.equal(await other.evaluate(node => node.open), true, '重新打开后保留展开状态');
  });
  await check('下载前显示文件大小；fMP4 预计超过 256 MiB 时提前提示', async () => {
    // Size comes from the observed response headers; this page fetch is seen by webRequest.
    await player.evaluate(() => fetch('/opaque'));
    await row('opaque').locator('.video-meta').filter({ hasText: /· 42\.8 KiB$/ }).waitFor();
    await player.evaluate(() => fetch('/huge-fmp4.m3u8'));
    const card = row('huge-fmp4.m3u8');
    await card.getByRole('button', { name: '读取清晰度' }).click();
    await card.locator('.size-warning').filter({ hasText: '可能超过 fMP4 合并的 256 MiB 上限' }).waitFor();
    assert.match(await card.locator('.video-meta').innerText(), /约 357\.6 MiB$/);
    await card.scrollIntoViewIfNeeded();
    await panel.screenshot({ path: path.join(artifacts, 'size-warning.png') });
  });
  await check('右键视频可直接下载；没有地址时打开面板说明原因', async () => {
    const menu = await worker.evaluate(() => chrome.contextMenus.update('download-video', {}).then(() => true, () => false));
    assert.equal(menu, true, '右键菜单必须已注册');
    const previous = await worker.evaluate(async () => ((await chrome.storage.session.get('jobs')).jobs || []).map(job => job.id));
    await player.locator('video').first().dispatchEvent('contextmenu');
    await worker.evaluate(tabId => downloadFromMenu({ menuItemId: 'download-video', frameId: 0 }, { id: tabId }), tabId);
    const jobs = await worker.evaluate(async () => (await chrome.storage.session.get('jobs')).jobs);
    const created = jobs.filter(job => !previous.includes(job.id));
    assert.equal(created.length, 1); assert.match(created[0].url, /\/sample\.mp4$/);
    const filename = await downloaded(created[0].id);
    assert.deepEqual(await readFile(filename), await readFile(path.join(fixtures, 'sample.mp4')));
    const page = await context.newPage(); const popup = await context.newPage();
    try {
      await page.goto(base + '/no-source.html');
      const pageTab = await worker.evaluate(async url => (await chrome.tabs.query({})).find(tab => tab.url === url).id, base + '/no-source.html');
      await page.locator('video').dispatchEvent('contextmenu');
      await worker.evaluate(tabId => downloadFromMenu({ menuItemId: 'download-video', frameId: 0 }, { id: tabId }), pageTab);
      await popup.goto(`chrome-extension://${id}/popup.html?tab=${pageTab}`);
      await popup.locator('#menu-notice').filter({ hasText: '还没有可下载的地址' }).waitFor();
    } finally { await popup.close(); await page.close(); }
  });
  await check('正式图标已接入扩展管理、工具栏和弹窗，四种 PNG 尺寸正确', async () => {
    const manifest=await worker.evaluate(()=>chrome.runtime.getManifest());
    for (const size of [16,32,48,128]) {
      const filename=manifest.icons[String(size)];
      assert.equal(filename,`icons/icon-${size}.png`);
      const bytes=await readFile(path.join(root,'extension',filename));
      assert.equal(bytes.subarray(0,8).toString('hex'),'89504e470d0a1a0a');
      assert.equal(bytes.readUInt32BE(16),size);assert.equal(bytes.readUInt32BE(20),size);
    }
    assert.equal(manifest.action.default_icon['16'],'icons/icon-16.png');
    assert.equal(manifest.action.default_icon['32'],'icons/icon-32.png');
    await panel.waitForFunction(()=>{const image=document.querySelector('.brand-icon');return image?.complete&&image.naturalWidth===48});
    assert.equal(await panel.locator('.brand-icon').getAttribute('alt'),'');
    assert.equal(await panel.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  });
  await check('封面内嵌预览实际播放视频，关闭后停止请求并返回原卡片', async () => {
    const card = row('sample.mp4');
    const before = await worker.evaluate(async () => (await chrome.downloads.search({})).length);
    await card.getByRole('button', { name: '预览视频' }).click();
    await panel.waitForFunction(() => document.querySelector('#preview-video').currentTime > 0);
    assert.match(await panel.locator('#preview-title').innerText(), /彩色测试片/);
    await panel.screenshot({ path: path.join(artifacts, 'preview.png') });
    await panel.getByRole('button', { name: '关闭预览' }).click();
    assert.equal(await panel.locator('#preview-video').evaluate(video => video.paused && !video.getAttribute('src')), true);
    assert.equal(await card.getByRole('button', { name: '预览视频' }).evaluate(button => button === document.activeElement), true);
    await card.getByRole('button', { name: '预览视频' }).click();
    await panel.keyboard.press('Escape');
    assert.equal(await panel.locator('#preview-video').evaluate(video => video.paused && !video.getAttribute('src')), true);
    assert.equal(await worker.evaluate(async () => (await chrome.downloads.search({})).length), before);
  });
  await check('关闭预览会实际中断未完成的 HTTP 视频请求', async () => {
    await player.getByText('请求慢速文件', { exact: true }).click();
    const before = abortedRequests.length;
    const requested = requests.filter(url => url === '/slow-file.mp4').length;
    await row('slow-file.mp4').getByRole('button', { name: '预览视频' }).click();
    const deadline = Date.now() + 5000;
    while (requests.filter(url => url === '/slow-file.mp4').length <= requested) {
      if (Date.now() > deadline) throw new Error('预览未请求视频');
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    await panel.getByRole('button', { name: '关闭预览' }).click();
    const closed = Date.now() + 1500;
    while (abortedRequests.length === before) {
      if (Date.now() > closed) throw new Error('关闭后视频请求仍在进行');
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.ok(abortedRequests.slice(before).includes('/slow-file.mp4'));
  });
  // Audio and image downloads skip the MP4 stream validation in downloaded().
  async function savedFile(jobId = currentJobId, view = panel) {
    await waitJob('complete', undefined, jobId, view);
    const job = await getJob(jobId);
    const item = await worker.evaluate(async id => (await chrome.downloads.search({ id }))[0], job.downloadId);
    assert.equal(item.state, 'complete');
    assert.ok(item.filename.startsWith(path.join(artifacts, 'downloads')));
    return item.filename;
  }
  async function downloaded(jobId = currentJobId, view = panel) {
    await waitJob('complete', undefined, jobId, view);
    const job = await getJob(jobId);
    const item = await worker.evaluate(async id => (await chrome.downloads.search({ id }))[0], job.downloadId);
    assert.equal(item.state, 'complete');
    const filename = item.filename;
    assert.ok(filename.startsWith(path.join(artifacts, 'downloads')));
    assert.ok(/\.(mp4|ts|webm)$/.test(filename), `下载文件名不正确：${filename}`);
    const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', filename]));
    assert.ok(probe.streams.some(s => s.codec_type === 'video'));
    assert.ok(probe.streams.some(s => s.codec_type === 'audio'));
    assert.ok(Number(probe.format.duration) >= 2.9);
    execFileSync('ffmpeg', ['-v', 'error', '-i', filename, '-f', 'null', '-']);
    return filename;
  }
  await check('视频卡片显示真实封面、标题、时长与尺寸，封面可定位原视频', async () => {
    const card = row('sample.mp4');
    await card.locator('.video-title').filter({ hasText: '彩色测试片 · 完整音画' }).waitFor();
    await card.locator('.thumbnail img').waitFor();
    assert.equal(await card.locator('.thumbnail img').evaluate(i => i.complete && i.naturalWidth > 0), true);
    assert.match(await card.locator('.duration').innerText(), /0:03/);
    assert.match(await card.locator('.video-meta').innerText(), /^160 × 90/);
    await card.getByRole('button', { name: '资源信息' }).click();
    await card.getByRole('button', { name: '定位到网页视频' }).click();
    await card.getByRole('button', { name: '资源信息' }).click();
    assert.equal(await card.locator('.technical').isVisible(), false);
    await player.waitForFunction(() => document.querySelector('video').hasAttribute('data-downloader-highlight'));
  });
  await check('初始化音轨不能冒充完整 MP4，也不能显示下载完成', async () => {
    await player.getByText('请求伪完整 MP4', { exact: true }).click();
    const before = await worker.evaluate(async () => (await chrome.downloads.search({})).length);
    await clickDownload(row('opaque-init.mp4'));
    await waitJob('failed', '完整视频');
    assert.equal(await worker.evaluate(async () => (await chrome.downloads.search({})).length), before);
  });
  await check('分离 fMP4 音画下载所有片段并封装成完整 MP4', async () => {
    await player.getByText('请求完整分片视频', { exact: true }).click();
    const card = row('fmp4-master.m3u8');
    await card.getByRole('button', { name: '读取清晰度' }).click();
    await chooseVersion(card, '90p · MP4');
    await clickDownload(card);
    const file = await downloaded(); assert.ok(file.endsWith('.mp4'));
    const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-count_frames', '-show_streams', '-show_format', '-of', 'json', file]));
    assert.equal(Number(probe.streams.find(s => s.codec_type === 'video').nb_read_frames), 75);
    assert.ok(Number(probe.format.duration) < 3.2);
    for (const name of ['v0.m4s','v1.m4s','v2.m4s','a0.m4s']) assert.ok(requests.includes('/'+name));
    const boxes = await readFile(file); assert.ok(!boxes.includes(Buffer.from('moof')), '输出必须是普通 MP4，而不是只拼接碎片');
  });
  await check('音频分片缺失时停止，不保存无声或残缺 MP4', async () => {
    await player.getByText('请求缺失音频分片', { exact: true }).click();
    const before = await worker.evaluate(async () => (await chrome.downloads.search({})).length);
    await clickDownload(row('fmp4-broken.m3u8')); await waitJob('failed', 'HTTP 404');
    assert.equal(await worker.evaluate(async () => (await chrome.downloads.search({})).length), before);
  });
  await check('清单随后返回 HTTP 403 时明确失败，不假装完成或保存空文件', async () => {
    await player.getByText('请求随后过期的清单', { exact: true }).click();
    const before = await worker.evaluate(async () => (await chrome.downloads.search({})).length);
    await clickDownload(row('expired.m3u8'));
    await waitJob('failed', 'HTTP 403');
    assert.equal(await worker.evaluate(async () => (await chrome.downloads.search({})).length), before);
    await row('expired.m3u8').scrollIntoViewIfNeeded();
    await panel.screenshot({ path: path.join(artifacts, 'failed-403.png') });
  });
  await check('展开面板按状态筛选任务，失败行写明原因和建议，完成行可打开', async () => {
    const workspace = await context.newPage();
    try {
      await workspace.setViewportSize({ width: 1160, height: 900 });
      await workspace.goto(`chrome-extension://${id}/popup.html?tab=${tabId}&view=workspace`);
      const filter = name => workspace.locator('.task-filter').filter({ hasText: name });
      await filter('失败').click();
      const failed = workspace.locator('#task-list tbody tr[data-task-id]').filter({ hasText: 'expired.m3u8' });
      await failed.getByRole('button', { name: '重试' }).waitFor();
      assert.match(await workspace.locator('#task-list .task-error').filter({ hasText: 'HTTP 403' }).innerText(), /回到网页重新播放/);
      assert.equal(await workspace.locator('#task-list tbody tr[data-state="complete"]').count(), 0);
      const badJobs = (await worker.evaluate(async () => (await chrome.storage.session.get('jobs')).jobs)).filter(job => job.resourceUrl?.endsWith('concurrent-bad.m3u8'));
      assert.ok(badJobs.some(job => job.state === 'failed') && badJobs.at(-1).state === 'complete', '前提：concurrent-bad 先失败后重试成功');
      assert.equal(await workspace.locator('#task-list tbody tr[data-task-id]').filter({ hasText: 'concurrent-bad' }).count(), 0, '重试成功后不再列出旧的失败任务');
      // Retry from the list starts a new task for the same resource and replaces the failed row.
      const failedId = await failed.getAttribute('data-task-id');
      await failed.getByRole('button', { name: '重试' }).click();
      await workspace.waitForFunction(async failedId => {
        const jobs = (await chrome.storage.session.get('jobs')).jobs;
        return jobs.at(-1).id !== failedId && jobs.at(-1).resourceUrl.endsWith('expired.m3u8') && ['failed', 'complete'].includes(jobs.at(-1).state);
      }, failedId);
      await workspace.locator(`#task-list tr[data-task-id="${failedId}"]`).waitFor({ state: 'detached' });
      await workspace.screenshot({ path: path.join(artifacts, 'workspace-failed.png'), fullPage: true });
      await filter('已完成').click();
      assert.ok(await workspace.locator('#task-list tbody tr[data-task-id]').count() > 0);
      assert.equal(await workspace.locator('#task-list tbody tr[data-task-id]:not([data-state="complete"])').count(), 0);
      await workspace.locator('#task-list tbody tr').first().getByRole('button', { name: '打开' }).waitFor();
    } finally { await workspace.close(); }
  });
  await check('播放后识别 MP4，下载内容与源文件完全一致并可解码', async () => {
    await clickDownload(row('sample.mp4'));
    const filename = await downloaded();
    assert.deepEqual(await readFile(filename), await readFile(path.join(fixtures, 'sample.mp4')));
  });
  await check('WebM 原文件仍可下载，名称含 mp4 不会误判', async () => {
    await player.getByText('请求 WebM', { exact: true }).click();
    await clickDownload(row('mp4-demo.webm'));
    const file = await downloaded();
    assert.deepEqual(await readFile(file), await readFile(path.join(fixtures,'mp4-demo.webm')));
  });
  await check('HLS 主清单解析、按顺序下载片段，输出包含完整音画', async () => {
    await player.getByText('请求 HLS', { exact: true }).click();
    await clickDownload(row('master.m3u8'));
    await downloaded();
  });
  await panel.locator('body').screenshot({ path: path.join(artifacts, 'popup.png') });
  await check('HLS 清晰度来自真实清单，手动选择后下载对应版本', async () => {
    await player.getByText('请求 HLS', { exact: true }).click();
    const card = row('master.m3u8');
    await revealActions(card);
    await card.getByRole('button', { name: '读取清晰度' }).click();
    const select = card.getByRole('combobox', { name: '下载版本' });
    await select.click();
    await card.getByRole('option', { name: '46p · MP4', exact: true }).waitFor();
    const bounds = await card.locator('.version-menu').boundingBox();
    assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 560 && bounds.y >= 0 && bounds.y + bounds.height <= 600);
    await panel.locator('body').screenshot({ path: path.join(artifacts, 'quality-menu.png') });
    await panel.keyboard.press('End'); await panel.keyboard.press('Enter');
    assert.equal(await select.getAttribute('aria-expanded'), 'false');
    assert.match(await select.innerText(), /46p/);
    await select.click(); await panel.keyboard.press('Escape');
    assert.equal(await select.evaluate(button => button === document.activeElement), true);
    await select.click(); await card.locator('.video-title').click();
    assert.equal(await select.getAttribute('aria-expanded'), 'false');
    const before = requests.length;
    await clickDownload(card);
    const file = await downloaded();
    const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', file]));
    assert.equal(probe.streams.find(stream => stream.codec_type === 'video').height, 46);
    await panel.reload();
    await revealActions(row('master.m3u8'));
    assert.match(await row('master.m3u8').getByRole('combobox', { name: '下载版本' }).innerText(), /46p/, '重开后不能把已下载版本误显示为最高版本');
    assert.ok(requests.slice(before).includes('/low.m3u8'));
    assert.ok(!requests.slice(before).includes('/stream.m3u8'));
  });
  await check('HLS 按钮进度来自已下载片段，等待时不伪造推进', async () => {
    await player.getByText('请求进度视频', { exact: true }).click();
    const card = row('progress.m3u8');
    await clickDownload(card); await waitJob('fetching');
    await panel.waitForFunction(() => document.querySelector('.status[data-progress-source="segments"]')?.dataset.progress === '33');
    const state = await getJob();
    assert.equal(state.done, 1); assert.equal(state.total, 3);
    assert.match(await card.locator('.status .job-title').innerText(), /下载中 33%/);
    assert.equal(await card.locator('.download').isVisible(), false, '进度只在状态行显示一次');
    await panel.locator('body').screenshot({ path: path.join(artifacts, 'hls-progress.png') });
    await downloaded();
    assert.equal(await card.locator('.download').isVisible(), false);
    await card.getByRole('button', { name: '更多操作' }).click();
    await card.getByRole('button', { name: '再次下载' }).waitFor();
  });
  for (const [request, name, known] of [['请求慢速文件','slow-file.mp4',true], ['请求未知大小文件','unknown-size.mp4',false]]) {
    await check(`直接文件按钮使用真实字节进度：${known ? '已知大小' : '未知大小不显示假百分比'}`, async () => {
      await player.getByText(request, { exact: true }).click();
      const card = row(name);
      await clickDownload(card); await waitJob('saving');
      if (known) {
        await panel.waitForFunction(() => Number(document.querySelector('.status[data-progress-source="bytes"]')?.dataset.progress) > 0);
        const info = await worker.evaluate(async id => (await chrome.downloads.search({ id }))[0], (await getJob()).downloadId);
        assert.equal(info.totalBytes, (await readFile(path.join(fixtures, 'sample.mp4'))).length);
        const fraction = Number(await card.locator('.status').getAttribute('data-progress'));
        assert.ok(fraction <= Math.round(info.bytesReceived / info.totalBytes * 100));
      } else {
        await panel.waitForFunction(() => document.querySelector('.status[data-progress-source="unknown"]'));
        assert.ok(!(await card.locator('.status .job-title').innerText()).includes('%'));
      }
      await downloaded();
    });
  }
  await check('关闭并重开面板后仍显示完成状态', async () => {
    await panel.reload(); await waitJob('complete');
  });
  await check('循环清单读取后仍有下载选项，并明确失败而不保存文件', async () => {
    await player.getByText('请求循环清单', { exact: true }).click();
    const card = row('loop.m3u8');
    await card.getByRole('button', { name: '读取清晰度' }).click();
    await card.getByRole('combobox', { name: '下载版本' }).click();
    await card.getByRole('option').last().waitFor();
    await panel.keyboard.press('Escape');
    const before = await worker.evaluate(async () => (await chrome.downloads.search({})).length);
    await clickDownload(card);
    await waitJob('failed', '循环引用');
    assert.equal(await worker.evaluate(async () => (await chrome.downloads.search({})).length), before);
  });
  for (const [button, resource, message] of [
    ['请求加密视频', 'encrypted.m3u8', '加密'],
    ['请求直播', 'live.m3u8', '直播'],
    ['请求错误片段', 'broken.m3u8', 'HTTP 404'],
    ['请求分离音轨', 'split.m3u8', '独立音轨'],
    ['请求 fMP4', 'map.m3u8', 'HTTP 404'],
    ['请求伪视频片段', 'fake.m3u8', 'MPEG-TS'],
    ['请求不完整 TS', 'incomplete.m3u8', 'MPEG-TS'],
    ['请求截断大文件', 'huge.m3u8', ''],
  ]) {
    await check(`${button}明确失败且不保存残缺文件`, async () => {
      const before = await worker.evaluate(async () => (await chrome.downloads.search({})).length);
      await player.getByText(button, { exact: true }).click();
      await clickDownload(row(resource));
      await waitJob('failed', message);
      await waitTempEmpty();
      assert.equal(await row(resource).locator('.status').isVisible(), true);
      assert.equal(await row(resource).locator('.next-step').isVisible(), true);
      await row(resource).getByRole('button', { name: '重试下载' }).waitFor();
      assert.equal(await worker.evaluate(async () => (await chrome.downloads.search({})).length), before);
    });
  }
  await check('取消 HLS 下载会停止任务，不保存文件', async () => {
    const before = await worker.evaluate(async () => (await chrome.downloads.search({})).length);
    await player.getByText('请求慢速视频', { exact: true }).click();
    await clickDownload(row('slow.m3u8'));
    await waitJob('fetching');
    await jobStatus().getByRole('button', { name: '取消', exact: true }).click();
    await waitJob('cancelled');
    await waitTempEmpty();
    assert.equal(await worker.evaluate(async () => (await chrome.downloads.search({})).length), before);
  });
  await check('取消后可以重新下载 HLS，不遗留忙碌状态', async () => {
    await clickDownload(row('master.m3u8'));
    await downloaded();
  });
  await check('DASH 清单可识别，但不能误下载为视频', async () => {
    await player.getByText('请求 DASH', { exact: true }).click();
    await row('clip.mpd').waitFor();
    assert.equal(await row('clip.mpd').getByRole('button', { name: '下载', exact: true }).isDisabled(), true);
  });
  await check('另一标签页不会显示当前页资源', async () => {
    const other = await context.newPage(); await other.goto(base + '/missing.html').catch(() => {});
    const otherId = await worker.evaluate(async url => (await chrome.tabs.query({})).find(t => t.url === url).id, base + '/missing.html');
    const empty = await context.newPage(); await empty.goto(`chrome-extension://${id}/popup.html?tab=${otherId}`);
    await empty.getByText('这个网页没有找到视频').waitFor(); assert.equal(await empty.locator('article').count(), 0);
    assert.equal(await empty.locator('.status').count(), 0);
    await empty.close(); await other.close();
  });
  await check('加密检测不会请求密钥，也不把片段列为完整视频', async () => {
    assert.ok(!requests.includes('/secret.key'));
    assert.equal(await panel.locator('article').filter({ hasText: 'stream0.ts' }).count(), 0);
  });
  await check('没有文件后缀的 MP4 通过响应类型识别并保存正确文件名', async () => {
    await player.getByText('请求无后缀视频', { exact: true }).click();
    await clickDownload(row('opaque'));
    const filename = await downloaded(); assert.match(path.basename(filename), /^opaque(?: \(\d+\))?\.mp4$/);
  });
  await panel.locator('body').screenshot({ path: path.join(artifacts, 'edge-cases.png') });
  await check('网页导航后清空旧视频资源', async () => {
    await player.goto(base + '/missing.html').catch(() => {});
    await panel.getByText('这个网页没有找到视频').waitFor();
    assert.equal(await panel.locator('article').count(), 0);
  });
  await check('预览地址失效显示原因，能关闭并返回网页，不产生下载', async () => {
    await player.goto(base + '/preview-failure.html'); await panel.reload();
    const card = row('missing.mp4');
    await card.getByRole('button', { name: '预览视频' }).click();
    await panel.locator('#preview-error').waitFor();
    assert.match(await panel.locator('#preview-error').innerText(), /预览/);
    await panel.getByRole('button', { name: '关闭预览' }).click();
    assert.equal(await panel.locator('#preview-video').evaluate(video => !video.getAttribute('src')), true);
  });
  await check('同页两个视频分别匹配，缺少封面不伪造，重命名实际影响下载文件', async () => {
    await player.goto(base + '/gallery.html');
    await panel.reload();
    const first = panel.locator('article').filter({ has: panel.locator('.resource-url', { hasText: 'clip=1' }) });
    const second = panel.locator('article').filter({ hasText: '第二段 · 完整音画' });
    await first.locator('.thumbnail img').waitFor();
    await second.locator('.video-title').waitFor();
    assert.equal(await panel.locator('article').count(), 2);
    assert.equal(await second.locator('.thumbnail img').count(), 0);
    assert.match(await second.locator('.thumbnail').innerText(), /暂无封面/);
    await first.getByRole('button', { name: '修改文件名' }).click();
    await first.getByRole('textbox', { name: '文件名' }).fill('我的测试视频');
    await first.getByRole('button', { name: '保存名称' }).click();
    await first.locator('.video-title').filter({ hasText: '我的测试视频' }).waitFor();
    await clickDownload(first);
    const filename = await downloaded(); assert.match(path.basename(filename), /^我的测试视频.*\.mp4$/);
    await panel.evaluate(() => scrollTo(0, 0));
    await panel.locator('body').screenshot({ path: path.join(artifacts, 'video-cards.png') });
    await panel.emulateMedia({ colorScheme: 'dark' });
    await panel.locator('body').screenshot({ path: path.join(artifacts, 'video-cards-dark.png') });
    assert.equal(await panel.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await panel.emulateMedia({ colorScheme: 'light' });
    await first.getByRole('button', { name: '修改文件名' }).click();
    await first.getByRole('textbox', { name: '文件名' }).fill('我的测试视频.webm');
    await first.getByRole('button', { name: '保存名称' }).click();
    await first.locator('.video-title').filter({ hasText: '我的测试视频.webm' }).waitFor();
    await clickDownload(first);
    const renamed = await downloaded();
    assert.match((await getJob()).filename, /\.mp4$/, '传给下载管理器的后缀也必须正确');
    assert.match(path.basename(renamed), /^我的测试视频(?: \(\d+\))?\.mp4$/, '重命名不能伪造文件格式');
  });
  await check('X 风格媒体 ID 模拟：同视频归组，不混用其他视频封面', async () => {
    await context.route('https://pbs.twimg.com/**', route => route.fulfill({ contentType: 'image/jpeg', path: path.join(fixtures, 'poster.jpg') }));
    await context.route('https://video.twimg.com/**', async route => route.fulfill({
      contentType: route.request().url().endsWith('.mp4') ? 'video/mp4' : route.request().url().endsWith('.mpd') ? 'application/dash+xml' : 'application/vnd.apple.mpegurl',
      headers: { 'Access-Control-Allow-Origin': '*' }, body: route.request().url().endsWith('.mp4') ? await readFile(path.join(fixtures,'a-init.mp4')) : route.request().url().endsWith('.mpd') ? '<MPD/>' : playlist,
    }));
    await player.goto(base + '/x-fixture.html');
    // DevTools response fulfillment is not the browser's real webRequest
    // pipeline when extraHeaders is observed. This test is a grouping fixture,
    // not a network-detection test; real detection is covered by HTTP fixtures.
    await panel.waitForFunction(async tabId => (await chrome.storage.session.get(`media:${tabId}`))[`media:${tabId}`]?.length === 2,tabId);
    await panel.evaluate(async tabId => {
      const {matchMedia}=await import(chrome.runtime.getURL('resources.js'));
      const players=(await chrome.storage.session.get(`media:${tabId}`))[`media:${tabId}`];
      const urls=['1111/pu/pl/master.m3u8','1111/pu/pl/variant.m3u8','1111/pu/pl/manifest.mpd','2222/pu/pl/master.m3u8','3333/pu/pl/unmatched.m3u8'];
      const items=urls.map(suffix=>{const url=`https://video.twimg.com/ext_tw_video/${suffix}`;return {url,name:url.split('/').pop(),kind:url.endsWith('.mpd')?'dash':'hls',media:matchMedia({url},players),source:'验收夹具：已知媒体地址'}});
      await chrome.storage.session.set({[`tab:${tabId}`]:items});
    },tabId);
    await panel.reload();
    const first = panel.locator('article').filter({ hasText: '第一条帖子的视频' });
    const second = panel.locator('article').filter({ hasText: '第二条帖子的视频' });
    await first.locator('.thumbnail img').waitFor();
    await second.locator('.thumbnail img').waitFor();
    assert.equal(await panel.locator('article').count(), 3);
    assert.equal(await first.locator('.resource-name').count(), 3);
    await first.getByRole('combobox', { name: '下载版本' }).click();
    assert.equal(await first.getByRole('option', { name: 'DASH · 暂不支持 · manifest.mpd', exact: true }).isDisabled(), true);
    await panel.keyboard.press('Escape');
    assert.match(await first.locator('.thumbnail img').getAttribute('src'), /1111/);
    assert.match(await second.locator('.thumbnail img').getAttribute('src'), /2222/);
    assert.equal(await row('unmatched.m3u8').locator('.thumbnail img').count(), 0);
    await first.getByRole('button', { name: '定位到网页视频' }).click();
    await player.waitForFunction(() => document.querySelector('video').hasAttribute('data-downloader-highlight'));
    await panel.locator('body').screenshot({ path: path.join(artifacts, 'x-id-fixture.png') });
  });
  await check('同组选第二个文件下载，文件名仍与卡片标题一致', async () => {
    await player.goto(base + '/x-fixture.html');
    await panel.evaluate(async tabId => {
      const urls=['first-name.mp4','second-name.mp4'].map(name=>`https://video.twimg.com/ext_tw_video/4444/pu/vid/${name}`);
      await chrome.storage.session.set({[`tab:${tabId}`]:urls.map(url=>({url,name:url.split('/').pop(),kind:'file',mime:'video/mp4',source:'验收夹具：同组文件'}))});
    },tabId);
    await panel.reload();
    const card = panel.locator('article').filter({ hasText: 'second-name.mp4' });
    assert.equal(await card.locator('.video-title').textContent(), 'first-name.mp4');
    await card.getByRole('combobox', { name: '下载版本' }).click();
    await card.getByRole('option', { name: 'MP4 · second-name.mp4', exact: true }).click();
    await card.getByRole('button', { name: '下载', exact: true }).click();
    const job = await panel.waitForFunction(async () => (await chrome.storage.session.get('jobs')).jobs?.find(job => job.resourceUrl?.endsWith('second-name.mp4'))).then(handle => handle.jsonValue());
    assert.equal(job.filename, 'VideoDownloads/first-name.mp4');
    await panel.waitForFunction(async id => ['complete','failed','cancelled'].includes((await chrome.storage.session.get('jobs')).jobs.find(job => job.id === id).state), job.id);
  });
  await check('抖音页面数据匹配：标题封面绑定播放器，签名变体与音画轨道归同一张卡', async () => {
    await player.goto(base + '/douyin-fixture.html');
    const card = panel.locator('#resources article').filter({ hasText: '抖音夹具视频 · 访谈节目' });
    await card.locator('.thumbnail img').waitFor();
    assert.match(await card.locator('.thumbnail img').getAttribute('src'), /poster\.jpg/);
    assert.match(await card.locator('.duration').innerText(), /0:03/);
    await card.getByRole('button', { name: '资源信息' }).click();
    assert.equal(await card.locator('.resource-name').count(), 6, '网页地址加去重后的轨道地址');
    assert.match(await card.locator('.meta-line').innerText(), /×/);
    assert.match(await card.locator('.version-trigger').innerText(), /MP4/);
    await card.getByRole('combobox', { name: '下载版本' }).click();
    assert.equal(await card.getByRole('option', { name: 'MP4 · 视频轨 AVC1 326k', exact: true }).count(), 1);
    assert.equal(await card.getByRole('option', { name: 'MP4 · 视频轨 AVC1 222k', exact: true }).count(), 1);
    assert.equal(await card.getByRole('option', { name: 'MP4 · 视频轨 HVC1 162k', exact: true }).count(), 1);
    assert.equal(await card.getByRole('option', { name: 'MP4 · 音频轨 53k', exact: true }).count(), 1);
    assert.equal(await card.getByRole('option', { name: 'MP4 · 音频轨 189k', exact: true }).count(), 1);
    await panel.keyboard.press('Escape');
    // Same media file under a different signature must land on the same card.
    await player.evaluate(() => fetch('/dy-cdn/fresh-sig/6ae5ffff/video/tos/cn/tos-cn-vd-0026/oAAA111/media-video-avc1/?br=999'));
    await card.locator('.resource-name').nth(6).waitFor({ state: 'attached' });
    assert.equal(await panel.locator('#resources article').count(), 1);
    // Tracks of a file the page data does not know still group together, marked as unmatched.
    await player.evaluate(() => Promise.all([
      fetch('/dy-cdn/sig-x/1/video/tos/cn/tos-cn-ve-15/oZZZ999/media-video-avc1/?br=10'),
      fetch('/dy-cdn/sig-y/2/video/tos/cn/tos-cn-ve-15/oZZZ999/media-audio-und-mp4a/?br=10')]));
    const other = panel.locator('#other-list article');
    await other.locator('.resource-name').nth(1).waitFor({ state: 'attached' });
    assert.equal(await other.count(), 1);
    assert.match(await other.locator('.video-title').innerText(), /视频轨 AVC1/);
    assert.match(await panel.locator('#count').innerText(), /1 个媒体 · 1 组未匹配资源/);
    await card.getByRole('button', { name: '预览视频' }).click();
    await panel.waitForFunction(() => document.querySelector('#preview-video').currentTime > 0);
    assert.match(await panel.locator('#preview-title').innerText(), /抖音夹具视频/);
    await panel.getByRole('button', { name: '关闭预览' }).click();
    await chooseVersion(card, 'MP4 · 视频轨 HVC1 162k');
    await clickDownload(card);
    const saved = await downloaded();
    assert.match(path.basename(saved), /^抖音夹具视频 · 访谈节目.*\.mp4$/);
    await panel.locator('body').screenshot({ path: path.join(artifacts, 'douyin-card.png') });
  });
  await check('B站页面数据匹配：playinfo 绑定播放器，镜像去重，轨道可读命名', async () => {
    await player.goto(base + '/bili-fixture.html');
    const card = panel.locator('#resources article').filter({ hasText: 'B站夹具视频 · 芯片横评' });
    await card.locator('.thumbnail img').waitFor();
    assert.match(await card.locator('.thumbnail img').getAttribute('src'), /poster\.jpg/);
    assert.match(await card.locator('.duration').innerText(), /0:03/);
    await card.getByRole('button', { name: '资源信息' }).click();
    assert.equal(await card.locator('.resource-name').count(), 5, '网页地址加去重后的四条轨道');
    await card.getByRole('combobox', { name: '下载版本' }).click();
    assert.equal(await card.getByRole('option', { name: 'MP4 · 视频轨 1080P', exact: true }).count(), 1);
    assert.equal(await card.getByRole('option', { name: 'MP4 · 视频轨 1080P HEVC', exact: true }).count(), 1);
    assert.equal(await card.getByRole('option', { name: 'MP4 · 视频轨 480P', exact: true }).count(), 1);
    assert.equal(await card.getByRole('option', { name: 'MP4 · 音频轨 66k', exact: true }).count(), 1);
    await panel.keyboard.press('Escape');
    // Same media id under a different signature must land on the same card
    // and reuse the page-provided label instead of a duplicate option.
    await player.evaluate(() => fetch('/bili-cdn/fresh/upgcxcode/99/88/555000111/555000111-1-30032.m4s?e=zzz'));
    await card.locator('.resource-name').nth(5).waitFor({ state: 'attached' });
    assert.equal(await panel.locator('#resources article').count(), 1);
    await card.getByRole('combobox', { name: '下载版本' }).click();
    assert.equal(await card.getByRole('option', { name: 'MP4 · 视频轨 480P', exact: true }).count(), 1);
    await panel.keyboard.press('Escape');
    // A media id the page data does not know groups separately, named by its track code.
    await player.evaluate(() => Promise.all([
      fetch('/bili-cdn/a/upgcxcode/1/2/777000999/777000999-1-30032.m4s?e=a'),
      fetch('/bili-cdn/b/upgcxcode/3/4/777000999/777000999-1-30216.m4s?e=b')]));
    const other = panel.locator('#other-list article');
    await other.locator('.resource-name').nth(1).waitFor({ state: 'attached' });
    assert.equal(await other.count(), 1);
    assert.match(await other.locator('.video-title').innerText(), /视频轨 480P/);
    await card.getByRole('button', { name: '预览视频' }).click();
    await panel.waitForFunction(() => document.querySelector('#preview-video').currentTime > 0);
    assert.match(await panel.locator('#preview-title').innerText(), /芯片横评/);
    await panel.getByRole('button', { name: '关闭预览' }).click();
    await chooseVersion(card, 'MP4 · 视频轨 480P');
    await clickDownload(card);
    const saved = await downloaded();
    assert.match(path.basename(saved), /^B站夹具视频 · 芯片横评.*\.mp4$/);
  });
  await check('小红书页面数据匹配：INITIAL_STATE 绑定播放器，多编码流归同一张卡', async () => {
    await player.goto(base + '/xhs-fixture.html');
    const card = panel.locator('#resources article').filter({ hasText: '小红书夹具视频 · 收纳技巧' });
    await card.locator('.thumbnail img').waitFor();
    assert.match(await card.locator('.thumbnail img').getAttribute('src'), /poster\.jpg/);
    assert.match(await card.locator('.duration').innerText(), /0:03/);
    await card.getByRole('button', { name: '资源信息' }).click();
    assert.equal(await card.locator('.resource-name').count(), 3, '网页地址加去重后的两条流');
    await card.getByRole('combobox', { name: '下载版本' }).click();
    assert.equal(await card.getByRole('option', { name: 'MP4 · 720P', exact: true }).count(), 1);
    assert.equal(await card.getByRole('option', { name: 'MP4 · 1080P', exact: true }).count(), 1);
    await panel.keyboard.press('Escape');
    await card.getByRole('button', { name: '预览视频' }).click();
    await panel.waitForFunction(() => document.querySelector('#preview-video').currentTime > 0);
    assert.match(await panel.locator('#preview-title').innerText(), /收纳技巧/);
    await panel.getByRole('button', { name: '关闭预览' }).click();
    await chooseVersion(card, 'MP4 · 720P');
    await clickDownload(card);
    const saved = await downloaded();
    assert.match(path.basename(saved), /^小红书夹具视频 · 收纳技巧.*\.mp4$/);
  });
  await check('音频页面：audio 元素绑定音频文件，可预览并直接下载为 mp3', async () => {
    await player.goto(base + '/audio-fixture.html');
    const card = panel.locator('#resources article').filter({ hasText: '夹具音频 · 夜航钢琴' });
    await card.locator('.duration').waitFor({ state: 'attached' });
    assert.match(await card.locator('.duration').innerText(), /^0:0\d$/);
    await card.getByRole('button', { name: '资源信息' }).click();
    assert.equal(await card.locator('.resource-name').count(), 1);
    assert.doesNotMatch(await card.locator('.meta-line').innerText(), /尺寸未知/);
    assert.match(await card.locator('.version-trigger').innerText(), /MP3/);
    // A bare audio/* response with no suffix is caught by MIME and lands in 其他资源.
    const other = panel.locator('#other-list article');
    await other.locator('.resource-name').filter({ hasText: 'audio-stream' }).waitFor({ state: 'attached' });
    assert.equal(await other.count(), 1);
    await card.getByRole('button', { name: '预览视频' }).click();
    await panel.waitForFunction(() => document.querySelector('#preview-video').currentTime > 0);
    await panel.getByRole('button', { name: '关闭预览' }).click();
    await clickDownload(card);
    const file = await savedFile();
    assert.match(path.basename(file), /^夹具音频 · 夜航钢琴.*\.mp3$/);
    assert.deepEqual(await readFile(file), await readFile(path.join(fixtures, 'music.mp3')));
  });
  await check('图片页面：大图可预览下载，图标级小图被过滤', async () => {
    await player.goto(base + '/image-fixture.html');
    // No player on the page, so the images list directly instead of folding away.
    const cards = panel.locator('#resources article');
    await cards.locator('.resource-name').filter({ hasText: 'photo-stream' }).waitFor({ state: 'attached' });
    assert.equal(await cards.count(), 2, 'photo.jpg 与 photo-stream 各成一组，icon.png 被过滤');
    const photo = cards.filter({ hasText: 'photo.jpg' });
    const stream = cards.filter({ hasText: 'photo-stream' });
    await photo.locator('.thumbnail img').waitFor();
    assert.match(await photo.locator('.version-trigger').innerText(), /JPG/);
    assert.match(await stream.locator('.version-trigger').innerText(), /JPG/);
    await photo.getByRole('button', { name: '预览视频' }).click();
    await panel.waitForFunction(() => !document.querySelector('#preview-image').hidden &&
      document.querySelector('#preview-image').naturalWidth > 0);
    assert.ok(await panel.evaluate(() => document.querySelector('#preview-video').hidden));
    assert.match(await panel.locator('#preview-title').innerText(), /photo\.jpg/);
    await panel.getByRole('button', { name: '关闭预览' }).click();
    await clickDownload(stream);
    const file = await savedFile();
    assert.match(path.basename(file), /photo-stream( \(\d+\))?\.jpg$/);
    assert.deepEqual(await readFile(file), await readFile(path.join(fixtures, 'photo.jpg')));
  });
  await check('小红书图文笔记：imageList 合成图片卡，每图可预览并按图命名', async () => {
    await player.goto(base + '/xhs-image-fixture.html');
    const card = panel.locator('#resources article').filter({ hasText: '小红书图文夹具 · 城市漫步' });
    await card.locator('.thumbnail img').waitFor();
    assert.match(await card.locator('.thumbnail img').getAttribute('src'), /note-img1\.jpg/);
    assert.match(await card.locator('.meta-line').innerText(), /3 张图/);
    await card.getByRole('button', { name: '资源信息' }).click();
    assert.equal(await card.locator('.resource-name').count(), 9, '三张图各三个变体地址全部归组');
    await card.getByRole('combobox', { name: '下载版本' }).click();
    for (const n of [1, 2, 3])
      assert.equal(await card.getByRole('option', { name: `JPG · 图片 ${n}`, exact: true }).count(), 1);
    await panel.keyboard.press('Escape');
    await card.getByRole('button', { name: '预览视频' }).click();
    await panel.waitForFunction(() => !document.querySelector('#preview-image').hidden &&
      document.querySelector('#preview-image').naturalWidth > 0);
    assert.match(await panel.locator('#preview-title').innerText(), /城市漫步/);
    assert.match(await panel.locator('.preview-subtitle').innerText(), /图片预览 · 图片 1/);
    await panel.getByRole('button', { name: '关闭预览' }).click();
    await chooseVersion(card, 'JPG · 图片 2');
    await clickDownload(card);
    const file = await savedFile();
    assert.match(path.basename(file), /图片 2( \(\d+\))?\.jpg$/);
  });
  await check('站内切页：只列出新视频，丢弃旧请求迟到响应，下载新文件并支持后退', async () => {
    await player.goto(base + '/spa.html');
    await row('old.mp4').waitFor();
    await player.getByText('切到新视频', { exact: true }).click();
    await player.waitForFunction(()=>window.oldRequestDone);
    await row('new.mp4').waitFor();
    assert.deepEqual(await panel.locator('.resource-name').allTextContents(), ['new.mp4']);
    await panel.locator('#page-name').filter({hasText:'新页面'}).waitFor();
    await row('new.mp4').locator('.video-title').filter({hasText:'新视频'}).waitFor();
    await clickDownload(row('new.mp4'));
    const filename=await downloaded();
    assert.deepEqual(await readFile(filename),await readFile(path.join(fixtures,'new.mp4')));
    const probe=JSON.parse(execFileSync('ffprobe',['-v','error','-show_streams','-of','json',filename]));
    assert.equal(probe.streams.find(stream=>stream.codec_type==='video').height,46);
    await player.getByText('返回旧视频',{exact:true}).click();
    await row('old.mp4').waitFor();
    assert.deepEqual(await panel.locator('.resource-name').allTextContents(),['old.mp4']);
    await player.evaluate(()=>fetch('/progress.m3u8'));
    await clickDownload(row('progress.m3u8'));
    await waitJob('fetching');
    await player.getByText('切到新视频',{exact:true}).click();
    await row('new.mp4').waitFor();
    await jobStatus().locator('.job-title').filter({hasText:'上一页面的下载'}).waitFor();
    const continuing = await downloaded();
    assert.ok(continuing.endsWith('.mp4'));
    assert.deepEqual(await panel.locator('.resource-name').allTextContents(),['new.mp4']);
  });
  await check('X 帖子切换：旧帖子 DOM 尚未卸载时也只关联当前帖子视频', async () => {
    await context.route('https://x.com/navigation-fixture/**',route=>route.fulfill({contentType:'text/html; charset=utf-8',body:`<title>X 导航验收</title>
      <article><a href="/navigation-fixture/status/2001">旧帖</a><div data-testid="tweetText">旧帖视频</div><video src="https://video.twimg.com/ext_tw_video/1111/pu/vid/old-post.mp4" poster="https://pbs.twimg.com/ext_tw_video_thumb/1111/pu/img/poster.jpg"></video></article>
      <button onclick="history.pushState({},'', '/navigation-fixture/status/2002');document.body.insertAdjacentHTML('beforeend','<article><a href=&quot;/navigation-fixture/status/2002&quot;>新帖</a><div data-testid=&quot;tweetText&quot;>新帖视频</div><video src=&quot;https://video.twimg.com/ext_tw_video/2222/pu/vid/new-post.mp4&quot; poster=&quot;https://pbs.twimg.com/ext_tw_video_thumb/2222/pu/img/poster.jpg&quot;></video></article>');fetch('https://video.twimg.com/ext_tw_video/2222/pu/pl/new-post.mp4')">打开新帖</button>
      <script>fetch('https://video.twimg.com/ext_tw_video/1111/pu/pl/old-post.mp4')</script>`}));
    await context.route('https://video.twimg.com/**',route=>route.fulfill({contentType:'video/mp4',headers:{'Access-Control-Allow-Origin':'*'},path:path.join(fixtures,'sample.mp4')}));
    await context.route('https://pbs.twimg.com/**',route=>route.fulfill({contentType:'image/jpeg',path:path.join(fixtures,'poster.jpg')}));
    await player.goto('https://x.com/navigation-fixture/status/2001');
    await row('old-post.mp4').waitFor();
    await row('old-post.mp4').locator('.video-title').filter({hasText:'旧帖视频'}).waitFor();
    await player.getByText('打开新帖',{exact:true}).click();
    await row('new-post.mp4').locator('.video-title').filter({hasText:'新帖视频'}).waitFor();
    assert.equal(await player.locator('article').count(),2,'旧 DOM 故意保留');
    assert.deepEqual(await panel.locator('.resource-name').allTextContents(),['new-post.mp4']);
    assert.match(await row('new-post.mp4').locator('.thumbnail img').getAttribute('src'),/2222/);
    const stale='https://video.twimg.com/ext_tw_video/1111/pu/vid/stale.mp4';
    await panel.evaluate(async({tabId,url})=>{const key=`tab:${tabId}`;const data=await chrome.storage.session.get(key);await chrome.storage.session.set({[key]:[...data[key],{url,name:'stale.mp4',kind:'file',pageUrl:'https://x.com/navigation-fixture/status/2001',media:{title:'旧视频',key:'old',urls:[url]}}]})},{tabId,url:stale});
    const wrongPage=await panel.evaluate(args=>chrome.runtime.sendMessage({type:'start',...args}),{tabId,url:stale});
    assert.equal(wrongPage.ok,false);assert.match(wrongPage.error,/上一页面/);
    const unknown='https://video.twimg.com/ext_tw_video/3333/pu/pl/unconfirmed.m3u8';
    await panel.evaluate(async ({tabId,url})=>{const key=`tab:${tabId}`;const data=await chrome.storage.session.get(key);await chrome.storage.session.set({[key]:[...data[key],{url,name:'unconfirmed.m3u8',kind:'hls',source:'验收夹具：未匹配资源'}]})},{tabId,url:unknown});
    const unconfirmed=row('unconfirmed.m3u8').getByRole('button',{name:'等待匹配',exact:true});
    await unconfirmed.waitFor();
    assert.equal(await unconfirmed.isDisabled(),true);
    const before=await worker.evaluate(async()=>(await chrome.downloads.search({})).length);
    const rejected=await panel.evaluate(args=>chrome.runtime.sendMessage({type:'start',...args}),{tabId,url:unknown});
    assert.equal(rejected.ok,false);assert.match(rejected.error,/尚未确认/);
    assert.equal(await worker.evaluate(async()=>(await chrome.downloads.search({})).length),before);
    await player.evaluate(()=>{
      const article=document.querySelectorAll('article')[1];const video=article.querySelector('video');
      video.removeAttribute('src');video.load();
      article.querySelector('[data-testid="tweetText"]').textContent='缓存复用的当前视频';
      article.querySelector('a').href='/navigation-fixture/status/2003';
      history.pushState({},'', '/navigation-fixture/status/2003');document.title='X 缓存复用验收';
    });
    await panel.locator('#page-name').filter({hasText:'X 缓存复用验收'}).waitFor();
    await row('new-post.mp4').locator('.video-title').filter({hasText:'缓存复用的当前视频'}).waitFor();
    assert.deepEqual(await panel.locator('.resource-name').allTextContents(),['new-post.mp4']);
  });
  async function waitRulesEmpty() {
    await panel.waitForFunction(async () => (await chrome.declarativeNetRequest.getSessionRules()).length === 0);
  }
  await check('Referer：正式读取清晰度和 TS 下载通过限定来源校验', async () => {
    await player.goto(base); await panel.reload();
    const url = base + '/referer-ts/master.m3u8';
    const before = refererRequests.length;
    const status = await player.evaluate(url => fetch(url, { referrerPolicy: 'origin' }).then(response => response.status), url);
    assert.equal(status, 200, '正常网页请求必须携带自己的来源');
    assert.equal(refererRequests.at(-1).referer, base + '/');
    assert.equal(await player.evaluate(url => fetch(url, { referrerPolicy: 'no-referrer' }).then(response => response.status), url), 412);
    report.refererControl = { webpageWithReferer: status, webpageWithoutReferer: 412 };
    const card = row('master.m3u8');
    await card.getByRole('button', { name: '读取清晰度' }).click();
    await card.page().waitForFunction(() => document.querySelector('.inspection-error') || [...document.querySelectorAll('[role="option"]')].some(node => node.textContent.includes('90p')));
    assert.equal(await card.locator('.inspection-error').count(), 0, '扩展读取清晰度必须通过来源校验：' + await card.innerText());
    await chooseVersion(card, '90p · MP4');
    await waitRulesEmpty();
    await assertTsOutput(await clickDownload(card));
    await waitRulesEmpty();
    const extension = refererRequests.slice(before + 2);
    assert.ok(extension.some(request => request.path.endsWith('/stream.m3u8')));
    for (const index of [0, 1, 2]) assert.ok(extension.some(request => request.path.endsWith(`/stream${index}.ts`)));
    assert.ok(extension.every(request => request.status === 200 && request.referer === base + '/'));
    await player.goto(base); await panel.reload();
  });
  await check('Referer：fMP4 音画清单、初始化和全部片段保留来源', async () => {
    const before = refererRequests.length;
    await player.evaluate(url => fetch(url, { referrerPolicy: 'origin' }), base + '/referer-fmp4/master.m3u8');
    const card = row('master.m3u8');
    await card.getByRole('button', { name: '读取清晰度' }).click();
    await chooseVersion(card, '90p · MP4');
    await waitRulesEmpty();
    const filename = await downloaded(await clickDownload(card));
    const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-count_frames', '-show_streams', '-of', 'json', filename]));
    assert.equal(Number(probe.streams.find(stream => stream.codec_type === 'video').nb_read_frames), 75);
    const observed = refererRequests.slice(before);
    for (const name of ['v-fmp4.m3u8', 'a-fmp4.m3u8', 'v-init.mp4', 'a-init.mp4', 'v0.m4s', 'a0.m4s']) {
      assert.ok(observed.some(request => request.path.endsWith('/' + name)), `未请求受保护的 ${name}`);
    }
    assert.ok(observed.every(request => request.status === 200 && request.referer === base + '/'));
    await waitRulesEmpty(); await waitTempEmpty();
    await player.goto(base); await panel.reload();
  });
  for (const outcome of ['cancel', 'fail']) await check(`Referer：${outcome === 'cancel' ? '取消' : '失败'}清理临时规则且不保存残缺文件`, async () => {
    const group = 'referer-' + outcome;
    if (outcome === 'cancel') blockGate(group);
    const before = await worker.evaluate(async () => (await chrome.downloads.search({})).length);
    await player.evaluate(url => fetch(url, { referrerPolicy: 'origin' }), `${base}/${group}/master.m3u8`);
    const jobId = await clickDownload(row('master.m3u8'));
    if (outcome === 'cancel') {
      await waitGate(group);
      const rules = await worker.evaluate(() => chrome.declarativeNetRequest.getSessionRules());
      assert.ok(rules.length > 0, '未完成请求必须保留规则直到取消');
      await jobStatus(jobId).locator('.cancel').click();
      await waitJob('cancelled', undefined, jobId);
      releaseGate(group);
    } else await waitJob('failed', 'HTTP 404', jobId);
    await waitRulesEmpty(); await waitTempEmpty();
    assert.equal(await worker.evaluate(async () => (await chrome.downloads.search({})).length), before);
    await player.goto(base); await panel.reload();
  });
  await check('Referer：同一媒体 URL 不同来源并发不污染，网页请求不被改写', async () => {
    const group = 'referer-shared'; blockGate(group);
    const url = `${base}/${group}/master.m3u8`;
    const other = await context.newPage(), otherPanel = await context.newPage();
    const otherBase = base.replace('127.0.0.1', 'localhost');
    try {
      await player.evaluate(url => fetch(url, { referrerPolicy: 'origin' }), url);
      await other.goto(otherBase + '/?referer=other');
      await other.evaluate(url => fetch(url, { referrerPolicy: 'origin' }), url);
      const otherTab = await worker.evaluate(async url => (await chrome.tabs.query({})).find(tab => tab.url === url).id, otherBase + '/?referer=other');
      await otherPanel.goto(`chrome-extension://${id}/popup.html?tab=${otherTab}`);
      const before = refererRequests.length;
      const firstJob = await clickDownload(row('master.m3u8'));
      const secondJob = await clickDownload(rowIn(otherPanel, 'master.m3u8'));
      await waitGate(group);
      await waitJob('fetching', undefined, firstJob);
      await waitJob('fetching', undefined, secondJob, otherPanel);
      const rules = await worker.evaluate(() => chrome.declarativeNetRequest.getSessionRules());
      assert.ok(rules.length > 0);
      for (const rule of rules) {
        assert.deepEqual(rule.condition.initiatorDomains, [id], '规则只能匹配本扩展发起的请求');
        assert.ok(rule.condition.regexFilter?.startsWith('^') && rule.condition.regexFilter.endsWith('$'), '规则必须严格匹配单个完整 URL');
        assert.deepEqual(rule.action.requestHeaders.map(header => header.header.toLowerCase()), ['referer'], '规则只能改 Referer');
      }
      const segment = `${base}/${group}/stream1.ts`;
      assert.equal(await worker.evaluate(url => fetch(url).then(response => response.status), segment + '?unrelated=1'), 412, '活动规则不能覆盖带其他查询参数的扩展请求');
      assert.equal(await other.evaluate(url => fetch(url, { referrerPolicy: 'no-referrer' }).then(response => response.status), segment), 412, '普通网页无来源请求不能被扩展补来源');
      const plainStart = refererRequests.length;
      const plainRequest = other.evaluate(url => fetch(url, { referrerPolicy: 'origin' }).then(response => response.status), segment);
      const deadline = Date.now() + 10000;
      while (refererRequests.length === plainStart) {
        if (Date.now() > deadline) throw new Error('普通网页来源检查未到达服务器');
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      assert.equal(refererRequests.at(-1).referer, otherBase + '/', '普通网页来源必须保留');
      releaseGate(group);
      assert.equal(await plainRequest, 200);
      await assertTsOutput(firstJob); await assertTsOutput(secondJob, otherPanel);
      const observed = refererRequests.slice(before);
      for (const name of ['stream.m3u8', 'stream0.ts', 'stream1.ts', 'stream2.ts']) {
        const sources = observed.filter(request => request.path.endsWith('/' + name) && request.status === 200).map(request => request.referer);
        assert.ok(sources.includes(base + '/') && sources.includes(otherBase + '/'), `同地址 ${name} 必须使用各任务的真实来源`);
      }
      await waitRulesEmpty(); await waitTempEmpty();
    } finally { releaseGate(group); await otherPanel.close(); await other.close(); }
    await player.goto(base); await panel.reload();
  });
  await check('Referer：同站点 HTTP 重定向的子清单保留来源', async () => {
    const before = refererRequests.length;
    await player.evaluate(url => fetch(url, { referrerPolicy: 'origin' }), base + '/referer-redirect/master.m3u8');
    const card = row('master.m3u8');
    await card.getByRole('button', { name: '读取清晰度' }).click();
    await card.page().waitForFunction(() => document.querySelector('.inspection-error') || [...document.querySelectorAll('[role="option"]')].some(node => node.textContent.includes('90p')));
    await waitRulesEmpty();
    assert.equal(await card.locator('.inspection-error').count(), 0, '重定向的子清单必须通过来源校验：' + await card.innerText());
    await chooseVersion(card, '90p · MP4');
    await assertTsOutput(await clickDownload(card));
    assert.ok(refererRequests.slice(before).some(request => request.path.endsWith('/redirected-stream.m3u8') && request.status === 200));
    assert.ok(refererRequests.slice(before).every(request => request.referer === base + '/'));
    await waitRulesEmpty();
    await player.goto(base); await panel.reload();
  });
  await check('Referer：直接文件的校验与浏览器下载同样保留网页来源', async () => {
    await player.goto(base); await panel.reload();
    const url = base + '/referer-file/old.mp4';
    const before = refererRequests.length;
    const status = await player.evaluate(url => fetch(url, { referrerPolicy: 'origin' }).then(response => response.status), url);
    assert.equal(status, 200, '正常网页请求必须携带自己的来源');
    // Unmatched by the page player: lands in the folded 其他资源 section.
    const card = panel.locator('#other-list article').filter({ hasText: 'old.mp4' });
    await card.waitFor();
    const file = await savedFile(await clickDownload(card)).catch(async e => {
      console.log('DBG jobs:', await worker.evaluate(async () => ((await chrome.storage.session.get('jobs')).jobs || []).map(j => [j.state, j.message, j.viaFetch])));
      throw e;
    });
    const original = await readFile(path.join(fixtures, 'old.mp4'));
    assert.deepEqual(await readFile(file), original, '下载文件必须与源文件逐字节一致');
    const observed = refererRequests.slice(before).filter(request => request.path === '/referer-file/old.mp4');
    assert.ok(observed.some(request => request.status === 412), '应先观察到浏览器下载被服务器拒绝，再回退');
    assert.ok(observed.filter(request => request.status === 200).length >= 3, '校验与来源下载请求都应成功');
    assert.ok(observed.every(request => request.status !== 200 || request.referer === base + '/'),
      '校验和来源下载都必须携带网页来源：' + JSON.stringify(observed));
    // The rejected browser attempt must be erased, not left as a failed entry.
    const entries = await worker.evaluate(async () => (await chrome.downloads.search({})).map(d => d.state));
    assert.deepEqual(entries.filter(state => state === 'interrupted'), [], '被拒绝的下载尝试不能残留在下载列表：' + JSON.stringify(entries));
    await waitRulesEmpty();
    await player.goto(base); await panel.reload();
  });
  if (process.env.REAL_HLS_URL) await check('真实 CDN 素材：扩展请求、完整音画 MP4 保存与解码（不含网页识别）', async () => {
    const url = process.env.REAL_HLS_URL;
    await context.unroute('https://video.twimg.com/**');
    await player.goto(base);
    // Localhost is not an X page: the CDN may reject its Origin/Referer.
    // Exercise the real extension request context, then supply a known-resource
    // fixture. Webpage recognition is covered separately by native Chrome/X acceptance.
    const status = await worker.evaluate(async url => (await fetch(url, { credentials: 'include', signal: AbortSignal.timeout(60000) })).status, url);
    assert.equal(status, 200, `真实视频 CDN 拒绝扩展请求：HTTP ${status}`);
    await worker.evaluate(async ({ tabId, url }) => {
      const key = `tab:${tabId}`;
      const data = await chrome.storage.session.get(key);
      const items = (data[key] || []).filter(item => item.url !== url);
      items.push({ url, name: new URL(url).pathname.split('/').pop(), kind: 'hls', mime: 'application/vnd.apple.mpegurl', source: '验收夹具：真实 CDN 地址' });
      await chrome.storage.session.set({ [key]: items });
    }, { tabId, url });
    await panel.reload();
    const target = row(new URL(url).pathname.split('/').pop());
    await clickDownload(target);
    panel.setDefaultTimeout(120000);
    const filename = await downloaded();
    const probe = JSON.parse(execFileSync('ffprobe', ['-v','error','-show_streams','-show_format','-of','json',filename]));
    assert.ok(Math.abs(Number(probe.format.duration) - 35.7) < 0.3);
    assert.equal(probe.streams.find(stream => stream.codec_type === 'video').height, 1080);
    report.realFile = filename;
    report.realDuration = probe.format.duration;
    await panel.screenshot({ path: path.join(artifacts, 'real-download.png') });
  });
  report.result = 'pass';
} catch (error) {
  report.result = 'fail'; report.error = String(error.stack || error); console.error(error);
  process.exitCode = 1;
} finally {
  if (context) {
    await context.tracing.stop({ path: path.join(artifacts, 'trace.zip') });
    await context.close();
  }
  server.close(); server.closeAllConnections();
  await rm(fixtures, { recursive: true, force: true });
  await rm(profile, { recursive: true, force: true });
  report.gateEvents = gateEvents;
  report.refererRequests = refererRequests;
  await writeFile(path.join(artifacts, 'report.json'), JSON.stringify(report, null, 2));
}
