import test from 'node:test';
import assert from 'node:assert/strict';
import { parseChats, chunkText } from '../cloudflare/core.mjs';

test('ChatGPT importer preserves every DAG branch rather than selected current_node only', () => {
 const data=[{id:'c1',title:'Branches',current_node:'a',mapping:{
   root:{id:'root',parent:null,message:null},
   u:{id:'u',parent:'root',message:{author:{role:'user'},content:{parts:['Hello']}}},
   a:{id:'a',parent:'u',message:{author:{role:'assistant'},content:{parts:['First reply']}}},
   b:{id:'b',parent:'u',message:{author:{role:'assistant'},content:{parts:['Alternative']}}}
 }}];
 const [chat]=parseChats(data,'conversations.json');
 assert.equal(chat.provider,'chatgpt');
 assert.equal(chat.messages.length,3);
 assert.deepEqual(new Set(chat.messages.map(x=>x.originalId)),new Set(['u','a','b']));
 assert.equal(chat.messages.find(x=>x.originalId==='b').parentId,'u');
});
test('Claude importer maps sender and text into messages',()=>{
 const [chat]=parseChats([{uuid:'abc',name:'Topic',chat_messages:[
  {uuid:'m1',sender:'human',text:'Question'},
  {uuid:'m2',sender:'assistant',text:'Answer'}
 ]}],'claude.json');
 assert.equal(chat.provider,'claude');assert.equal(chat.messages.length,2);
 assert.equal(chat.messages[0].role,'user');assert.equal(chat.messages[1].text,'Answer');
});
test('OpenRouter turns import with stable parent sequence',()=>{
 const [chat]=parseChats({platform:'openrouter',pageTitle:'Test',turns:[
  {role:'user',content:'Hi'},{role:'assistant',content:'Hello'}
 ]},'or.json');
 assert.equal(chat.messages[1].parentId,chat.messages[0].originalId);
});
test('unsafe and empty non-text content cannot become messages',()=>{
 const [chat]=parseChats([{id:'x',mapping:{
 a:{parent:null,message:{author:{role:'tool'},content:{parts:['tool output']}}},
 b:{parent:'a',message:{author:{role:'user'},content:{parts:[{asset_pointer:'image'}]}}},
 c:{parent:'b',message:{author:{role:'assistant'},content:{parts:['Ok']}}}
 }}],'f.json');
 assert.equal(chat.messages.length,1);assert.equal(chat.messages[0].text,'Ok');
});
test('chunkText is bounded and reconstructs short text unchanged',()=>{
 assert.deepEqual(chunkText('Hello',300),['Hello']);
 const chunks=chunkText('a'.repeat(1700),700,50);
 assert.equal(chunks.length,3);
 assert.ok(chunks.every(x=>x.length<=700));
});
