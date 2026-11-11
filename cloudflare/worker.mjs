// tshelf.mirador.cc — Cloudflare-native ThreadShelf adapter, v0.1
// The upstream Node+LanceDB app is unchanged. This is an opt-in edge runtime.
import { parseChats } from './core.mjs';
import { HTML } from './ui.mjs';

const HOST='tshelf.mirador.cc';
const EMBEDDING_MODEL='@cf/baai/bge-m3';
const LIMIT=1400000;
function reply(body,status=200,headers={}) {
  return new Response(JSON.stringify(body),{status,headers:{
    'content-type':'application/json; charset=utf-8',
    'cache-control':'no-store',
    'x-content-type-options':'nosniff',
    ...headers
  }});
}
async function digest(value) {
  const bytes=new TextEncoder().encode(value);
  const hash=new Uint8Array(await crypto.subtle.digest('SHA-256',bytes));
  return [...hash].map(x=>x.toString(16).padStart(2,'0')).join('').slice(0,32);
}
function messageResults(rows) {return rows?.results||[]}
async function counts(db) {
  const [t,m,i]=await Promise.all([
    db.prepare('SELECT count(*) AS n FROM threads').first(),
    db.prepare('SELECT count(*) AS n FROM messages').first(),
    db.prepare('SELECT count(*) AS n FROM messages WHERE indexed=1').first()
  ]);
  const threads=Number(t?.n||0),messages=Number(m?.n||0),indexed=Number(i?.n||0);
  return {threads,messages,indexed,pending:messages-indexed};
}
async function doImport(req,env) {
  const declared=Number(req.headers.get('content-length')||0);
  if(declared>LIMIT*2)return reply({error:'JSON exceeds request limit'},413);
  const raw=await req.text();
  if(raw.length>LIMIT*2)return reply({error:'JSON too large'},413);
  let payload;try{payload=JSON.parse(raw)}catch{return reply({error:'Invalid JSON request'},400)}
  if(!payload||typeof payload!=='object'||!payload.data)return reply({error:'Missing data'},400);
  const filename=String(payload.filename||'export.json').replace(/[^\w. -]/g,'_').slice(0,120);
  const original=JSON.stringify(payload.data);
  if(original.length>LIMIT)return reply({error:'Export exceeds 1.4 MB import limit; split it into smaller JSON files'},413);
  let parsed;try{parsed=parseChats(payload.data,filename)}catch(e){return reply({error:String(e.message||e)},422)}
  const total=parsed.reduce((n,c)=>n+c.messages.length,0);
  if(parsed.length>100||total>250)return reply({error:'This first release imports up to 100 conversations and 250 messages per request; split the export'},413);
  const archiveId=await digest(original);
  const known=await env.DB.prepare('SELECT id FROM archives WHERE id=?').bind(archiveId).first();
  if(known)return reply({ok:true,duplicate:true,threads:0,messages:0,archiveId});
  await env.ORIGINALS.put('imports/'+archiveId+'.json',original,{httpMetadata:{contentType:'application/json'},customMetadata:{filename}});
  const now=new Date().toISOString();
  await env.DB.prepare('INSERT INTO archives (id,filename,created_at,bytes) VALUES (?,?,?,?)').bind(archiveId,filename,now,original.length).run();
  let written=0;
  for(const c of parsed){
    const id=await digest(archiveId+':'+c.sourceId);
    await env.DB.prepare('INSERT OR REPLACE INTO threads(id,archive_id,provider,title,message_count,created_at) VALUES (?,?,?,?,?,?)').bind(id,archiveId,c.provider,c.title,c.messages.length,c.createdAt||now).run();
    let stmts=[];
    for(const m of c.messages){
      const mid=await digest(id+':'+m.originalId);
      const parent=m.parentId===null?null:await digest(id+':'+m.parentId);
      stmts.push(env.DB.prepare('INSERT OR REPLACE INTO messages(id,thread_id,original_id,parent_id,role,model,created_at,content,indexed) VALUES (?,?,?,?,?,?,?,?,0)')
        .bind(mid,id,m.originalId,parent,m.role,m.model||'',m.createdAt||'',m.text));
      if(stmts.length>=35){await env.DB.batch(stmts);stmts=[]}
      written++;
    }
    if(stmts.length)await env.DB.batch(stmts);
  }
  return reply({ok:true,duplicate:false,threads:parsed.length,messages:written,archiveId});
}
async function indexMore(env){
  const rows=messageResults(await env.DB.prepare('SELECT id,thread_id,role,content FROM messages WHERE indexed=0 ORDER BY rowid LIMIT 8').all());
  if(!rows.length)return reply({indexed:0,pending:0});
  let data;
  try{
    const res=await env.AI.run(EMBEDDING_MODEL,{text:rows.map(x=>x.content.slice(0,1800))});
    data=res.data||res.result?.data;
  }catch(e){return reply({error:'Workers AI unavailable: '+String(e.message||e)},503)}
  if(!Array.isArray(data)||data.length!==rows.length||!data.every(x=>Array.isArray(x)&&x.length===1024))return reply({error:'Embedding model returned unexpected vector dimensions'},502);
  const vectors=rows.map((x,i)=>({id:x.id,values:data[i],metadata:{thread_id:x.thread_id,role:x.role}}));
  try{await env.VECTOR.upsert(vectors)}catch(e){return reply({error:'Vectorize indexing failed: '+String(e.message||e)},503)}
  await env.DB.batch(rows.map(x=>env.DB.prepare('UPDATE messages SET indexed=1 WHERE id=?').bind(x.id)));
  const pending=await env.DB.prepare('SELECT count(*) AS n FROM messages WHERE indexed=0').first();
  return reply({indexed:rows.length,pending:Number(pending?.n||0),model:EMBEDDING_MODEL});
}
async function doSearch(url,env){
  const q=String(url.searchParams.get('q')||'').trim().slice(0,1000);
  if(!q)return reply({error:'Empty query'},400);
  const mode=url.searchParams.get('mode')==='keyword'?'keyword':'semantic';
  const n=Math.max(1,Math.min(20,Number(url.searchParams.get('n')||12)||12));
  if(mode==='keyword'){
    const rs=await env.DB.prepare('SELECT m.id,m.thread_id,m.role,m.content,t.title,t.provider FROM messages m JOIN threads t ON t.id=m.thread_id WHERE instr(lower(m.content),lower(?))>0 ORDER BY m.rowid DESC LIMIT ?').bind(q,n).all();
    return reply({mode,results:messageResults(rs)});
  }
  try{
    const vecResult=await env.AI.run(EMBEDDING_MODEL,{text:[q]});
    const vector=(vecResult.data||vecResult.result?.data)?.[0];
    if(!Array.isArray(vector)||vector.length!==1024)throw Error('Embedding dimensions mismatch');
    const found=await env.VECTOR.query(vector,{topK:n,returnMetadata:true});
    const ids=(found.matches||[]).map(x=>x.id);
    if(!ids.length)return reply({mode,results:[],note:'Векторы ещё не найдены. Импортируйте и проиндексируйте сообщения.'});
    const placeholders=ids.map(()=>'?').join(',');
    const rs=await env.DB.prepare('SELECT m.id,m.thread_id,m.role,m.content,t.title,t.provider FROM messages m JOIN threads t ON t.id=m.thread_id WHERE m.id IN ('+placeholders+')').bind(...ids).all();
    const byId=new Map(messageResults(rs).map(x=>[x.id,x]));
    const results=(found.matches||[]).map(v=>byId.get(v.id)?{...byId.get(v.id),score:v.score}:null).filter(Boolean);
    return reply({mode,results});
  }catch(e){return reply({error:'Semantic search temporarily unavailable: '+String(e.message||e),hint:'Try exact text search'},503)}
}
async function doThread(url,env){
  const id=String(url.searchParams.get('id')||'');
  if(!/^[0-9a-f]{32}$/.test(id))return reply({error:'Invalid id'},400);
  const t=await env.DB.prepare('SELECT * FROM threads WHERE id=?').bind(id).first();
  if(!t)return reply({error:'Thread not found'},404);
  const messages=messageResults(await env.DB.prepare('SELECT id,original_id,parent_id,role,model,created_at,content FROM messages WHERE thread_id=? ORDER BY rowid').bind(id).all());
  return reply({thread:t,messages});
}
async function doArchive(url,env){
  const id=String(url.searchParams.get('id')||'');
  if(!/^[0-9a-f]{32}$/.test(id))return reply({error:'Invalid id'},400);
  const a=await env.DB.prepare('SELECT filename FROM archives WHERE id=?').bind(id).first();
  if(!a)return reply({error:'Archive not found'},404);
  const data=await env.ORIGINALS.get('imports/'+id+'.json');
  if(!data)return reply({error:'Original is missing'},404);
  const safe=String(a.filename||'archive.json').replace(/[^a-zA-Z0-9._-]/g,'_');
  return new Response(data.body,{headers:{
    'content-type':'application/json; charset=utf-8',
    'content-disposition':'attachment; filename="'+safe+'"',
    'cache-control':'no-store',
    'x-content-type-options':'nosniff'
  }});
}
export default {
  async fetch(request,env){
    const url=new URL(request.url);
    // No sensitive archive access via workers.dev or preview hostnames.
    if(url.hostname!==HOST)return new Response('Forbidden host',{status:403});
    if(request.method==='OPTIONS')return new Response(null,{status:405});
    const path=url.pathname;
    if(path==='/'||path==='/index.html')return new Response(HTML,{headers:{
      'content-type':'text/html; charset=utf-8',
      'cache-control':'no-store',
      'x-content-type-options':'nosniff',
      'referrer-policy':'same-origin',
      'content-security-policy':"default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
    }});
    if(!path.startsWith('/api/'))return new Response('Not found',{status:404});
    try{
      if(request.method==='POST'){
        if(request.headers.get('origin')!=='https://'+HOST)return reply({error:'Same-origin request required'},403);
        if(path==='/api/import')return await doImport(request,env);
        if(path==='/api/index')return await indexMore(env);
        return reply({error:'Not found'},404);
      }
      if(request.method!=='GET')return reply({error:'Method not allowed'},405);
      if(path==='/api/health')return reply({ok:true,service:'threadshelf-cloudflare',version:'0.1',provider:'Cloudflare'});
      if(path==='/api/stats')return reply(await counts(env.DB));
      if(path==='/api/threads'){
        const rs=await env.DB.prepare('SELECT id,archive_id,provider,title,message_count,created_at FROM threads ORDER BY created_at DESC LIMIT 100').all();
        return reply({threads:messageResults(rs)});
      }
      if(path==='/api/search')return await doSearch(url,env);
      if(path==='/api/thread')return await doThread(url,env);
      if(path==='/api/archive')return await doArchive(url,env);
      return reply({error:'Not found'},404);
    }catch(e){
      console.error('tshelf error',String(e?.message||e));
      return reply({error:'Request failed: '+String(e?.message||e)},500);
    }
  }
};
