const test = require('node:test'), assert = require('node:assert/strict');
const { startSandbox } = require('./runtime.cjs');
const { zipSync, strToU8 } = require('../node_modules/fflate');
const XLSX = require('../node_modules/xlsx');

test('Professional attachment formats and failures traverse actual API preparation for every role', async t => {
  const s = await startSandbox({ port: 4347 }), uid = s.config.userId;
  const model = s.load('services/ai/geminiClient.js'), marker = 'SOURCEQA7304';
  const workbook = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['name','amount'],[marker,73.04]]), 'Brief');
  const zipped = (name, content) => Buffer.from(zipSync({ [name]: strToU8(content) })).toString('base64');
  const fixtures = [
    ['brief.txt','text/plain',Buffer.from(marker + ' supports offline retry.').toString('base64'),marker],
    ['brief.json','application/json',Buffer.from(JSON.stringify({ requirement: marker })).toString('base64'),marker],
    ['brief.csv','text/csv',Buffer.from('name,amount\n'+marker+',73.04').toString('base64'),marker],
    ['brief.xlsx','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',XLSX.write(workbook,{type:'base64',bookType:'xlsx'}),marker],
    ['brief.docx','application/vnd.openxmlformats-officedocument.wordprocessingml.document',zipped('word/document.xml','<w:document><w:body><w:p><w:r><w:t>'+marker+'</w:t></w:r></w:p></w:body></w:document>'),marker],
    ['brief.pptx','application/vnd.openxmlformats-officedocument.presentationml.presentation',zipped('ppt/slides/slide1.xml','<p:sld><a:p><a:r><a:t>'+marker+'</a:t></a:r></a:p></p:sld>'),marker],
    ['brief.odt','application/vnd.oasis.opendocument.text',zipped('content.xml','<office:document><text:p>'+marker+'</text:p></office:document>'),marker],
    ['brief.epub','application/epub+zip',zipped('book/chapter1.xhtml','<html><body><p>'+marker+'</p></body></html>'),marker],
    ['brief.pdf','application/pdf',Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\n%%EOF').toString('base64'),'application/pdf'],
    ['brief.png','image/png','iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aG1kAAAAASUVORK5CYII=','image/png'],
  ];
  const invalid = [
    ['invalid.txt','text/plain','@@@'],
    ['empty.txt','text/plain',''],
    ['binary.txt','text/plain',Buffer.from([255,254,0,0,255]).toString('base64')],
    ['unknown.exe','application/octet-stream',Buffer.from('MZ unsupported').toString('base64')],
    ['broken.docx','application/octet-stream',Buffer.from('not an archive').toString('base64')],
    ['oversized.txt','text/plain',Buffer.alloc(3*1024*1024+1,65).toString('base64')],
  ];
  let calls = 0;
  const api = async (body, expected = 200, token = s.config.token) => {
    const r = await fetch(s.config.base+'/api/v1/accountant/assistant/command',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify(body)});
    const data = await r.json(); assert.equal(r.status,expected,JSON.stringify(data));return data;
  };
  try {
    for (const persona of ['finance','sales','hr','customer_support','real_estate','product_manager']) {
      await s.db.query("UPDATE profession_profiles SET persona=$2 WHERE user_id=$1 AND mode='professional'",[uid,persona]);
      for (const [name,mimeType,data,evidence] of fixtures) await t.test(persona+': '+name+' reaches the model with actual prepared evidence',async()=>{
        calls=0; model.isGeminiLive=()=>true;
        model.geminiGenerateContent=async options=>{calls++;assert.equal(options.toolMode,'ANY');assert(JSON.stringify(options.contents).includes(evidence));assert(options.system.includes('UNTRUSTED DATA'));return{raw:'',functionCall:{name:'complete_professional_task',args:{answer:'Analysis of the supplied fixture evidence only.'}},model:'fixture',latencyMs:1}};
        const plan=await api({message:'Analyze this attachment using only its evidence. Do not save or send anything.',attachmentBase64:data,attachmentMimeType:mimeType,attachmentName:name});
        assert.equal(plan.action,null);assert.equal(plan.task,undefined);assert.equal(calls,1);
      });
      for(const [name,mimeType,data]of invalid) await t.test(persona+': '+name+' rejects unreadable input before planning or writing',async()=>{
        calls=0;const plan=await api({message:'Analyze the attachment.',attachmentBase64:data,attachmentMimeType:mimeType,attachmentName:name},400);assert(plan.error);assert.equal(calls,0);
      });
      await t.test(persona+': a missing file asks for the file without inventing contents',async()=>{
        calls=0;const plan=await api({message:'Summarize the attached document.'});assert.equal(plan.action,null);assert.match(plan.answer,/don't see an attachment|nothing came through/i);assert.equal(calls,0);
      });
    }
    await t.test('malformed conversation/message inputs never enter the model',async()=>{
      for(const body of [{message:''},{message:'x'.repeat(12001)},{message:'Hello',conversationId:'not-a-uuid'}]){calls=0;await api(body,400);assert.equal(calls,0)}
      calls=0;await api({message:'Hello'},401,'invalid');assert.equal(calls,0);
    });
  } finally { await s.close(); }
});
