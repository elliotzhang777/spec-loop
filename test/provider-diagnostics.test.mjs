import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { providerDoctor } from '../dist/project.js'
import { tempRoot, writeMd } from './helpers.mjs'

test('runtime diagnostics coalesce and invalidate on executable or argument changes; explicit doctor stays fresh', async t => {
  const root=await tempRoot('provider-diagnostics-'),executable=path.join(root,'codex'),count=path.join(root,'diagnostics.txt'),broken=path.join(root,'broken')
  t.after(()=>rm(root,{recursive:true,force:true}))
  const script=version=>`#!/bin/sh
printf 'call\n' >> '${count}'
if [ -f '${broken}' ]; then exit 9; fi
for arg in "$@"; do
  if [ "$arg" = "--unsupported" ]; then exit 8; fi
  if [ "$arg" = "--version" ]; then echo '${version}'; exit 0; fi
done
echo help
`
  await writeFile(executable,script('version-one'));await chmod(executable,0o755)
  const definition={enabled:true,executable,args:[],timeout_seconds:30}
  const configure=args=>writeMd(path.join(root,'.spec-loop','PROVIDERS.md'),{
    schema_version:1,active_provider:'codex',providers:{codex:{...definition,args},'claude-code':{...definition,executable:'/missing/claude'},qoder:{...definition,executable:'/missing/qoder'}},
  },'# Provider fixture')
  await mkdir(path.join(root,'.spec-loop'))
  await configure([])
  const runtime=()=>providerDoctor(root,{provider:'codex',reuse:true})
  const calls=async()=>(await readFile(count,'utf8')).trim().split('\n').length
  const simultaneous=await Promise.all([runtime(),runtime(),runtime()])
  assert.ok(simultaneous.every(rows=>rows.length===1&&rows[0].compatible))
  assert.equal(await calls(),2,'one version/help pair for concurrent preparations')
  await runtime();assert.equal(await calls(),2)
  await providerDoctor(root,{provider:'codex'});assert.equal(await calls(),4,'explicit doctor probes afresh')
  await writeFile(executable,script('version-two'))
  assert.equal((await runtime())[0].version,'version-two');assert.equal(await calls(),6)
  await configure(['--unsupported']);assert.equal((await runtime())[0].compatible,false);assert.equal(await calls(),8)
  await runtime();assert.equal(await calls(),10,'failed diagnostics are never reused')
  await configure([]);await writeFile(broken,'failure')
  assert.equal((await providerDoctor(root,{provider:'codex'}))[0].compatible,false)
  await rm(broken);assert.equal((await runtime())[0].compatible,true)
  assert.equal(await calls(),14,'a fresh failed check invalidates the previous successful cache')
})
