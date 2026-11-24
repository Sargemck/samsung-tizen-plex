'use strict';
// Synthetic Plex and AVPlay only. Every non-loopback request is intercepted.
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict');
const {chromium}=require('playwright'),root=path.resolve(__dirname,'../app');
const headers={'access-control-allow-origin':'*','access-control-allow-headers':'*','access-control-allow-methods':'GET,PUT,OPTIONS'};
const server=http.createServer((req,res)=>{
  const file=path.join(root,new URL(req.url,'http://fixture').pathname);
  if(!file.startsWith(root+path.sep)||!fs.existsSync(file)||!fs.statSync(file).isFile()){res.writeHead(404);res.end();return;}
  res.setHeader('Content-Type',file.endsWith('.js')?'application/javascript':file.endsWith('.css')?'text/css':'text/html');fs.createReadStream(file).pipe(res);
});
async function until(test){for(let n=0;n<150;n++){if(test())return;await new Promise(resolve=>setTimeout(resolve,20));}throw new Error('Expected fixture request did not arrive');}
(async()=>{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const browser=await chromium.launch({headless:true,channel:process.env.PLAYWRIGHT_CHANNEL||undefined});
  try{
    async function fixture(mode,burn=false){
      const page=await browser.newPage({viewport:{width:1920,height:1080}}),requests=[],errors=[],unexpected=[],held=[];
      const state={pingStatus:204,holdPing:false,holdDecision:false,failDecision:false};
      page.on('pageerror',error=>errors.push(error.message));
      await page.clock.install();
      await page.addInitScript(({mode,burn})=>{
        localStorage.setItem('tizenosplex.server','http://192.168.1.20:32400');localStorage.setItem('tizenosplex.token','PAUSE_FIXTURE_ONLY');
        localStorage.setItem('tizenosplex.preferences.owner',JSON.stringify({playbackMode:mode==='remux'?'auto':mode,subtitleMode:burn?'always':'off',audioLanguage:'ja'}));
        let listener;window.calls=[];window.mockState='NONE';window.oldListeners=[];
        window.webapis={avplay:{
          open(url){window.mockState='IDLE';window.calls.push({action:'open',url});},setDisplayRect(){},setDisplayMethod(){},
          setListener(value){if(listener)window.oldListeners.push(listener);listener=value;window.advanceFixture=time=>listener.oncurrentplaytime(time);},
          prepareAsync(ok){setTimeout(ok,5);},getDuration(){return 1800000;},
          play(){window.mockState='PLAYING';window.calls.push({action:'play'});},pause(){window.mockState='PAUSED';window.calls.push({action:'pause'});},
          stop(){window.mockState='IDLE';window.calls.push({action:'stop'});},close(){},
          seekTo(ms,ok){window.calls.push({action:'seek',ms});setTimeout(ok,5);},
          getTotalTrackInfo(){return [];},getCurrentStreamInfo(){return [];},setSilentSubtitle(){},setSubtitlePosition(){}
        },appcommon:{AppCommonScreenSaverState:{SCREEN_SAVER_ON:1,SCREEN_SAVER_OFF:0},setScreenSaver(){}}};
      },{mode,burn});
      const item={ratingKey:'42',type:'episode',title:'Pause fixture',grandparentTitle:'Synthetic series',parentIndex:1,index:1,duration:1800000,
        Media:[{videoCodec:'h264',audioCodec:mode==='remux'?'dts':'aac',Part:[{id:'80',key:'/library/parts/80/file.mkv',Stream:[{id:'7',streamType:2,codec:mode==='remux'?'dts':'aac',languageCode:'jpn'}]}]}]};
      if(burn)item.Media[0].Part[0].Stream.push({id:'8',streamType:3,codec:'pgs',languageCode:'eng',selected:true});
      await page.route('**/*',async route=>{
        const req=route.request(),url=new URL(req.url()),p=url.pathname;
        if(url.hostname==='127.0.0.1')return route.continue();
        if(url.hostname!=='192.168.1.20'){unexpected.push(url.origin+p);return route.abort();}
        if(req.method()==='OPTIONS')return route.fulfill({status:204,headers});
        requests.push({p,params:Object.fromEntries(url.searchParams),token:req.headers()['x-plex-token']});
        if(p.endsWith('/universal/ping')){
          if(state.holdPing){held.push(route);return;}
          return route.fulfill({status:state.pingStatus,headers,body:''});
        }
        if(p.endsWith('/universal/decision')){
          if(state.holdDecision){held.push(route);return;}
          if(state.failDecision)return route.fulfill({status:503,headers,body:'Fixture offline'});
        }
        let box={};
        if(p==='/library/sections')box={Directory:[{key:'1',title:'Shows',type:'show'}]};
        else if(p.includes('/metadata/')||p.includes('continueWatching')||p.endsWith('/all')||p.endsWith('/recentlyAdded'))box={Metadata:[item],totalSize:1};
        await route.fulfill({headers,json:{MediaContainer:box}});
      });
      await page.goto('http://127.0.0.1:'+server.address().port+'/index.html');await page.locator('.card').first().click();await page.getByRole('button',{name:'Play',exact:true}).click();
      await page.waitForFunction(()=>window.mockState==='PLAYING');await page.evaluate(()=>window.advanceFixture(123000));
      const calls=action=>page.evaluate(action=>window.calls.filter(call=>call.action===action),action);
      const toggle=()=>page.evaluate(()=>document.getElementById('control-toggle').click());
      const pings=()=>requests.filter(request=>request.p.endsWith('/universal/ping'));
      const stop=async()=>{await page.evaluate(()=>document.dispatchEvent(new KeyboardEvent('keydown',{keyCode:413,bubbles:true})));await page.getByRole('button',{name:'Stop playback',exact:true}).click();await page.waitForFunction(()=>document.getElementById('player-ui').hidden);};
      return {page,requests,errors,unexpected,held,state,calls,toggle,pings,stop};
    }
    for(const mode of ['direct','remux','convert']){
      const f=await fixture(mode),{page}=f;
      if(mode!=='direct')await until(()=>f.pings().length>0);
      await f.toggle();assert.equal(await page.evaluate(()=>window.mockState),'PAUSED');
      for(let n=0;n<3;n++){
        const before=f.pings().length;await page.clock.fastForward(10000);
        if(mode!=='direct')await until(()=>f.pings().length>before);
      }
      assert.equal((await f.calls('open')).length,1,'Pausing must not create extra streams');
      if(mode==='direct')assert.equal(f.pings().length,0,'Direct play has no transcode session');
      else{
        const session=new URL((await f.calls('open'))[0].url).searchParams.get('session');
        assert.ok(f.pings().every(p=>p.params.session===session&&p.token==='PAUSE_FIXTURE_ONLY'));
        assert.ok(f.requests.some(r=>r.p==='/:/timeline'&&r.params.state==='paused'&&r.params.time==='123000'));
      }
      await f.toggle();assert.equal((await f.calls('open')).length,1,'Short pauses resume immediately');
      assert.equal((await f.calls('play')).length,2);
      await f.toggle();await page.clock.fastForward(15*60*1000);
      await f.toggle();await page.waitForFunction(()=>window.calls.filter(c=>c.action==='play').length===3);
      const opens=await f.calls('open');assert.equal(opens.length,2,'Long pauses reopen the transport');
      assert.equal((await f.calls('seek')).at(-1).ms,123000,'Refresh must seek before playing');
      if(mode!=='direct'){
        const first=new URL(opens[0].url),second=new URL(opens[1].url);
        assert.notEqual(first.searchParams.get('session'),second.searchParams.get('session'));
        assert.equal(second.searchParams.get('directStream'),mode==='remux'?'1':'0');
        assert.ok(f.requests.some(r=>r.p.endsWith('/universal/stop')&&r.params.session===first.searchParams.get('session')));
        assert.ok(f.requests.filter(r=>r.p==='/library/parts/80').every(r=>r.params.audioStreamID==='7'));
      }
      await page.evaluate(()=>window.oldListeners[0].onerror('PLAYER_ERROR_CONNECTION_FAILED'));
      assert.equal(await page.locator('#player-ui').isVisible(),true,'An old transport error must not interrupt the replacement');
      assert.equal(f.requests.filter(r=>r.p==='/:/timeline'&&r.params.time==='0').length,1,'Only the initial start reports zero');
      const lastTimeline=f.requests.filter(r=>r.p==='/:/timeline').at(-1);assert.equal(lastTimeline.params.time,'123000');
      await f.stop();const stoppedPings=f.pings().length;await page.clock.fastForward(60000);
      assert.equal(f.pings().length,stoppedPings,'Stop must release the keepalive');
      assert.deepEqual(f.errors,[]);assert.deepEqual(f.unexpected,[]);await page.close();
    }
    const burned=await fixture('convert',true);await until(()=>burned.pings().length>0);
    await burned.toggle();await burned.page.clock.fastForward(120000);await burned.toggle();
    await burned.page.waitForFunction(()=>window.calls.filter(c=>c.action==='play').length===2);
    assert.ok((await burned.calls('open')).every(call=>new URL(call.url).searchParams.get('subtitles')==='burn'));
    assert.equal(burned.requests.filter(r=>r.p==='/library/parts/80'&&r.params.subtitleStreamID==='8').length,2,'Long resume retains the selected burned-in subtitles');
    assert.deepEqual(burned.errors,[]);assert.deepEqual(burned.unexpected,[]);await burned.page.close();
    // A dead session must not eject a paused viewer or resume its cached stream.
    const failed=await fixture('convert');await until(()=>failed.pings().length>0);
    await failed.toggle();failed.state.pingStatus=404;await failed.page.clock.fastForward(120000);
    assert.equal(await failed.page.evaluate(()=>window.mockState),'PAUSED');
    failed.state.failDecision=true;await failed.toggle();await failed.page.getByRole('heading',{name:'Playback interrupted',exact:true}).waitFor();
    await failed.page.getByRole('button',{name:'Retry from 2:03',exact:true}).waitFor();
    assert.equal((await failed.calls('play')).length,1,'A failed refresh must never play the stale buffer or restart from zero');
    assert.equal((await failed.calls('open')).length,1);assert.deepEqual(failed.errors,[]);await failed.page.close();
    // Stopping during refresh invalidates late Plex replies and keeps the old player closed.
    const cancelled=await fixture('remux');await until(()=>cancelled.pings().length>0);
    await cancelled.toggle();cancelled.state.holdPing=true;await cancelled.page.clock.fastForward(120000);
    await until(()=>cancelled.held.length>0);cancelled.state.holdDecision=true;await cancelled.toggle();
    await until(()=>cancelled.held.length>1);await cancelled.stop();
    for(const route of cancelled.held)await route.fulfill({headers,json:{MediaContainer:{}}}).catch(()=>{});
    await cancelled.page.clock.fastForward(60000);
    assert.equal((await cancelled.calls('play')).length,1);assert.equal((await cancelled.calls('open')).length,1);
    assert.deepEqual(cancelled.errors,[]);assert.deepEqual(cancelled.unexpected,[]);await cancelled.page.close();
    console.log('PASS: pause keepalive, direct/remux/convert long-pause refresh, exact resume position, expired-session failure, stale callbacks, and cancellation; all Plex/TV access mocked.');
  }finally{await browser.close();server.close();}
})().catch(error=>{console.error(error);server.close();process.exitCode=1;});
