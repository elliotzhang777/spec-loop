import { createHash } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';

export type ProviderUsage = {input_tokens:number|null;cached_input_tokens:number|null;output_tokens:number|null;reasoning_tokens:number|null;total_tokens:number|null;cost_usd:number|null;recorded:boolean};
export const emptyProviderUsage=():ProviderUsage=>({input_tokens:null,cached_input_tokens:null,output_tokens:null,reasoning_tokens:null,total_tokens:null,cost_usd:null,recorded:false});
type UsageMode='cumulative'|'incremental';
const keys=['input_tokens','cached_input_tokens','output_tokens','reasoning_tokens','total_tokens','cost_usd'] as const;
const maxProviderLineBytes=1024*1024;
function usages(value:unknown,depth=0,parentId:string|null=null,location='root'):Array<{value:Record<string,unknown>;receiptId:string|null}> {
  if(depth>16||!value||typeof value!=='object')return[];
  const record=value as Record<string,unknown>,localId=typeof record.event_id==='string'?record.event_id:typeof record.id==='string'?record.id:null,id=localId??parentId;
  const own=record.usage&&typeof record.usage==='object'&&!Array.isArray(record.usage)?[{value:record.usage as Record<string,unknown>,receiptId:id?`${id}:${localId?'usage':location}`:null}]:[];
  return [...own,...Object.entries(record).filter(([key])=>key!=='usage').flatMap(([key,nested])=>usages(nested,depth+1,id,`${location}/${key}`))];
}
function normalized(value:unknown,depth=0):unknown {
  if(depth>12)return null;
  if(Array.isArray(value))return value.slice(0,100).map(item=>normalized(item,depth+1));
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([key])=>!/(?:^id$|_id$|timestamp|^time$|created_at|sequence|usage)/i.test(key)).map(([key,item])=>[key,normalized(item,depth+1)]));
  if(typeof value==='number')return '<number>';
  return typeof value==='string'?value.replace(/\b\d{4}-\d\d-\d\dT[^\s"]+/g,'<time>').replace(/\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/gi,'<id>').replace(/\b\d+(?:\.\d+)?\b/g,'#'):value;
}

// Parse each line exactly once, even across UTF-8/chunk boundaries. Captured
// output may be truncated independently without truncating usage accounting.
export function createProviderObservations(mode:UsageMode='cumulative') {
  const decoder=new StringDecoder('utf8'),seenProgress=new Set<string>(),seenUsage=new Map<string,string>();
  let pending='',discarding=false,usage=emptyProviderUsage(),invalid:string|null=null,sequence=0;
  const line=(text:string):boolean=>{
    text=text.trim();if(!text)return false;
    let parsed:unknown=null;try{parsed=JSON.parse(text);}catch{}
    const values=usages(parsed),event=parsed as Record<string,unknown>|null;
    for(const {value,receiptId:eventId} of values){
      const fields:Partial<ProviderUsage>={};
      for(const key of keys){const camel=key.replace(/_([a-z])/g,(_match,c:string)=>c.toUpperCase()),raw=value[key]??value[camel]??(key==='cost_usd'?value.cost:undefined);if(raw===undefined||raw===null)continue;if(typeof raw!=='number'||!Number.isFinite(raw)||raw<0||(key!=='cost_usd'&&!Number.isSafeInteger(raw))){invalid='invalid Provider usage value';continue;}fields[key]=raw;}
      if(mode==='incremental'&&fields.total_tokens===undefined&&(fields.input_tokens!==undefined||fields.output_tokens!==undefined))fields.total_tokens=(fields.input_tokens??0)+(fields.output_tokens??0);
      if(typeof fields.total_tokens==='number'&&typeof fields.input_tokens==='number'&&typeof fields.output_tokens==='number'&&fields.total_tokens<fields.input_tokens+fields.output_tokens)invalid='Provider total tokens contradict components';
      const receipt=JSON.stringify(fields);
      if(mode==='incremental'&&eventId){const previous=seenUsage.get(eventId);if(previous){if(previous!==receipt)invalid='Provider usage event changed after receipt';continue;}if(seenUsage.size>=4096){invalid='Provider usage receipt limit exceeded';continue;}seenUsage.set(eventId,receipt);}
      for(const key of keys){const next=fields[key];if(typeof next!=='number')continue;const previous=usage[key];if(mode==='cumulative'&&previous!==null&&next<previous)invalid='cumulative Provider usage moved backwards';const total=mode==='incremental'?(previous??0)+next:Math.max(previous??0,next);if(!Number.isFinite(total)||(key!=='cost_usd'&&!Number.isSafeInteger(total)))invalid='Provider usage overflow';else usage[key]=total;}
      if(mode==='cumulative'&&(usage.input_tokens!==null||usage.output_tokens!==null)){
        const components=(usage.input_tokens??0)+(usage.output_tokens??0);
        if(!Number.isSafeInteger(components))invalid='Provider usage overflow';
        else if(typeof fields.total_tokens==='number'&&fields.total_tokens<components)invalid='Provider total tokens contradict merged components';
        else usage.total_tokens=Math.max(usage.total_tokens??0,components);
      }
      usage.recorded=usage.total_tokens!==null&&!invalid;
    }
    const type=typeof event?.type==='string'?event.type:'';
    if(values.length||/^(?:status|metrics|telemetry)$/.test(type)||/heartbeat|keepalive|ping|usage|token_count|thread\.started|turn\.started|error|warning|retry/i.test(type)||/^(?:heartbeat|ping|keepalive|retry|warning|error)\b/i.test(text))return false;
    const stable=JSON.stringify(normalized(parsed??text));
    if(!stable||stable==='{}'||seenProgress.size>=4096)return false;
    const hash=createHash('sha256').update(stable).digest('hex');if(seenProgress.has(hash))return false;
    seenProgress.add(hash);sequence+=1;return true;
  };
  return {
    push(chunk:Buffer|string,stream:'stdout'|'stderr'='stdout') {
      if(stream==='stderr')return false; // Diagnostics alone never prove work.
      const text=typeof chunk==='string'?chunk:decoder.write(chunk);let progressed=false;
      for(const part of text.split(/(?<=\n)/)){
        if(!discarding)pending+=part;
        if(Buffer.byteLength(pending)>maxProviderLineBytes){invalid='Provider output line exceeds accounting limit';pending='';discarding=true;usage.recorded=false;}
        if(part.endsWith('\n')){if(!discarding)progressed=line(pending)||progressed;pending='';discarding=false;}
      }
      return progressed;
    },
    finish(){pending+=decoder.end();if(pending&&!discarding)line(pending);pending='';return {...usage,recorded:usage.recorded&&!invalid};},
    usage:()=>({...usage,recorded:usage.recorded&&!invalid}),
    error:()=>invalid,
    progressSequence:()=>sequence,
  };
}
