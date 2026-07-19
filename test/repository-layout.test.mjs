import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { access, readFile, readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

const root=process.cwd();

async function markdownFiles(dir){
  const files=[];
  for(const entry of await readdir(dir,{withFileTypes:true})){
    const file=path.join(dir,entry.name);
    if(entry.isDirectory())files.push(...await markdownFiles(file));
    else if(entry.isFile()&&entry.name.endsWith('.md'))files.push(file);
  }
  return files;
}

test('versioned repository root contains only current engineering responsibilities',()=>{
  const result=spawnSync('git',['-c','core.quotePath=false','ls-files'],{cwd:root,encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);
  const entries=new Set(result.stdout.trim().split(/\r?\n/).filter(Boolean).map(file=>file.split('/')[0]));
  assert.deepEqual([...entries].sort(),[
    '.gitignore','AGENT.md','README.md','assets','package-lock.json','package.json','spec','src','test','tsconfig.json',
  ]);
  assert.equal(entries.has('artifacts'),false);
  assert.equal(entries.has('dogfood'),false);
});

test('current documentation local links resolve after delivery archive moves',async()=>{
  const files=[path.join(root,'README.md'),...await markdownFiles(path.join(root,'spec'))]
    .filter(file=>path.basename(file)!=='_template.md'&&!file.includes(`${path.sep}dogfood${path.sep}`)&&!file.includes(`${path.sep}evidence${path.sep}`));
  const broken=[];
  for(const file of files){
    const markdown=await readFile(file,'utf8');
    for(const match of markdown.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)){
      const raw=match[1].trim().replace(/^<|>$/g,'');
      if(!raw||/^(?:https?:|mailto:|#)/.test(raw))continue;
      const target=decodeURI(raw.split('#')[0]);
      try{await access(path.resolve(path.dirname(file),target))}catch{broken.push(`${path.relative(root,file)} -> ${raw}`)}
    }
  }
  assert.deepEqual(broken,[]);
});
