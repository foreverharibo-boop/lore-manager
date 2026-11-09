const {test}=require('node:test');const assert=require('node:assert/strict');const vm=require('node:vm');const fs=require('node:fs');
test('backup lists load headers, while full export explicitly retains all restored payloads',async()=>{
 const source=fs.readFileSync(require('node:path').join(__dirname,'../index.js'),'utf8');
 const fn=source.slice(source.indexOf('async function listLorebookBackups('),source.indexOf('async function getLorebookBackup('));
 const records=[{id:'one',createdAt:1,lorebook:{entries:{0:{content:'original'}}},translations:['translated']},{id:'two',createdAt:2,lorebook:{entries:{}}}];
 let closed=0;const db={close(){closed++;},transaction:()=>({objectStore:()=>({openCursor(){const request={};let i=0;
 const next=()=>queueMicrotask(()=>{request.result=i<records.length?{value:records[i++],continue:next}:null;request.onsuccess();});next();return request;},getAll(){throw Error('bulk read forbidden');}})})};
 const ctx={openBackupDatabase:async()=>db,BACKUP_STORE_NAME:'backups',backupTransactionDone:async()=>{}};
 vm.runInNewContext(fn+'\nglobalThis.list=listLorebookBackups;',ctx);
 const headers=await ctx.list();assert.equal(headers.length,2);assert.equal(headers[0].id,'two');assert.equal(headers[1].lorebook,undefined);assert.equal(headers[1].translations,undefined);
 const full=await ctx.list(true);assert.equal(full[1].lorebook.entries[0].content,'original');assert.deepEqual(full[1].translations,['translated']);assert.equal(closed,2);
 assert.match(source,/listLorebookBackups\(true\)/);
});
