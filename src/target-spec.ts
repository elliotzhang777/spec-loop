import { lstat, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export type TargetSpecAssetKind = 'document' | 'template';

export interface TargetSpecAsset {
  path: string;
  role: string;
  kind: TargetSpecAssetKind;
  check_placeholders: boolean;
  content: string;
}

export interface TargetSpecTemplate {
  schema_version: 1;
  template_version: string;
  assets: TargetSpecAsset[];
}

interface TargetSpecManifest {
  schema_version: number;
  template_version: string;
  files: Array<{path:string;role:string;kind:string;check_placeholders:boolean}>;
}

const rolePaths = new Map([
  ['guide','README.md'],
  ['roadmap','roadmap.md'],
  ['architecture','architecture.md'],
  ['pending-board','pending-board.md'],
  ['verification-board','verification-board.md'],
  ['product-template','01-product/_template.md'],
  ['feature-template','02-feature/_template.md'],
  ['design-template','03-design/_template.md'],
  ['task-template','04-task/_template.md'],
]);

export const defaultTargetSpecAssetRoot = fileURLToPath(new URL('../assets/target-spec/v1/', import.meta.url));

function assertManifest(value:unknown): asserts value is TargetSpecManifest {
  if(!value||typeof value!=='object')throw new Error('invalid target spec manifest');
  const manifest=value as Partial<TargetSpecManifest>;
  if(manifest.schema_version!==1||typeof manifest.template_version!=='string'||!/^\d+\.\d+\.\d+$/.test(manifest.template_version)||!Array.isArray(manifest.files))throw new Error('invalid target spec manifest');
  const seenPaths=new Set<string>(),seenRoles=new Set<string>();
  for(const item of manifest.files){
    if(!item||typeof item.path!=='string'||typeof item.role!=='string'||!['document','template'].includes(item.kind)||typeof item.check_placeholders!=='boolean')throw new Error('invalid target spec manifest entry');
    if(path.isAbsolute(item.path)||item.path!==path.posix.normalize(item.path)||item.path.startsWith('../')||item.path.includes('\\'))throw new Error(`unsafe target spec asset path: ${item.path}`);
    if(seenPaths.has(item.path)||seenRoles.has(item.role))throw new Error('duplicate target spec asset path or role');
    seenPaths.add(item.path);seenRoles.add(item.role);
  }
  if(manifest.files.length!==rolePaths.size)throw new Error('target spec manifest has an unexpected asset count');
  for(const [role,expectedPath] of rolePaths){
    const item=manifest.files.find(x=>x.role===role);
    if(!item||item.path!==expectedPath)throw new Error(`target spec manifest missing required role: ${role}`);
    if((role.endsWith('-template'))!==(item.kind==='template'))throw new Error(`target spec manifest has invalid kind for role: ${role}`);
    if(item.kind==='template'&&item.check_placeholders)throw new Error(`target spec template may not enable placeholder checks: ${item.path}`);
  }
}

export async function loadTargetSpecTemplate(assetRoot=defaultTargetSpecAssetRoot):Promise<TargetSpecTemplate>{
  const root=path.resolve(assetRoot),manifestFile=path.join(root,'manifest.json');
  const manifestInfo=await lstat(manifestFile).catch(()=>null);
  if(!manifestInfo||!manifestInfo.isFile()||manifestInfo.isSymbolicLink())throw new Error(`target spec manifest is missing or invalid: ${manifestFile}`);
  let parsed:unknown;
  try{parsed=JSON.parse(await readFile(manifestFile,'utf8'))}catch(cause){throw new Error(`cannot read target spec manifest: ${manifestFile}`,{cause})}
  assertManifest(parsed);
  const assets:TargetSpecAsset[]=[];
  for(const item of parsed.files){
    const file=path.resolve(root,item.path);
    if(!file.startsWith(root+path.sep))throw new Error(`target spec asset escapes resource root: ${item.path}`);
    const info=await lstat(file).catch(()=>null);
    if(!info||!info.isFile()||info.isSymbolicLink())throw new Error(`target spec asset is missing or invalid: ${item.path}`);
    const content=await readFile(file,'utf8');
    if(content.trim().length<20)throw new Error(`target spec asset is empty: ${item.path}`);
    assets.push({...item,kind:item.kind as TargetSpecAssetKind,content});
  }
  return {schema_version:1,template_version:parsed.template_version,assets};
}

const placeholderToken=/^(?:tbd|todo|unknown|placeholder|fill me|lorem ipsum|待填写|待补充|未知|<[^>\r\n]+>|\{\{[^}\r\n]+\}\})[。.;；]?$/i;

function isPlaceholderToken(value:string):boolean{
  return placeholderToken.test(value.trim().replace(/^`|`$/g,''));
}

/** Detect unresolved values, while allowing prose and code that discuss placeholder terms. */
export function containsRealPlaceholder(markdown:string):boolean{
  let fenced=false;
  for(const rawLine of markdown.split(/\r?\n/)){
    const trimmed=rawLine.trim();
    if(/^(```|~~~)/.test(trimmed)){fenced=!fenced;continue}
    if(fenced||!trimmed||/^<!--.*-->$/.test(trimmed))continue;
    if(trimmed.startsWith('|')){
      const row=trimmed.endsWith('|')?trimmed.slice(1,-1):trimmed.slice(1);
      const cells=row.split('|');
      if(cells.some(isPlaceholderToken))return true;
      continue;
    }
    let value=trimmed.replace(/^#{1,6}\s+/,'').replace(/^(?:[-*+] |\d+[.)]\s+)/,'').replace(/^\[[ xX]\]\s+/,'');
    const separator=Math.max(value.lastIndexOf('：'),value.lastIndexOf(':'));
    if(separator>=0)value=value.slice(separator+1).trim();
    if(isPlaceholderToken(value))return true;
  }
  return false;
}
