/* SnapToDesign AI Pro V9.6 — FINAL backend
   Node.js 18+ / zero npm dependencies.
   Required for AI: ANTHROPIC_API_KEY
   Optional: PORT=8787, FRONTEND_ORIGIN=http://localhost:8787, AI_MODEL=claude-sonnet-4-6
*/
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'snap-data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const AI_MODEL = process.env.AI_MODEL || 'claude-sonnet-4-6';
const AI_KEY = process.env.ANTHROPIC_API_KEY || '';
const MAX_BODY = 25 * 1024 * 1024;
const sessions = new Map();

fs.mkdirSync(DATA_DIR, { recursive: true });
function loadDB(){ try { return JSON.parse(fs.readFileSync(DB_FILE,'utf8')); } catch { return {users:[],projects:[],versions:[],credits:[]}; } }
let db = loadDB();
function saveDB(){ fs.writeFileSync(DB_FILE, JSON.stringify(db,null,2)); }
function id(prefix='id'){ return prefix+'_'+crypto.randomBytes(9).toString('hex'); }
function corsOrigin(){ const configured=process.env.FRONTEND_ORIGIN||''; return configured || '*'; }
function json(res,status,data,extra={}){ const body=JSON.stringify(data); const origin=corsOrigin(); const h={'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','Access-Control-Allow-Origin':origin,...extra}; if(origin!=='*') h['Access-Control-Allow-Credentials']='true'; res.writeHead(status,h); res.end(body); }
function parseCookies(req){ const out={}; (req.headers.cookie||'').split(';').forEach(x=>{const i=x.indexOf('='); if(i>0)out[x.slice(0,i).trim()]=decodeURIComponent(x.slice(i+1));}); return out; }
function userFrom(req){ const sid=parseCookies(req).snap_sid; return sid ? sessions.get(sid) : null; }
function readBody(req){ return new Promise((resolve,reject)=>{let n=0,ch=[]; req.on('data',b=>{n+=b.length;if(n>MAX_BODY){reject(new Error('Request too large'));req.destroy();}else ch.push(b);});req.on('end',()=>{const raw=Buffer.concat(ch).toString('utf8');try{resolve(raw?JSON.parse(raw):{});}catch{reject(new Error('Invalid JSON'));}});req.on('error',reject);}); }
function requireUser(req,res){ const u=userFrom(req); if(!u){json(res,401,{error:'Login required'});return null;} return u; }
function creditFor(userId){ let c=db.credits.find(x=>x.userId===userId); if(!c){c={userId,balance:100,used:0};db.credits.push(c);saveDB();} return c; }
function consumeCredit(userId,n=1){ const c=creditFor(userId); if(c.balance<n) return false; c.balance-=n;c.used+=n;saveDB();return true; }
function hash(s){ return crypto.createHash('sha256').update(String(s)).digest('hex'); }
function sendFile(res,file){ if(!fs.existsSync(file)) return json(res,404,{error:'Not found'}); res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'}); fs.createReadStream(file).pipe(res); }
function htmlChecks(html=''){
  const issues=[];
  if(!/<html[\s>]/i.test(html)) issues.push({level:'error',text:'Missing <html> document'});
  if(/<img(?![^>]*\balt=)[^>]*>/i.test(html)) issues.push({level:'warn',text:'Image without alt attribute'});
  if(!/(sm:|md:|lg:|@media|viewport)/i.test(html)) issues.push({level:'warn',text:'Responsive evidence not detected'});
  if(/javascript:\s*|eval\s*\(|document\.write\s*\(/i.test(html)) issues.push({level:'warn',text:'Potentially unsafe browser code pattern'});
  if(!/<meta[^>]+name=["']viewport/i.test(html)) issues.push({level:'warn',text:'Viewport meta tag missing'});
  return issues;
}
async function runChromiumScreenshot(html,width=1440,height=900){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'snapqa-')); const input=path.join(dir,'index.html'),shot=path.join(dir,'shot.png'); fs.writeFileSync(input,html,'utf8');
  try{ await execFileAsync('chromium',['--headless=new','--no-sandbox','--disable-gpu','--disable-dev-shm-usage','--disable-extensions','--no-first-run','--hide-scrollbars','--virtual-time-budget=3000',`--window-size=${width},${height}`,`--screenshot=${shot}`,`file://${input}`],{timeout:20000,maxBuffer:512*1024}); return {pngBase64:fs.readFileSync(shot).toString('base64'),width,height}; }
  finally{try{fs.rmSync(dir,{recursive:true,force:true});}catch{}}
}
async function comparePngs(referenceB64,actualB64){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'snapcmp-')); const a=path.join(dir,'a.png'),b=path.join(dir,'b.png'),diff=path.join(dir,'diff.png');
  try{ fs.writeFileSync(a,Buffer.from(referenceB64,'base64')); fs.writeFileSync(b,Buffer.from(actualB64,'base64'));
    let metric=''; try{ const r=await execFileAsync('compare',['-metric','AE','-fuzz','3%','-resize','160x','-compose','src','-composite',a,b,diff],{timeout:30000,maxBuffer:1024*1024}); metric=(r.stderr||r.stdout||'').trim(); }catch(e){ metric=(e.stderr||e.stdout||'').trim(); }
    const diffPixels=Math.max(0,Number(String(metric).split(/\s+/)[0])||0); const {stdout:dim}=await execFileAsync('identify',['-format','%w %h',a],{timeout:10000}); const [w,h]=dim.trim().split(/\s+/).map(Number); const pixels=Math.max(1,w*h);
    const score=Math.max(0,Math.min(100,Math.round((1-Math.min(1,diffPixels/pixels))*100))); return {score,matchPercent:score,diffPixels,width:w,height:h};
  } finally{try{fs.rmSync(dir,{recursive:true,force:true});}catch{}}
}
async function analyzeVideoFrames(videoB64,sampleCount=8){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'snapvideo-')); const video=path.join(dir,'input.mp4'),pattern=path.join(dir,'frame-%03d.png');
  try{ fs.writeFileSync(video,Buffer.from(videoB64,'base64')); const count=Math.max(1,Math.min(24,Number(sampleCount)||8));
    await execFileAsync('ffmpeg',['-hide_banner','-loglevel','error','-i',video,'-vf',`fps=1/${Math.max(1,Math.ceil(30/count))}`,'-frames:v',String(count),pattern],{timeout:120000,maxBuffer:2*1024*1024});
    const frames=fs.readdirSync(dir).filter(x=>/^frame-\d+\.png$/.test(x)).sort(); const details=[];
    for(const f of frames){const {stdout}=await execFileAsync('identify',['-format','%w %h %[mean]',path.join(dir,f)],{timeout:10000}); const [w,h,mean]=stdout.trim().split(/\s+/); details.push({file:f,width:Number(w),height:Number(h),mean:Number(mean)});}
    return {ok:true,sampleCount:details.length,frames:details,message:'Video frames sampled successfully.'};
  } finally{try{fs.rmSync(dir,{recursive:true,force:true});}catch{}}
}

function stripCodeFences(text=''){
  return String(text).replace(/```(?:html|xml|text)?/gi,'').replace(/```/g,'').trim();
}
function extractHtmlFromAI(text=''){
  const cleaned=stripCodeFences(text);
  try{
    const parsed=JSON.parse(cleaned);
    if(typeof parsed.html==='string' && parsed.html.trim()) return parsed.html.trim();
  }catch{}
  const m=cleaned.match(/<html[\s\S]*<\/html>/i);
  if(m) return m[0].trim();
  const frag=cleaned.match(/<(?:div|main|section|article|header|footer|nav|form|body)\b[\s\S]*$/i);
  return (frag?frag[0]:cleaned).trim();
}
function repairFindings(issues=[],visual=null){
  const out=(issues||[]).map(i=>`${String(i.level||'warn').toUpperCase()}: ${i.text||i.message||'QA finding'}`);
  if(visual && Number.isFinite(visual.score) && visual.score<95) out.push(`VISUAL: screenshot similarity is ${visual.score}%. Improve geometry, spacing, typography, colors and image crops.`);
  return out.slice(0,30);
}
async function runAutonomousRepair(html, referenceB64='', opts={}){
  let current=String(html||'').trim();
  if(!current) throw new Error('html is required');
  const maxIterations=Math.max(1,Math.min(5,Number(opts.maxIterations)||3));
  const width=Math.max(320,Math.min(2560,Number(opts.width)||1440));
  const height=Math.max(240,Math.min(1800,Number(opts.height)||900));
  const history=[];
  let last=null;
  for(let iteration=1;iteration<=maxIterations;iteration++){
    const issues=htmlChecks(current);
    let render=null, renderError='';
    try{ render=await runChromiumScreenshot(current,width,height); }catch(e){ renderError=e.message; }
    let visual=null;
    if(render && referenceB64){ try{ visual=await comparePngs(String(referenceB64),render.pngBase64); }catch(e){ issues.push({level:'warn',text:'Visual comparison unavailable: '+e.message}); } }
    if(renderError) issues.push({level:'error',text:'Browser render failed: '+renderError});
    const hardErrors=issues.filter(i=>i.level==='error').length;
    const visualPass=!referenceB64 || (visual && visual.score>=95);
    const pass=hardErrors===0 && !!render && visualPass && issues.filter(i=>i.level==='warn').length===0;
    last={iteration,pass,issues,visual,render:render?{pngBase64:render.pngBase64,width:render.width,height:render.height}:null};
    history.push({iteration,pass,issues,visualScore:visual?.score??null,rendered:!!render});
    if(pass || iteration===maxIterations) break;
    if(!AI_KEY) throw new Error('ANTHROPIC_API_KEY is not configured on the server');
    const findings=repairFindings(issues,visual);
    const prompt=`You are the autonomous repair engineer for a screenshot-to-website system.\nCurrent HTML:\n${current}\n\nQA findings:\n${findings.join('\n')}\n\nTask: return ONLY the complete corrected HTML fragment. Preserve the intended design, content, assets and interactions. Fix runtime/HTML/accessibility/responsive problems and improve screenshot fidelity. Do not explain. Do not wrap in markdown.`;
    const out=await anthropic({model:opts.model||AI_MODEL,max_tokens:Math.min(8000,Number(opts.max_tokens)||6500),system:'You repair web UI code using objective QA findings. Output only complete HTML.',messages:[{role:'user',content:prompt}]});
    const next=extractHtmlFromAI(out.text);
    if(!next || next===current) break;
    current=next;
  }
  return {ok:true,html:current,iterations:history.length,history,last};
}

async function anthropic(body={}){
  if(!AI_KEY) throw new Error('ANTHROPIC_API_KEY is not configured on the server');
  const model=String(body.model||AI_MODEL||'claude-sonnet-4-6').trim();
  const maxTokens=Math.max(256,Math.min(16000,Number(body.max_tokens)||4000));
  const messages=Array.isArray(body.messages)?body.messages:[];
  if(!messages.length) throw new Error('AI request is missing messages');

  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),65000);
  let r;
  try{
    r=await fetch('https://api.anthropic.com/v1/messages',{
      method:'POST',
      headers:{
        'content-type':'application/json',
        'accept':'application/json',
        'x-api-key':AI_KEY,
        'anthropic-version':'2023-06-01'
      },
      body:JSON.stringify({
        model,
        max_tokens:maxTokens,
        ...(body.system?{system:String(body.system)}:{}),
        messages
      }),
      signal:controller.signal
    });
  }catch(e){
    if(e?.name==='AbortError') throw new Error('Anthropic API timeout after 65 seconds');
    throw new Error(`Anthropic network error: ${e?.message||e}`);
  }finally{
    clearTimeout(timer);
  }

  const raw=await r.text();
  let d={};
  try{d=raw?JSON.parse(raw):{};}catch{d={};}
  if(!r.ok){
    const providerMessage=d?.error?.message||raw?.slice(0,500)||`Anthropic HTTP ${r.status}`;
    throw new Error(`Anthropic API ${r.status}: ${providerMessage}`);
  }
  const text=(Array.isArray(d.content)?d.content:[])
    .filter(x=>x&&x.type==='text'&&typeof x.text==='string')
    .map(x=>x.text).join('\n').trim();
  if(!text) throw new Error('Anthropic returned an empty text response');
  return {text,usage:d.usage||{}};
}
async function route(req,res){
  if(req.method==='OPTIONS'){const origin=corsOrigin(); const h={'Access-Control-Allow-Origin':origin,'Access-Control-Allow-Headers':'Content-Type','Access-Control-Allow-Methods':'GET,POST,DELETE,OPTIONS'}; if(origin!=='*') h['Access-Control-Allow-Credentials']='true'; res.writeHead(204,h);return res.end();}
  const u=new URL(req.url,`http://${req.headers.host}`); const p=u.pathname;
  if(req.method==='GET' && (p==='/'||p==='/index.html')) return sendFile(res,path.join(__dirname,'SnapToDesign-AI-Pro-V9.6-FINAL-FRONTEND.html'));
  if(req.method==='GET'&&p==='/health'){
    const tools={chromium:false,compare:false,identify:false,ffmpeg:false};
    for(const [name,cmd] of Object.entries({chromium:'chromium',compare:'compare',identify:'identify',ffmpeg:'ffmpeg'})){try{await execFileAsync(cmd,['-version'],{timeout:5000});tools[name]=true;}catch{}}
    return json(res,200,{ok:true,service:'SnapToDesign AI Pro V9.6',time:new Date().toISOString(),aiConfigured:!!AI_KEY,tools});
  }
  try{
    if(req.method==='POST'&&p==='/api/auth/signup'){
      const b=await readBody(req), email=String(b.email||'').trim().toLowerCase(), password=String(b.password||'');
      if(!/^\S+@\S+\.\S+$/.test(email)||password.length<8) return json(res,400,{error:'Valid email and password of at least 8 characters required'});
      if(db.users.some(x=>x.email===email)) return json(res,409,{error:'Account already exists'});
      const user={id:id('usr'),email,passwordHash:hash(password),createdAt:new Date().toISOString()};db.users.push(user);creditFor(user.id);saveDB();const sid=id('sid');sessions.set(sid,user);res.setHeader('Set-Cookie',`snap_sid=${encodeURIComponent(sid)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000`);return json(res,200,{user:{id:user.id,email:user.email},credits:creditFor(user.id)});
    }
    if(req.method==='POST'&&p==='/api/auth/login'){
      const b=await readBody(req), email=String(b.email||'').trim().toLowerCase(), user=db.users.find(x=>x.email===email&&x.passwordHash===hash(String(b.password||''))); if(!user)return json(res,401,{error:'Invalid email or password'});const sid=id('sid');sessions.set(sid,user);res.setHeader('Set-Cookie',`snap_sid=${encodeURIComponent(sid)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000`);return json(res,200,{user:{id:user.id,email:user.email},credits:creditFor(user.id)});
    }
    if(req.method==='GET'&&p==='/api/auth/me'){const x=userFrom(req);return json(res,200,{user:x?{id:x.id,email:x.email}:null});}
    if(req.method==='POST'&&p==='/api/auth/logout'){const c=parseCookies(req);if(c.snap_sid)sessions.delete(c.snap_sid);res.setHeader('Set-Cookie','snap_sid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');return json(res,200,{ok:true});}
    if(req.method==='GET'&&p==='/api/credits'){const x=requireUser(req,res);if(!x)return;return json(res,200,{credits:creditFor(x.id)});}
    if(req.method==='POST'&&p==='/api/ai'){
      const x=requireUser(req,res);
      if(!x)return;
      if(!AI_KEY)return json(res,503,{error:'ANTHROPIC_API_KEY is not configured on the server',model:AI_MODEL});
      let b;
      try{ b=await readBody(req); }catch(e){ return json(res,400,{error:e.message||'Invalid JSON'}); }
      if(!Array.isArray(b.messages)||b.messages.length===0)return json(res,400,{error:'AI request messages are required'});
      if(!consumeCredit(x.id,1))return json(res,402,{error:'Credits exhausted',credits:creditFor(x.id)});
      try{
        const out=await anthropic(b);
        return json(res,200,{text:out.text,usage:out.usage,model:String(b.model||AI_MODEL),credits:creditFor(x.id)});
      }catch(e){
        const c=creditFor(x.id);
        c.balance++;
        c.used=Math.max(0,c.used-1);
        saveDB();
        const status=/Anthropic API 429/.test(e.message)?429:/Anthropic API 4\d\d/.test(e.message)?502:502;
        return json(res,status,{error:e.message,credits:c,model:String(b.model||AI_MODEL)});
      }
    }
    if(req.method==='POST'&&p==='/api/agent/repair'){
      const x=requireUser(req,res);if(!x)return;
      const b=await readBody(req); const html=String(b.html||'');
      if(!html)return json(res,400,{error:'html required'});
      const maxIterations=Math.max(1,Math.min(5,Number(b.maxIterations)||3));
      // One credit per AI repair iteration is reserved as the repair loop progresses.
      try{
        if(!AI_KEY)return json(res,503,{error:'ANTHROPIC_API_KEY is not configured on the server'});
        const originalConsume=consumeCredit;
        const result=await runAutonomousRepair(html,String(b.referencePngBase64||''),{maxIterations,width:b.width,height:b.height,model:b.model,max_tokens:b.max_tokens});
        // The autonomous loop has already made its AI calls; charge only for successful repair calls.
        const aiCalls=result.history.filter(h=>h.iteration<result.iterations && !h.pass).length;
        if(aiCalls>0){
          const c=creditFor(x.id); const charge=Math.min(c.balance,aiCalls); c.balance-=charge; c.used+=charge; saveDB(); result.credits=c;
        } else result.credits=creditFor(x.id);
        return json(res,200,result);
      }catch(e){return json(res,422,{error:'Autonomous repair failed: '+e.message,credits:creditFor(x.id)});}
    }
    if(req.method==='POST'&&p==='/api/qa'){
      const x=requireUser(req,res);if(!x)return; const b=await readBody(req),html=String(b.html||''); const issues=htmlChecks(html); let render=null,renderError=null;
      try{render=await runChromiumScreenshot(html,Number(b.width)||1440,Number(b.height)||900);}catch(e){renderError=e.message;issues.push({level:'warn',text:'Browser render unavailable: '+e.message});}
      let visual=null; if(render && b.referencePngBase64){ try{ visual=await comparePngs(String(b.referencePngBase64),render.pngBase64); }catch(e){ issues.push({level:'warn',text:'Visual comparison unavailable: '+e.message}); } }
      const score=Math.max(0,100-issues.reduce((a,i)=>a+(i.level==='error'?25:10),0));
      return json(res,200,{ok:score>=90,score,issues,runtime:{ok:!issues.some(i=>i.level==='error')},visual:{ok:!!render,score:visual?.score??null,matchPercent:visual?.matchPercent??null},responsive:{ok:!issues.some(i=>/Responsive/.test(i.text))},security:{ok:!issues.some(i=>i.level==='error')},render:render?{pngBase64:render.pngBase64,width:render.width,height:render.height,consoleErrors:[],pageErrors:[]}:{consoleErrors:renderError?[renderError]:[],pageErrors:[]},pngBase64:render?.pngBase64||null});
    }
    if(req.method==='POST'&&p==='/api/visual/compare'){
      const x=requireUser(req,res);if(!x)return; const b=await readBody(req); if(!b.referencePngBase64||!b.actualPngBase64)return json(res,400,{error:'referencePngBase64 and actualPngBase64 required'});
      try{return json(res,200,await comparePngs(String(b.referencePngBase64),String(b.actualPngBase64)));}catch(e){return json(res,422,{error:'Visual comparison failed: '+e.message});}
    }
    if(req.method==='GET'&&p==='/api/projects'){const x=requireUser(req,res);if(!x)return;return json(res,200,{projects:db.projects.filter(z=>z.userId===x.id).map(({data,...meta})=>meta)});}
    if(req.method==='POST'&&p==='/api/projects'){const x=requireUser(req,res);if(!x)return;const b=await readBody(req);const pr={id:id('prj'),userId:x.id,name:String(b.name||'Untitled'),framework:b.framework||'html-tailwind',html:String(b.html||''),files:b.files||{},referenceImage:b.referenceImage||'',updatedAt:new Date().toISOString(),createdAt:new Date().toISOString()};db.projects.push(pr);saveDB();return json(res,200,{project:pr});}
    const pm=p.match(/^\/api\/projects\/([^/]+)$/);if(req.method==='GET'&&pm){const x=requireUser(req,res);if(!x)return;const pr=db.projects.find(z=>z.id===pm[1]&&z.userId===x.id);if(!pr)return json(res,404,{error:'Project not found'});return json(res,200,{project:pr});}
    if(req.method==='DELETE'&&pm){const x=requireUser(req,res);if(!x)return;db.projects=db.projects.filter(z=>!(z.id===pm[1]&&z.userId===x.id));db.versions=db.versions.filter(z=>z.projectId!==pm[1]);saveDB();return json(res,200,{ok:true});}
    const vm=p.match(/^\/api\/projects\/([^/]+)\/versions$/);if(vm){const x=requireUser(req,res);if(!x)return;const pr=db.projects.find(z=>z.id===vm[1]&&z.userId===x.id);if(!pr)return json(res,404,{error:'Project not found'});if(req.method==='GET')return json(res,200,{versions:db.versions.filter(v=>v.projectId===pr.id).sort((a,b)=>b.createdAt.localeCompare(a.createdAt))});if(req.method==='POST'){const b=await readBody(req);const v={id:id('ver'),projectId:pr.id,userId:x.id,html:String(b.html||''),files:b.files||{},framework:b.framework||pr.framework,createdAt:new Date().toISOString()};db.versions.push(v);pr.html=v.html;pr.files=v.files;pr.updatedAt=v.createdAt;saveDB();return json(res,200,{version:v});}}
    if(req.method==='POST'&&p==='/api/connectors/url-import'){const x=requireUser(req,res);if(!x)return;const b=await readBody(req);if(!/^https:\/\//i.test(String(b.url||'')))return json(res,400,{error:'Only HTTPS URL import is allowed'});const r=await fetch(b.url,{redirect:'follow'});if(!r.ok)return json(res,502,{error:`Remote HTTP ${r.status}`});const html=(await r.text()).slice(0,1200000);return json(res,200,{html,url:r.url});}
    if(req.method==='POST'&&p==='/api/video/analyze'){const x=requireUser(req,res);if(!x)return;const b=await readBody(req);if(!b.videoBase64)return json(res,400,{error:'videoBase64 required'});try{return json(res,200,await analyzeVideoFrames(String(b.videoBase64),b.sampleCount));}catch(e){return json(res,422,{error:'Video analysis failed: '+e.message});}}
    if(req.method==='POST'&&p==='/api/connectors/github'){const x=requireUser(req,res);if(!x)return;const b=await readBody(req);if(!b.token||!b.owner||!b.repo)return json(res,400,{error:'GitHub token, owner and repo required'});const headers={'Authorization':`Bearer ${b.token}`,'Accept':'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28','User-Agent':'SnapToDesign-V9.6'};for(const f of (b.files||[])){const content=Buffer.from(String(f.content||'')).toString('base64');const q=new URL(`https://api.github.com/repos/${encodeURIComponent(b.owner)}/${encodeURIComponent(b.repo)}/contents/${String(b.pathPrefix||'').replace(/^\/+|\/+$/g,'')+(b.pathPrefix?'/':'')+f.name}`);let sha;const old=await fetch(q,{headers});if(old.ok){const od=await old.json();sha=od.sha;}const body={message:b.message||'SnapToDesign export',content};if(sha)body.sha=sha;const put=await fetch(q,{method:'PUT',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify(body)});if(!put.ok){const d=await put.json().catch(()=>({}));return json(res,502,{error:d.message||`GitHub HTTP ${put.status}`});}}return json(res,200,{ok:true,files:(b.files||[]).length});}
    return json(res,404,{error:'Route not found'});
  }catch(e){return json(res,500,{error:e.message||'Server error'});}
}
const server=http.createServer((req,res)=>route(req,res));server.listen(PORT,HOST,()=>console.log(`SnapToDesign backend listening on http://${HOST}:${PORT}`));
