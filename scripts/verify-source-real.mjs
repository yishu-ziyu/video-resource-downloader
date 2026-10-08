// Replays the already-observed failing resource in an isolated browser profile.
// Input is an ephemeral, mode-0600 JSON file; never print or retain signed URLs.
import { chromium } from 'playwright';
import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
const inputPath = process.argv[2];
const input = JSON.parse(await readFile(inputPath, 'utf8'));
const artifacts = path.resolve('artifacts/referer-0.9.0/real');
const profile = await mkdtemp(path.join(tmpdir(), 'referer-real-'));
await mkdir(path.join(artifacts, 'downloads'), { recursive: true });
await mkdir(path.join(profile, 'Default'));
await writeFile(path.join(profile, 'Default', 'Preferences'), JSON.stringify({ download: { default_directory: path.join(artifacts, 'downloads'), prompt_for_download: false } }));
let context;
const report = { mediaHost: new URL(input.url).host, sourceOrigin: new URL(input.pageUrl).origin };
try {
  const extension = path.resolve('extension');
  context = await chromium.launchPersistentContext(profile, {channel:'chromium',headless:true,acceptDownloads:true,...(process.env.REAL_TEST_PROXY ? {proxy:{server:process.env.REAL_TEST_PROXY}} : {}),args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`]});
  let [worker] = context.serviceWorkers(); worker ||= await context.waitForEvent('serviceworker');
  const id = worker.url().split('/')[2];
  const player = await context.newPage();
  await player.goto(input.pageUrl,{waitUntil:'domcontentloaded',timeout:30000});
  await player.waitForFunction(() => Object.keys(window).some(key => /^flashvars_/.test(key) && window[key]?.mediaDefinitions?.some(media => media.format === 'hls')), null, {timeout:20000});
  const fresh = await player.evaluate(() => {
    const data = Object.keys(window).filter(key => /^flashvars_/.test(key)).map(key => window[key]).find(data => data?.mediaDefinitions?.some(media => media.format === 'hls'));
    const definitions = data.mediaDefinitions.filter(media => media.format === 'hls');
    return { url: definitions.find(media => media.quality === '1080')?.videoUrl || definitions[0].videoUrl,
      fullUrl: definitions.find(media => media.quality === '240')?.videoUrl || definitions[0].videoUrl,
      expectedDuration: Number(data.video_duration) };
  });
  // A signed media address may be bound to its client. Obtain it in this same test context.
  input.url = fresh.url; input.fullUrl = fresh.fullUrl; report.expectedDuration = fresh.expectedDuration;
  const control = await context.newPage();
  await control.goto(`chrome-extension://${id}/popup.html`);
  report.control = await control.evaluate(async ({url,pageUrl}) => {
    const {acquireSource,releaseSource} = await import(chrome.runtime.getURL('source-fetch.js'));
    const old = await fetch(url,{credentials:'include',signal:AbortSignal.timeout(15000)}); const oldStatus = old.status; await old.body?.cancel();
    const lease = await acquireSource(url,pageUrl);
    let fixedStatus,text;
    try {const fixed = await fetch(url,{credentials:'include',signal:AbortSignal.timeout(15000)});fixedStatus=fixed.status;text=await fixed.text();}
    finally {await releaseSource(lease);}
    return { withoutSource:oldStatus,withSource:fixedStatus,validManifest:text.startsWith('#EXTM3U'),rulesAfter:(await chrome.declarativeNetRequest.getSessionRules()).length };
  }, input);
  await control.close();
  if (report.control.withSource !== 200 || !report.control.validManifest) throw new Error('真实源清单仍未恢复；不继续下载。');
  const downloadUrl = input.fullUrl || input.url;
  report.testQuality = input.testQuality || 'original';
  const tabId = await worker.evaluate(async pageUrl => (await chrome.tabs.query({})).find(tab=>tab.url===pageUrl).id,input.pageUrl);
  await worker.evaluate(async ({tabId,url,pageUrl}) => {
    await chrome.storage.session.set({[`tab:${tabId}`]:[{url,pageUrl,name:'真实 HLS 来源验收',kind:'hls',source:'已观察失败资源重放'}]});
  }, {tabId,...input,url:downloadUrl});
  const panel = await context.newPage(); await panel.setViewportSize({width:560,height:600});
  await panel.goto(`chrome-extension://${id}/popup.html?tab=${tabId}`);
  const cdp=await context.newCDPSession(panel);await cdp.send('Browser.setDownloadBehavior',{behavior:'default'});
  await panel.locator('article .download').click();
  await panel.waitForFunction(async () => (await chrome.storage.session.get('jobs')).jobs?.length>0);
  const jobId = await worker.evaluate(async ()=>(await chrome.storage.session.get('jobs')).jobs.at(-1).id);
  const deadline = Date.now() + 180000;
  let job;
  while (Date.now() < deadline) {
    job = await worker.evaluate(async id => (await chrome.storage.session.get('jobs')).jobs.find(j => j.id === id),jobId);
    if (['complete','failed','cancelled'].includes(job.state)) break;
    await new Promise(resolve => setTimeout(resolve,400));
  }
  if (!['complete','failed','cancelled'].includes(job.state)) {
    await panel.evaluate(id=>chrome.runtime.sendMessage({type:'cancel',id}),jobId);
    throw new Error('完整下载超过180秒验收窗口，已取消该隔离测试任务。');
  }
  report.download={state:job.state,done:job.done,total:job.total,bytes:job.bytes,message:job.message};
  if(job.state!=='complete')throw new Error(job.message);
  const file=await worker.evaluate(async downloadId=>(await chrome.downloads.search({id:downloadId}))[0].filename,job.downloadId);
  const probe=JSON.parse(execFileSync('ffprobe',['-v','error','-show_streams','-show_format','-of','json',file]));
  if (report.expectedDuration && Math.abs(Number(probe.format.duration)-report.expectedDuration)>2) throw new Error('真实输出时长与网页不一致。');
  report.output={file,bytes:probe.format.size,duration:probe.format.duration,streams:probe.streams.map(s=>({type:s.codec_type,codec:s.codec_name,width:s.width,height:s.height}))};
  execFileSync('ffmpeg',['-v','error','-i',file,'-t','5','-f','null','-'],{timeout:30000});
  report.decode='first 5 seconds';
  report.rulesAfter=await worker.evaluate(async ()=>(await chrome.declarativeNetRequest.getSessionRules()).length);
  report.result='pass';
  console.log(JSON.stringify(report,null,2));
}catch(error){report.result='fail';report.error=String(error);console.error(report.error);process.exitCode=1;}
finally{
  await context?.close(); await rm(profile,{recursive:true,force:true}); await rm(inputPath,{force:true});
  await writeFile(path.join(artifacts,'report.json'),JSON.stringify(report,null,2));
}
