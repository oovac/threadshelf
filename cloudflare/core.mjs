// ThreadShelf Cloudflare adapter v0.1 — pure parser/chunker, testable in Node and Workers.
// Original provider parsers remain in src/parser.ts; this adapter preserves ChatGPT DAGs.
export function contentText(value) {
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value)) return value.map(contentText).filter(Boolean).join('\n\n');
  if (!value || typeof value !== 'object') return '';
  if (typeof value.text === 'string') return value.text.trim();
  if (Array.isArray(value.parts)) return value.parts.map(contentText).filter(Boolean).join('\n\n');
  if (typeof value.content === 'string') return value.content.trim();
  return '';
}
function stamp(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return new Date(v < 1e11 ? v * 1000 : v).toISOString();
  if (typeof v === 'string' && v) { const d = new Date(v); if (!Number.isNaN(d.getTime())) return d.toISOString(); }
  return '';
}
function roleName(r) {
  if (r === 'human' || r === 'user') return 'user';
  if (r === 'assistant' || r === 'ai') return 'assistant';
  return '';
}
export function chunkText(value,max=1800,overlap=100) {
  const text=String(value||'').trim();
  if(!text) return [];
  max=Math.max(200,Math.floor(max)||1800);
  overlap=Math.min(max-1,Math.max(0,Math.floor(overlap)||0));
  const out=[];
  for(let s=0;s<text.length;) {
    const end=Math.min(text.length,s+max);
    out.push(text.slice(s,end));
    if(end===text.length) break;
    s=end-overlap;
  }
  return out;
}
function chatgpt(c,i) {
  const messages=[];
  for(const [key,node] of Object.entries(c.mapping||{})) {
    const msg=node?.message;
    const role=roleName(msg?.author?.role);
    const text=contentText(msg?.content);
    if(!role||!text) continue;
    messages.push({
      originalId:String(node?.id||key),
      parentId:node?.parent==null?null:String(node.parent),
      role, text, model:String(msg?.metadata?.model_slug||msg?.model_slug||c.default_model_slug||''),
      createdAt:stamp(msg?.create_time)||stamp(c.create_time)
    });
  }
  return {sourceId:String(c.id||c.conversation_id||'chatgpt-'+i),provider:'chatgpt',
    title:String(c.title||'ChatGPT conversation').slice(0,300),createdAt:stamp(c.create_time),
    messages};
}
function claude(c,i) {
  const messages=[];let parent=null;
  for(const [j,m] of (c.chat_messages||[]).entries()){
    const role=roleName(m.sender||m.role), text=contentText(m.text||m.content);
    if(!role||!text)continue;
    const id=String(m.uuid||m.id||j);
    messages.push({originalId:id,parentId:parent,role,text,
      model:String(m.model||''),createdAt:stamp(m.created_at||m.createdAt)});
    parent=id;
  }
  return {sourceId:String(c.uuid||c.id||'claude-'+i),provider:'claude',
    title:String(c.name||c.title||'Claude conversation').slice(0,300),
    createdAt:stamp(c.created_at||c.createdAt),messages};
}
function linear(c,i,platform='openrouter'){
  const messages=[];let parent=null;
  for(const [j,m] of (c.turns||c.messages||[]).entries()){
    const role=roleName(m.role||m.sender),text=contentText(m.content||m.text||m.message);
    if(!role||!text)continue;
    const id=String(m.id||j);
    messages.push({originalId:id,parentId:parent,role,text,model:String(m.model||''),createdAt:stamp(m.createdAt||m.created_at)});
    parent=id;
  }
  return {sourceId:String(c.id||c.conversationId||'linear-'+i),provider:platform,
    title:String(c.pageTitle||c.title||'AI conversation').slice(0,300),
    createdAt:stamp(c.created_at||c.createdAt),messages};
}
export function parseChats(data,fileName='export.json') {
  if (typeof data==='string') { try{data=JSON.parse(data);}catch{throw new Error('Invalid JSON export');} }
  const list=Array.isArray(data)?data:Array.isArray(data?.conversations)?data.conversations:[data];
  const result=[];
  for(const [i,c] of list.entries()) {
    if(!c||typeof c!=='object')continue;
    let value;
    if(c.mapping&&typeof c.mapping==='object') value=chatgpt(c,i);
    else if(Array.isArray(c.chat_messages))value=claude(c,i);
    else if(Array.isArray(c.turns)||Array.isArray(c.messages))value=linear(c,i,c.platform||'openrouter');
    else continue;
    if(value.messages.length)result.push(value);
  }
  if(!result.length)throw new Error('No supported conversations found in '+String(fileName).slice(0,90));
  return result;
}
